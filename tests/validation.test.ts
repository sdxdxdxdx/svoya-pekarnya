import assert from 'node:assert/strict';
import test from 'node:test';
import { validateData, ValidationError } from '../lib/validation.ts';
import { testCatalogs } from './fixtures.ts';
import type { BakeryRecord } from '../lib/types.ts';

const day = '2026-11-19';
const catalogs = () => testCatalogs(day);
function id(kind: string) { return catalogs().find(r => r.kind === kind)!.id; }
function rejects(kind: Parameters<typeof validateData>[0], data: unknown, records: BakeryRecord[] = catalogs()) {
  assert.throws(() => validateData(kind, data, records), (error: unknown) => error instanceof ValidationError && /[а-яА-Я]/.test(error.message));
}

test('validates known catalogs and preserves nullable unknown ingredient units', () => {
  for (const r of catalogs()) assert.deepEqual(validateData(r.kind, r.data, catalogs(), r.id), r.data);
  assert.deepEqual(validateData('ingredient', { name: ' Соль ', initialPriceKopecks: 2000, initialUnit: null, initialPriceDate: day, extra: 'ignored' }, []), { name: 'Соль', initialPriceKopecks: 2000, initialUnit: null, initialPriceDate: day });
});

test('rejects malformed money, dates, text and objects at the server boundary', () => {
  for (const amount of [NaN, Infinity, -1, 0.5, 1e16, '5000', null]) rejects('product', { name: 'Пирожок', salePriceKopecks: amount });
  for (const date of ['2026-02-29', '2026-04-31', '19.11.2026', '2026-1-01', '0000-01-01']) rejects('expense', { date, category: 'Аренда', amountKopecks: 100 });
  assert.equal(validateData('expense', { date: '2024-02-29', category: 'Аренда', amountKopecks: 100 }, []).date, '2024-02-29');
  for (const name of ['', '  ', 'x'.repeat(161), 42]) rejects('product', { name, salePriceKopecks: 5000 });
  for (const data of [null, [], 'test']) rejects('product', data);
});

test('requires positive bounded quantities, valid dimensions and complete package information', () => {
  const valid = { date: day, ingredientId: id('ingredient'), quantity: 2, unit: 'pack', unitPriceKopecks: 10000, packQuantity: 5, packUnit: 'kg' };
  assert.equal(validateData('purchase', valid, catalogs()).packQuantity, 5);
  for (const quantity of [0, -1, NaN, Infinity, 1e15, '1']) rejects('purchase', { ...valid, quantity });
  rejects('purchase', { ...valid, packQuantity: undefined });
  rejects('purchase', { ...valid, packUnit: 'pack' });
  rejects('purchase', { ...valid, unit: 'bucket' });
  rejects('purchase', { ...valid, quantity: 1000000, unitPriceKopecks: 1000000000000 });
});

test('requires active references while retaining archived catalogs', () => {
  const sale = { date: day, shop: 'Магазин', lines: [{ productId: id('product'), quantity: 1, unitPriceKopecks: 5000 }] };
  rejects('sale', { ...sale, lines: [{ ...sale.lines[0], productId: 'missing' }] });
  const records = catalogs();
  const p = records.find(r => r.id === id('product'))!;
  p.deletedAt = `${day}T12:00:00Z`;
  rejects('sale', sale, records);
  p.deletedAt = null;
  if (p.kind === 'product') p.data.archived = true;
  assert.equal(validateData('sale', sale, records).lines.length, 1);
  rejects('shift', { date: day, employeeId: id('ingredient'), rateKopecks: 100, bonusKopecks: 0 });
});

test('requires one to one hundred invoice and recipe lines', () => {
  const line = { productId: id('product'), quantity: 1, unitPriceKopecks: 5000 };
  rejects('sale', { date: day, shop: 'Магазин', lines: [] });
  rejects('sale', { date: day, shop: 'Магазин', lines: Array(101).fill(line) });
  rejects('sale', { date: day, shop: 'Магазин', lines: [{ ...line, quantity: 0 }] });
  assert.equal(validateData('sale', { date: day, shop: 'Магазин', lines: Array(100).fill(line) }, catalogs()).lines.length, 100);
  rejects('recipe', { productId: id('product'), effectiveFrom: day, lines: [] });
  rejects('recipe', { productId: id('product'), effectiveFrom: day, lines: Array(101).fill({ ingredientId: id('ingredient'), quantity: 1, unit: 'g' }) });
  rejects('recipe', { productId: id('product'), effectiveFrom: day, lines: [{ ingredientId: id('ingredient'), quantity: 1, unit: 'kg' }] });
});

test('prevents duplicate effective recipes and employee shifts while permitting own edit', () => {
  const records = catalogs();
  const data = { productId: id('product'), effectiveFrom: day, lines: [{ ingredientId: id('ingredient'), quantity: 30, unit: 'g' as const }] };
  const metadata = { revision: 1, createdAt: `${day}T00:00:00Z`, updatedAt: `${day}T00:00:00Z`, createdBy: 'test', updatedBy: 'test', deletedAt: null };
  records.push({ id: 'recipe', kind: 'recipe', data, ...metadata });
  rejects('recipe', data, records);
  assert.equal(validateData('recipe', data, records, 'recipe').effectiveFrom, day);
  assert.equal(validateData('recipe', { ...data, effectiveFrom: '2026-11-20' }, records).effectiveFrom, '2026-11-20');
  const shift = { date: day, employeeId: id('employee'), rateKopecks: 70000, bonusKopecks: 0 };
  records.push({ id: 'shift', kind: 'shift', data: shift, ...metadata });
  rejects('shift', shift, records);
  assert.equal(validateData('shift', shift, records, 'shift').rateKopecks, 70000);
});

