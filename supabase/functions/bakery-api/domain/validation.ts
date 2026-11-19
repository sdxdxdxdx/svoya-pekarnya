import type { BakeryRecord, DataByKind, RecordKind } from './types.ts';

export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

const MAX_MONEY = 1_000_000_000_000;
const MAX_QUANTITY = 1_000_000;
const purchaseUnits = ['kg', 'g', 'l', 'ml', 'pcs', 'pack'] as const;
const recipeUnits = ['g', 'ml', 'pcs'] as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Ожидается объект с полями записи.');
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 160, empty = false): string {
  if (typeof value !== 'string') throw new ValidationError(`${label}: введите текст.`);
  const result = value.trim();
  if ((!empty && !result) || result.length > max) throw new ValidationError(`${label}: длина должна быть от ${empty ? 0 : 1} до ${max} символов.`);
  return result;
}
function amount(value: unknown, label: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > MAX_MONEY) throw new ValidationError(`${label}: укажите целую сумму в копейках ${positive ? 'больше нуля' : 'не меньше нуля'} и не больше 10 млрд рублей.`);
  return value;
}
function quantity(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.000001 || value > MAX_QUANTITY) throw new ValidationError(`${label}: количество должно быть от 0,000001 до 1 000 000.`);
  return value;
}
function date(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) throw new ValidationError(`${label}: укажите дату в формате ГГГГ-ММ-ДД.`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new ValidationError(`${label}: такой календарной даты не существует.`);
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new ValidationError(`${label}: выберите допустимое значение.`);
  return value as T;
}
function lines(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new ValidationError('Добавьте от 1 до 100 строк.');
  return value;
}
function optionalNote(data: Record<string, unknown>): { note?: string } {
  return data.note === undefined ? {} : { note: text(data.note, 'Комментарий', 1000, true) };
}
function optionalArchived(data: Record<string, unknown>): { archived?: boolean } {
  if (data.archived === undefined) return {};
  if (typeof data.archived !== 'boolean') throw new ValidationError('Признак архива должен быть логическим значением.');
  return { archived: data.archived };
}
function optionalSalesReturn(data: Record<string, unknown>): { salesReturn?: boolean } {
  if (data.salesReturn === undefined) return {};
  if (typeof data.salesReturn !== 'boolean') throw new ValidationError('Признак возврата должен быть логическим значением.');
  return { salesReturn: data.salesReturn };
}

