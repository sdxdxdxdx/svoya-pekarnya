import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateReport, costForProduct, quoteFor, purchaseTotal, saleTotal, salePayments, saleDebtKopecks } from '../lib/accounting.ts';
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

test('unpaid invoices accrue revenue while later dated collections affect cash and cutoff debt', () => {
  const unpaid = { ...sale, data: { ...sale.data, payments: [] } };
  const partial = { ...sale, id: 'partial', data: { ...sale.data, payments: [{ date: '2026-01-04', amountKopecks: 10000 }, { date: '2026-01-05', amountKopecks: 20000 }] } };
  const records = [...testCatalogs(), recipe, unpaid, partial];
  const issued = calculateReport(records, day, day);
  assert.equal(saleTotal(unpaid.data), 56780);
  assert.deepEqual(salePayments(unpaid.data), []);
  assert.equal(issued.revenueKopecks, 113560);
  assert.equal(issued.saleReceiptsKopecks, 0);
  assert.equal(issued.cashDeltaKopecks, 0);
  assert.equal(issued.receivablesKopecks, 113560);
  assert.equal(saleDebtKopecks(partial.data, '2026-01-03'), 56780);
  assert.equal(saleDebtKopecks(partial.data, '2026-01-04'), 46780);
  assert.equal(saleDebtKopecks(partial.data, '2026-01-01'), 0);
  const collected = calculateReport(records, '2026-01-04', '2026-01-04');
  assert.equal(collected.revenueKopecks, 0);
  assert.equal(collected.saleReceiptsKopecks, 10000);
  assert.equal(collected.cashDeltaKopecks, 10000);
  assert.equal(collected.receivablesKopecks, 103560);
});

test('legacy invoices keep immediate full cash semantics', () => {
  assert.deepEqual(salePayments(sale.data), [{ date: day, amountKopecks: 56780 }]);
  const report = calculateReport([...testCatalogs(), recipe, sale], day, day);
  assert.equal(report.grossRevenueKopecks, 56780);
  assert.equal(report.saleReceiptsKopecks, 56780);
  assert.equal(report.receivablesKopecks, 0);
  assert.equal(report.cashDeltaKopecks, 56780);
});

test('unallocated sales return reduces net revenue and cash once without reducing material cost', () => {
  const returned = row('expense', 'returned', { date: '2026-01-03', recognitionDate: day, category: 'Возврат', salesReturn: true, amountKopecks: 1000 });
  const records = [...testCatalogs(), recipe, sale, returned];
  const issued = calculateReport(records, day, day);
  assert.equal(issued.grossRevenueKopecks, 56780);
  assert.equal(issued.salesReturnsKopecks, 1000);
  assert.equal(issued.revenueKopecks, 55780);
  assert.equal(issued.otherExpenseKopecks, 0);
  assert.equal(issued.materialCostKopecks, 309);
  assert.equal(issued.profitKopecks, 55780 - 309);
  assert.equal(issued.cashDeltaKopecks, 56780);
  const paid = calculateReport(records, '2026-01-03', '2026-01-03');
  assert.equal(paid.salesReturnsPaidKopecks, 1000);
  assert.equal(paid.expensesPaidKopecks, 0);
  assert.equal(paid.cashOutflowKopecks, 1000);
  assert.equal(paid.cashDeltaKopecks, -1000);
});

test('deducted return uses gross settlement and a separate return instead of double subtraction', () => {
  const records = [...testCatalogs(), recipe, sale, row('expense', 'deducted', { date: day, category: 'Возврат', salesReturn: true, amountKopecks: 1000 })];
  const report = calculateReport(records, day, day);
  assert.equal(report.saleReceiptsKopecks, 56780);
  assert.equal(report.revenueKopecks, 55780);
  assert.equal(report.cashDeltaKopecks, 55780);
  assert.equal(report.receivablesKopecks, 0);
});

test('amount only purchases affect cash and leave ingredient quotes incomplete until quantity is known', () => {
  const purchase = row('purchase', 'unknown', { date: '2026-01-03', ingredientId: 'ingredient', amountOnly: true, totalKopecks: 78000, note: 'Количество ещё неизвестно' });
  assert.equal(purchaseTotal(purchase.data), 78000);
  assert.equal(purchaseTotal({ date: day, ingredientId: 'ingredient', quantity: 2.5, unit: 'kg', unitPriceKopecks: 1234 }), 3085);
  const records = [...testCatalogs(), recipe, purchase];
  assert.equal(quoteFor('ingredient', day, records).perBaseKopecks, 1.234);
  const quote = quoteFor('ingredient', '2026-01-03', records);
  assert.equal(quote.perBaseKopecks, null);
  assert.equal(quote.sourceDate, '2026-01-03');
  assert.match(quote.issue ?? '', /количеств/i);
  assert.equal(costForProduct('product', '2026-01-03', records).unitCostKopecks, null);
  const report = calculateReport(records, '2026-01-03', '2026-01-03');
  assert.equal(report.purchasesPaidKopecks, 78000);
  assert.equal(report.cashDeltaKopecks, -78000);
});

test('actual quantified invoice total preserves exact cash and derived unit cost', () => {
  const purchase = row('purchase', 'exact-invoice', { date: day, ingredientId: 'ingredient', quantity: 3, unit: 'kg', unitPriceKopecks: 334, totalKopecks: 1001 });
  assert.equal(purchaseTotal(purchase.data), 1001);
  const records = [...testCatalogs(), purchase];
  assert.equal(quoteFor('ingredient', day, records).perBaseKopecks, 1001 / 3 / 1000);
  assert.equal(calculateReport(records, day, day).purchasesPaidKopecks, 1001);
});