test('validates payment, expense recognition, owner direction and optional notes', () => {
  rejects('wagePayment', { date: day, employeeId: id('employee'), amountKopecks: 0 });
  rejects('expense', { date: day, recognitionDate: '2026-02-30', category: 'Аренда', amountKopecks: 100 });
  rejects('cashMovement', { date: day, direction: 'other', owner: 'Владелец', amountKopecks: 100 });
  rejects('expense', { date: day, category: 'Аренда', amountKopecks: 100, note: 'x'.repeat(1001) });
  assert.deepEqual(validateData('wagePayment', { date: day, employeeId: id('employee'), amountKopecks: 100, note: '  Аванс  ' }, catalogs()), { date: day, employeeId: id('employee'), amountKopecks: 100, note: 'Аванс' });
  assert.equal(validateData('cashMovement', { date: day, direction: 'in', owner: '', amountKopecks: 100 }, []).owner, '');
});

test('accepts calendar-valid early years without JavaScript’s 1900-year remapping', () => {
  assert.equal(validateData('expense', { date: '0001-01-01', category: 'Прочее', amountKopecks: 100 }, []).date, '0001-01-01');
});

test('roundtrips explicit unpaid and dated partial settlements while preserving legacy absence', () => {
  const sale = { date: day, shop: 'Тестовая торговая точка', lines: [{ productId: id('product'), quantity: 2, unitPriceKopecks: 12000 }] };
  assert.deepEqual(validateData('sale', sale, catalogs()), sale);
  assert.deepEqual(validateData('sale', { ...sale, payments: [] }, catalogs()), { ...sale, payments: [] });
  const payments = [{ date: day, amountKopecks: 1000 }, { date: '2026-11-20', amountKopecks: 23000 }];
  assert.deepEqual(validateData('sale', { ...sale, payments }, catalogs()), { ...sale, payments });
  assert.equal(validateData('sale', { ...sale, payments: Array(100).fill({ date: day, amountKopecks: 1 }) }, catalogs()).payments?.length, 100);
});

test('rejects malformed, excessive, overpaid or pre-invoice settlements', () => {
  const sale = { date: day, shop: 'Тестовая торговая точка', lines: [{ productId: id('product'), quantity: 2, unitPriceKopecks: 12000 }] };
  for (const payments of [null, {}, 'paid', Array(101).fill({ date: day, amountKopecks: 1 }), [{ date: '2026-02-30', amountKopecks: 1 }], [{ date: '2026-11-18', amountKopecks: 1 }]]) rejects('sale', { ...sale, payments });
  for (const amountKopecks of [0, -1, 0.5, '100', NaN, Infinity, 1e16, 24001]) rejects('sale', { ...sale, payments: [{ date: day, amountKopecks }] });
  rejects('sale', { ...sale, payments: [{ date: day, amountKopecks: 12001 }, { date: day, amountKopecks: 12000 }] });
});

test('amount only purchases retain a total without silently inventing or accepting quantities', () => {
  const purchase = { date: day, ingredientId: id('ingredient'), amountOnly: true, totalKopecks: 78000, note: ' Нужна накладная ' };
  assert.deepEqual(validateData('purchase', purchase, catalogs()), { ...purchase, note: 'Нужна накладная' });
  for (const totalKopecks of [undefined, 0, -1, 0.5, NaN, Infinity, '78000', 1e16]) rejects('purchase', { ...purchase, totalKopecks });
  for (const extra of [{ quantity: 2 }, { unit: 'kg' }, { unitPriceKopecks: 100 }, { packQuantity: 5 }, { packUnit: 'kg' }]) rejects('purchase', { ...purchase, ...extra });
  rejects('purchase', { ...purchase, amountOnly: 'true' });
  rejects('purchase', { ...purchase, amountOnly: false });
});

test('sales return marker is explicit boolean and survives server validation', () => {
  const expense = { date: day, category: 'Возврат', amountKopecks: 1200 };
  assert.deepEqual(validateData('expense', { ...expense, salesReturn: true }, []), { ...expense, salesReturn: true });
  assert.deepEqual(validateData('expense', { ...expense, salesReturn: false }, []), { ...expense, salesReturn: false });
  rejects('expense', { ...expense, salesReturn: 'true' });
});

test('quantified purchases preserve authoritative invoice totals with bounded whole kopecks', () => {
  const purchase = { date: day, ingredientId: id('ingredient'), quantity: 3, unit: 'kg', unitPriceKopecks: 334, totalKopecks: 1001 };
  assert.deepEqual(validateData('purchase', purchase, catalogs()), purchase);
  for (const totalKopecks of [0, -1, 0.5, NaN, Infinity, '1001', 1e16]) rejects('purchase', { ...purchase, totalKopecks });
});