export function validateData<K extends RecordKind>(kind: K, data: unknown, records: BakeryRecord[], excludeId?: string): DataByKind[K] {
  const d = object(data);
  const active = records.filter(r => !r.deletedAt);
  const reference = (value: unknown, expected: 'ingredient' | 'employee' | 'product', label: string): string => {
    const id = text(value, label, 200);
    if (!active.some(r => r.id === id && r.kind === expected)) throw new ValidationError(`${label}: запись не найдена или удалена.`);
    return id;
  };
  const total = (value: number) => { if (!Number.isFinite(value) || value > MAX_MONEY) throw new ValidationError('Общая сумма записи превышает 10 млрд рублей.'); };
  let result: DataByKind[RecordKind];
  switch (kind) {
    case 'ingredient':
      result = { name: text(d.name, 'Название сырья'), initialPriceKopecks: d.initialPriceKopecks === null ? null : amount(d.initialPriceKopecks, 'Начальная цена'), initialUnit: d.initialUnit === null ? null : choice(d.initialUnit, purchaseUnits, 'Единица начальной цены'), initialPriceDate: date(d.initialPriceDate, 'Дата начальной цены'), ...optionalArchived(d) };
      break;
    case 'product':
      result = { name: text(d.name, 'Название изделия'), salePriceKopecks: amount(d.salePriceKopecks, 'Цена продажи'), ...optionalArchived(d) };
      break;
    case 'employee':
      result = { name: text(d.name, 'Имя сотрудницы'), shiftRateKopecks: amount(d.shiftRateKopecks, 'Ставка за смену'), ...optionalArchived(d) };
      break;
    case 'purchase': {
      if (d.amountOnly !== undefined && typeof d.amountOnly !== 'boolean') throw new ValidationError('Признак закупки без количества должен быть логическим значением.');
      if (d.amountOnly === true) {
        if (['quantity', 'unit', 'unitPriceKopecks', 'packQuantity', 'packUnit'].some(key => key in d)) throw new ValidationError('В закупке только с суммой нельзя указывать количество, единицу или цену единицы.');
        result = { date: date(d.date, 'Дата закупки'), ingredientId: reference(d.ingredientId, 'ingredient', 'Сырьё'), amountOnly: true, totalKopecks: amount(d.totalKopecks, 'Сумма закупки', true), ...optionalNote(d) };
        break;
      }
      const unit = choice(d.unit, purchaseUnits, 'Единица закупки');
      const purchase = { date: date(d.date, 'Дата закупки'), ingredientId: reference(d.ingredientId, 'ingredient', 'Сырьё'), quantity: quantity(d.quantity, 'Количество закупки'), unit, unitPriceKopecks: amount(d.unitPriceKopecks, 'Цена единицы'), ...(d.totalKopecks === undefined ? {} : { totalKopecks: amount(d.totalKopecks, 'Сумма закупки', true) }), ...optionalNote(d) };
      total(purchase.totalKopecks ?? purchase.quantity * purchase.unitPriceKopecks);
      result = unit === 'pack' ? { ...purchase, packQuantity: quantity(d.packQuantity, 'Содержимое упаковки'), packUnit: choice(d.packUnit, ['kg', 'g', 'l', 'ml', 'pcs'] as const, 'Единица содержимого') } : purchase;
      break;
    }
    case 'sale': {
      const saleLines = lines(d.lines).map(value => {
        const line = object(value);
        return { productId: reference(line.productId, 'product', 'Изделие'), quantity: quantity(line.quantity, 'Количество изделий'), unitPriceKopecks: amount(line.unitPriceKopecks, 'Цена продажи') };
      });
      const invoiceTotal = saleLines.reduce((sum, line) => { const value = line.quantity * line.unitPriceKopecks; return sum + Math.round(value + Number.EPSILON * Math.abs(value)); }, 0);
      total(invoiceTotal);
      const saleDate = date(d.date, 'Дата продажи');
      let payments;
      if (d.payments !== undefined) {
        if (!Array.isArray(d.payments) || d.payments.length > 100) throw new ValidationError('Укажите от 0 до 100 оплат по накладной.');
        payments = d.payments.map(value => {
          const payment = object(value);
          const paymentDate = date(payment.date, 'Дата оплаты накладной');
          if (paymentDate < saleDate) throw new ValidationError('Дата оплаты не может быть раньше даты накладной.');
          return { date: paymentDate, amountKopecks: amount(payment.amountKopecks, 'Оплата накладной', true) };
        });
        if (payments.reduce((sum, payment) => sum + payment.amountKopecks, 0) > invoiceTotal) throw new ValidationError('Оплаты не могут превышать сумму накладной.');
      }
      result = { date: saleDate, shop: text(d.shop, 'Магазин'), lines: saleLines, ...(payments === undefined ? {} : { payments }), ...optionalNote(d) };
      break;
    }
    case 'recipe': {
      const productId = reference(d.productId, 'product', 'Изделие');
      const effectiveFrom = date(d.effectiveFrom, 'Дата действия рецептуры');
      if (active.some(r => r.id !== excludeId && r.kind === 'recipe' && r.data.productId === productId && r.data.effectiveFrom === effectiveFrom)) throw new ValidationError('Для этого изделия уже есть рецептура с такой датой действия. Измените существующую рецептуру или выберите другую дату.');
      result = { productId, effectiveFrom, lines: lines(d.lines).map(value => {
        const line = object(value);
        return { ingredientId: reference(line.ingredientId, 'ingredient', 'Сырьё'), quantity: quantity(line.quantity, 'Количество в рецептуре'), unit: choice(line.unit, recipeUnits, 'Единица рецептуры') };
      }) };
      break;
    }
    case 'shift': {
      const employeeId = reference(d.employeeId, 'employee', 'Сотрудница');
      const shiftDate = date(d.date, 'Дата смены');
      if (active.some(r => r.id !== excludeId && r.kind === 'shift' && r.data.employeeId === employeeId && r.data.date === shiftDate)) throw new ValidationError('Для этой сотрудницы уже записан выход в выбранную дату. Измените существующую запись.');
      const rateKopecks = amount(d.rateKopecks, 'Ставка за смену');
      const bonusKopecks = amount(d.bonusKopecks, 'Премия');
      total(rateKopecks + bonusKopecks);
      result = { date: shiftDate, employeeId, rateKopecks, bonusKopecks, ...optionalNote(d) };
      break;
    }
    case 'wagePayment':
      result = { date: date(d.date, 'Дата выплаты'), employeeId: reference(d.employeeId, 'employee', 'Сотрудница'), amountKopecks: amount(d.amountKopecks, 'Сумма выплаты', true), ...optionalNote(d) };
      break;
    case 'expense':
      result = { date: date(d.date, 'Дата оплаты'), ...(d.recognitionDate === undefined ? {} : { recognitionDate: date(d.recognitionDate, 'Дата признания расхода') }), category: text(d.category, 'Категория', 120), amountKopecks: amount(d.amountKopecks, 'Сумма расхода', true), ...optionalSalesReturn(d), ...optionalNote(d) };
      break;
    case 'cashMovement':
      result = { date: date(d.date, 'Дата движения'), direction: choice(d.direction, ['in', 'out'] as const, 'Направление движения'), owner: text(d.owner, 'Владелец', 160, true), amountKopecks: amount(d.amountKopecks, 'Сумма движения', true), ...optionalNote(d) };
      break;
    default: throw new ValidationError('Неизвестный тип записи.');
  }
  return result as DataByKind[K];
}
