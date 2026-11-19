import type { BakeryRecord } from '../lib/types.ts';

// Synthetic fixtures only; live business catalogs are imported privately.
export function testCatalogs(date = '2026-01-01'): BakeryRecord[] {
  const meta = { revision: 1, createdAt: `${date}T00:00:00Z`, updatedAt: `${date}T00:00:00Z`, createdBy: 'test', updatedBy: 'test', deletedAt: null };
  return [
    { id: 'ingredient', kind: 'ingredient', data: { name: 'Тестовый компонент', initialPriceKopecks: 1234, initialUnit: 'kg', initialPriceDate: date }, ...meta },
    { id: 'product', kind: 'product', data: { name: 'Тестовое изделие', salePriceKopecks: 5678 }, ...meta },
    { id: 'employee', kind: 'employee', data: { name: 'Тестовый сотрудник', shiftRateKopecks: 91011 }, ...meta },
  ];
}
