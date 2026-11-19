import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateReport, costForProduct, quoteFor } from '../lib/accounting.ts';
import type { BakeryRecord, DataByKind, RecordKind } from '../lib/types.ts';
import { testCatalogs } from './fixtures.ts';
const day = '2026-01-02';
function row<K extends RecordKind>(kind: K, id: string, data: DataByKind[K]): BakeryRecord<K> {
  return { id, kind, data, revision: 1, createdAt: day, updatedAt: day, createdBy: 'test', updatedBy: 'test', deletedAt: null } as BakeryRecord<K>;
}
const recipe = row('recipe', 'recipe', { productId: 'product', effectiveFrom: day, lines: [{ ingredientId: 'ingredient', quantity: 25, unit: 'g' }] });
const sale = row('sale', 'sale', { date: day, shop: 'Тест', lines: [{ productId: 'product', quantity: 10, unitPriceKopecks: 5678 }] });
test('keeps fractional material kopecks until multiplying sales', () => {
  const records = [...testCatalogs(), recipe, sale];
  assert.equal(costForProduct('product', day, records).unitCostKopecks, 31);
  assert.equal(calculateReport(records, day, day).materialCostKopecks, 309);
});
test('latest dated purchase wins without rewriting earlier dates', () => {
  const records = [...testCatalogs(), recipe, row('purchase', 'purchase', { date: '2026-01-03', ingredientId: 'ingredient', quantity: 2, unit: 'kg', unitPriceKopecks: 8000 })];
  assert.equal(quoteFor('ingredient', day, records).perBaseKopecks, 1.234);
  assert.equal(quoteFor('ingredient', '2026-01-03', records).perBaseKopecks, 8);
});
test('unknown recipes and incompatible dimensions leave profit incomplete', () => {
  assert.equal(calculateReport([...testCatalogs(), sale], day, day).profitKopecks, null);
  const incompatible = { ...recipe, data: { ...recipe.data, lines: [{ ingredientId: 'ingredient', quantity: 25, unit: 'ml' as const }] } };
  assert.equal(costForProduct('product', day, [...testCatalogs(), incompatible]).unitCostKopecks, null);
});
test('separates accruals, cash payments, purchases and owner contributions', () => {
  const report = calculateReport([...testCatalogs(), recipe, sale,
    row('shift', 'shift', { date: day, employeeId: 'employee', rateKopecks: 91011, bonusKopecks: 1000 }),
    row('wagePayment', 'payment', { date: day, employeeId: 'employee', amountKopecks: 10000 }),
    row('purchase', 'purchase', { date: day, ingredientId: 'ingredient', quantity: 2, unit: 'kg', unitPriceKopecks: 1234 }),
    row('expense', 'expense', { date: day, category: 'Тест', amountKopecks: 500 }),
    row('cashMovement', 'owner', { date: day, direction: 'in', owner: '', amountKopecks: 20000 }),
  ], day, day);
  assert.equal(report.profitKopecks, 56780 - 309 - 92011 - 500);
  assert.equal(report.cashDeltaKopecks, 56780 + 20000 - 10000 - 2468 - 500);
  assert.equal(report.owedWagesKopecks, 82011);
});
test('packages convert mass and volume while deleted purchases are ignored', () => {
  const purchase = row('purchase', 'purchase', { date: day, ingredientId: 'ingredient', quantity: 2, unit: 'pack', unitPriceKopecks: 10000, packQuantity: 5, packUnit: 'kg' });
  assert.equal(quoteFor('ingredient', day, [...testCatalogs(), purchase]).perBaseKopecks, 2);
  assert.equal(quoteFor('ingredient', day, [...testCatalogs(), { ...purchase, deletedAt: day }]).perBaseKopecks, 1.234);
});
