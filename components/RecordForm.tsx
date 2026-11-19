'use client';

import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Plus, Save, Trash2, X } from 'lucide-react';
import { costForProduct, money, quoteFor } from '@/lib/accounting';
import { ApiError } from '@/lib/client';
import type { BakeryRecord, BasePurchaseUnit, DataByKind, PurchaseUnit, RecipeUnit, RecordKind } from '@/lib/types';

export const kindNames: Record<RecordKind, string> = { sale: 'Накладная', purchase: 'Закупка', recipe: 'Рецептура', ingredient: 'Сырьё', product: 'Изделие', employee: 'Сотрудник', shift: 'Выход на работу', wagePayment: 'Выплата зарплаты', expense: 'Прочий расход', cashMovement: 'Движение владельца' };
export const units: Record<PurchaseUnit, string> = { kg: 'кг', g: 'г', l: 'л', ml: 'мл', pcs: 'шт.', pack: 'упак.' };
type Fields = Record<string, string>;
type Line = { itemId: string; quantity: string; price: string; unit: RecipeUnit };
type Props = { kind: RecordKind; record?: BakeryRecord; preset?: Fields; records: BakeryRecord[]; date: string; onSave: (data: DataByKind[RecordKind], record: BakeryRecord | undefined, id: string) => Promise<void>; onClose: () => void; onReload: () => Promise<void>; onOpenLatest: () => void; };

const rubles = (value: number) => String(value / 100);
const number = (value: string) => Number(value.replace(',', '.'));
function kopecks(value: string) { const n = number(value); if (!Number.isFinite(n) || !Number.isSafeInteger(Math.round(n * 100))) throw new Error('Введите корректную сумму в рублях.'); return Math.round(n * 100); }
function initialFields(kind: RecordKind, date: string, record?: BakeryRecord, preset?: Fields): Fields {
  const fields: Fields = { date, effectiveFrom: date, initialPriceDate: date, name: '', shop: '', note: '', category: '', owner: '', direction: 'out', quantity: '1', unit: 'kg', initialUnit: '', initialPriceKopecks: '', salePriceKopecks: '', shiftRateKopecks: '', rateKopecks: '', bonusKopecks: '0', amountKopecks: '', unitPriceKopecks: '', packQuantity: '', packUnit: 'g', employeeId: '', ingredientId: '', productId: '', recognitionDate: '', archived: 'false' };
  if (record) for (const [key, value] of Object.entries(record.data)) {
    if (key === 'lines') continue;
    fields[key] = value == null ? '' : key.endsWith('Kopecks') && typeof value === 'number' ? rubles(value) : String(value);
  }
  if (kind === 'ingredient' && !record) fields.unit = '';
  return { ...fields, ...preset };
}

export default function RecordForm({ kind, record, preset, records, date, onSave, onClose, onReload, onOpenLatest }: Props) {
  const [fields, setFields] = useState(() => initialFields(kind, date, record, preset));
  const [lines, setLines] = useState<Line[]>(() => {
    if (record?.kind === 'sale') return record.data.lines.map(line => ({ itemId: line.productId, quantity: String(line.quantity), price: rubles(line.unitPriceKopecks), unit: 'g' }));
    if (record?.kind === 'recipe') return record.data.lines.map(line => ({ itemId: line.ingredientId, quantity: String(line.quantity), price: '', unit: line.unit }));
    return [{ itemId: kind === 'sale' ? records.find(r => r.kind === 'product' && !r.deletedAt && !r.data.archived)?.id || '' : '', quantity: kind === 'recipe' ? '' : '1', price: '', unit: 'g' }];
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const createId = useRef(crypto.randomUUID());
  const set = (key: string, value: string) => setFields(current => ({ ...current, [key]: value }));
  const active = (catalog: 'ingredient' | 'product' | 'employee', selected = '') => records.filter(r => r.kind === catalog && !r.deletedAt && (!r.data.archived || r.id === selected));
  const label = (text: string, children: ReactNode, full = false) => <label className={full ? 'field full' : 'field'}><span>{text}</span>{children}</label>;
  const input = (key: string, text: string, type = 'text', required = true, full = false) => label(text, <input name={key} type={type} value={fields[key] || ''} onChange={event => set(key, event.target.value)} required={required} step={type === 'number' ? 'any' : undefined} min={type === 'number' ? '0' : undefined} maxLength={type === 'text' ? 500 : undefined} />, full);
  const amount = (key: string, text: string, required = true) => label(text, <input name={key} type="text" inputMode="decimal" pattern="[0-9]+([.,][0-9]{1,2})?" placeholder="0,00" value={fields[key] || ''} onChange={event => set(key, event.target.value)} required={required} />);
  const selectCatalog = (key: string, text: string, catalog: 'ingredient' | 'product' | 'employee') => label(text, <select name={key} value={fields[key]} onChange={event => { const id = event.target.value; set(key, id); if (catalog === 'employee' && kind === 'shift') { const employee = records.find(r => r.id === id); if (employee?.kind === 'employee') set('rateKopecks', rubles(employee.data.shiftRateKopecks)); } }} required><option value="">Выберите из списка</option>{active(catalog, fields[key]).map(r => <option key={r.id} value={r.id}>{'name' in r.data ? r.data.name : ''}{'archived' in r.data && r.data.archived ? ' (в архиве)' : ''}</option>)}</select>);
  const unitSelect = (key: string, text: string, allowEmpty = false, baseOnly = false) => label(text, <select name={key} value={fields[key]} onChange={event => set(key, event.target.value)} required={!allowEmpty}>{allowEmpty && <option value="">Единица не уточнена</option>}{Object.entries(units).filter(([unit]) => !baseOnly || unit !== 'pack').map(([unit, name]) => <option key={unit} value={unit}>{name}</option>)}</select>);
  const editLine = (index: number, patch: Partial<Line>) => setLines(current => current.map((line, i) => i === index ? { ...line, ...patch } : line));
  const recipeCost = useMemo(() => {
    if (kind !== 'recipe' || !fields.productId || !fields.effectiveFrom) return null;
    const candidate: BakeryRecord<'recipe'> = { id: record?.id || createId.current, kind: 'recipe', revision: record?.revision || 1, createdAt: '', updatedAt: '', createdBy: '', updatedBy: '', deletedAt: null, data: { productId: fields.productId, effectiveFrom: fields.effectiveFrom, lines: lines.map(line => ({ ingredientId: line.itemId, quantity: number(line.quantity), unit: line.unit })) } };
    if (candidate.data.lines.some(line => !line.ingredientId || !(line.quantity > 0))) return null;
    return costForProduct(fields.productId, fields.effectiveFrom, [...records.filter(r => r.id !== candidate.id), candidate]);
  }, [kind, fields.productId, fields.effectiveFrom, lines, record, records]);

  function data(): DataByKind[RecordKind] {
    const f = fields;
    const note = f.note.trim() || undefined;
    switch (kind) {
      case 'ingredient': return { name: f.name.trim(), archived: f.archived === 'true', initialPriceKopecks: f.initialPriceKopecks === '' ? null : kopecks(f.initialPriceKopecks), initialUnit: f.initialUnit ? f.initialUnit as PurchaseUnit : null, initialPriceDate: f.initialPriceDate };
      case 'product': return { name: f.name.trim(), salePriceKopecks: kopecks(f.salePriceKopecks), archived: f.archived === 'true' };
      case 'employee': return { name: f.name.trim(), shiftRateKopecks: kopecks(f.shiftRateKopecks), archived: f.archived === 'true' };
      case 'purchase': return { date: f.date, ingredientId: f.ingredientId, quantity: number(f.quantity), unit: f.unit as PurchaseUnit, unitPriceKopecks: kopecks(f.unitPriceKopecks), ...(f.unit === 'pack' ? { packQuantity: number(f.packQuantity), packUnit: f.packUnit as BasePurchaseUnit } : {}), note };
      case 'sale': return { date: f.date, shop: f.shop.trim(), lines: lines.map(line => { const product = records.find(r => r.id === line.itemId); return { productId: line.itemId, quantity: number(line.quantity), unitPriceKopecks: line.price === '' && product?.kind === 'product' ? product.data.salePriceKopecks : kopecks(line.price) }; }), note };
      case 'recipe': return { productId: f.productId, effectiveFrom: f.effectiveFrom, lines: lines.map(line => ({ ingredientId: line.itemId, quantity: number(line.quantity), unit: line.unit })) };
      case 'shift': return { date: f.date, employeeId: f.employeeId, rateKopecks: kopecks(f.rateKopecks), bonusKopecks: kopecks(f.bonusKopecks), note };
      case 'wagePayment': return { date: f.date, employeeId: f.employeeId, amountKopecks: kopecks(f.amountKopecks), note };
      case 'expense': return { date: f.date, recognitionDate: f.recognitionDate || undefined, category: f.category.trim(), amountKopecks: kopecks(f.amountKopecks), note };
      case 'cashMovement': return { date: f.date, direction: f.direction as 'in' | 'out', owner: f.owner.trim(), amountKopecks: kopecks(f.amountKopecks), note };
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (saving) return;
    setError(''); setConflict(false); setSaving(true);
    try { await onSave(data(), record, createId.current); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить запись. Повторите попытку.'); setConflict(cause instanceof ApiError && cause.status === 409); }
    finally { setSaving(false); }
  }
  const catalog = kind === 'ingredient' || kind === 'product' || kind === 'employee';
  const invoiceTotal = kind === 'sale' ? lines.reduce<number | null>((sum, line) => {
    const product = records.find(item => item.id === line.itemId);
    const price = line.price === '' && product?.kind === 'product' ? product.data.salePriceKopecks : number(line.price) * 100;
    const quantity = number(line.quantity);
    return sum === null || !line.itemId || !(quantity > 0) || !Number.isFinite(price) ? null : sum + Math.round(quantity * Math.round(price));
  }, 0) : null;
  return <section className="editor" aria-label={kindNames[kind]}>
    <div className="section-heading"><h2>{record ? 'Изменить: ' : 'Добавить: '}{kindNames[kind].toLocaleLowerCase('ru')}</h2><button type="button" className="button quiet" onClick={onClose} disabled={saving}><X size={18} />Закрыть</button></div>
    <form onSubmit={submit}>
      <fieldset disabled={saving}><div className="fields">
        {!catalog && kind !== 'recipe' && input('date', 'Дата', 'date')}
        {catalog && input('name', kind === 'employee' ? 'Имя сотрудника' : 'Название', 'text', true, true)}
        {kind === 'ingredient' && <>{amount('initialPriceKopecks', 'Начальная цена, ₽', false)}{unitSelect('initialUnit', 'За какую единицу', true)}{input('initialPriceDate', 'Цена известна на дату', 'date')}<p className="hint full">Если цена или единица не уточнены, оставьте поле пустым. Цена за упаковку уточняется через закупку с содержимым упаковки.</p></>}
        {kind === 'product' && amount('salePriceKopecks', 'Цена продажи за штуку, ₽')}
        {kind === 'employee' && amount('shiftRateKopecks', 'Ставка за выход, ₽')}
        {catalog && <label className="checkbox full"><input type="checkbox" checked={fields.archived === 'true'} onChange={event => set('archived', String(event.target.checked))} /><span>В архиве — скрыть из новых операций, сохранить историю</span></label>}
        {kind === 'sale' && <>{input('shop', 'Магазин')}<p className="hint full">Одна накладная — один магазин. Оплата получена наличными.</p></>}
        {kind === 'purchase' && <>{selectCatalog('ingredientId', 'Сырьё', 'ingredient')}{input('quantity', 'Количество', 'number')}{unitSelect('unit', 'Единица закупки')}{amount('unitPriceKopecks', `Цена за ${units[fields.unit as PurchaseUnit] || 'единицу'}, ₽`)}{fields.unit === 'pack' && <>{input('packQuantity', 'Содержимое одной упаковки', 'number')}{unitSelect('packUnit', 'Единица содержимого', false, true)}</>}<p className="hint full">Всего оплачено: {fields.quantity && fields.unitPriceKopecks && Number.isFinite(number(fields.quantity) * number(fields.unitPriceKopecks)) ? money(Math.round(number(fields.quantity) * number(fields.unitPriceKopecks) * 100)) : 'укажите количество и цену'}. Закупка учитывается в движении денег.</p></>}
        {kind === 'recipe' && <>{selectCatalog('productId', 'Изделие', 'product')}{input('effectiveFrom', 'Рецепт действует с', 'date')}<p className="hint full">Состав на одно изделие. Для изменения состава с новой даты создайте новую рецептуру. Изменение старой версии пересчитает её продажи.</p></>}
        {(kind === 'sale' || kind === 'recipe') && <div className="full line-items">{lines.map((line, index) => {
          const source = kind === 'sale' ? 'product' : 'ingredient';
          const selected = records.find(r => r.id === line.itemId);
          const price = line.price || (selected?.kind === 'product' ? rubles(selected.data.salePriceKopecks) : '');
          const quote = kind === 'recipe' && line.itemId ? quoteFor(line.itemId, fields.effectiveFrom, records) : null;
          return <div className="line-item" key={index}><span className="line-number">Строка {index + 1}</span><div className="line-fields">{label(kind === 'sale' ? 'Изделие' : 'Ингредиент', <select aria-label={`${kind === 'sale' ? 'Изделие' : 'Ингредиент'} ${index + 1}`} value={line.itemId} required onChange={event => { const selected = records.find(r => r.id === event.target.value); editLine(index, { itemId: event.target.value, ...(selected?.kind === 'product' ? { price: rubles(selected.data.salePriceKopecks) } : {}) }); }}><option value="">Выберите из списка</option>{active(source, line.itemId).map(r => <option key={r.id} value={r.id}>{'name' in r.data ? r.data.name : ''}</option>)}</select>)}{label(kind === 'sale' ? 'Количество, шт.' : 'Количество', <input aria-label={`Количество ${index + 1}`} type="number" step="any" min="0.000001" required value={line.quantity} onChange={event => editLine(index, { quantity: event.target.value })} />)}{kind === 'sale' ? label('Цена за штуку, ₽', <input aria-label={`Цена ${index + 1}`} type="text" inputMode="decimal" pattern="[0-9]+([.,][0-9]{1,2})?" required value={price} onChange={event => editLine(index, { price: event.target.value })} />) : label('Единица', <select value={line.unit} onChange={event => editLine(index, { unit: event.target.value as RecipeUnit })}><option value="g">г</option><option value="ml">мл</option><option value="pcs">шт.</option></select>)}<button className="button quiet remove-line" type="button" disabled={lines.length === 1} aria-label={`Удалить строку ${index + 1}`} onClick={() => setLines(current => current.filter((_, i) => i !== index))}><Trash2 size={18} /></button></div>{quote && <p className="hint">{quote.label}{quote.issue ? ` · ${quote.issue}` : ''}</p>}</div>;
        })}<button type="button" className="button" onClick={() => setLines(current => [...current, { itemId: '', quantity: '', price: '', unit: 'g' }])}><Plus size={18} />{kind === 'sale' ? 'Добавить изделие' : 'Добавить ингредиент'}</button></div>}
        {kind === 'sale' && <div className="total-row full" aria-live="polite"><span>Итого по накладной</span><strong>{invoiceTotal == null ? 'Заполните строки' : money(invoiceTotal)}</strong></div>}
        {kind === 'recipe' && <div className="recipe-live full" aria-live="polite"><span>Расчётное сырьё на 1 шт.</span><strong>{recipeCost?.unitCostKopecks != null ? money(recipeCost.unitCostKopecks) : 'Расчёт неполный'}</strong>{recipeCost?.ingredients.map((item, index) => <div className="cost-part" key={`${item.ingredientId}-${index}`}><span>{item.name} · {item.quantity} {units[item.unit]}</span><span>{item.amountKopecks == null ? item.issue || 'Нет цены' : money(item.amountKopecks)}</span></div>)}{recipeCost?.issues.map(issue => <p className="error-text" key={issue}>{issue}</p>)}{!recipeCost && <p className="hint">Выберите изделие и заполните все строки состава.</p>}<p className="hint">Оценка по последним закупочным ценам на дату рецепта. На другую дату цена сырья может измениться.</p></div>}
        {(kind === 'shift' || kind === 'wagePayment') && selectCatalog('employeeId', 'Сотрудник', 'employee')}
        {kind === 'shift' && <>{amount('rateKopecks', 'Ставка за этот выход, ₽')}{amount('bonusKopecks', 'Премия, ₽')}<p className="hint full">Начисление зарплаты за фактическую дату выхода. Выплата записывается отдельно.</p></>}
        {kind === 'wagePayment' && amount('amountKopecks', 'Фактически выплачено, ₽')}
        {kind === 'expense' && <>{input('category', 'Категория расхода')}{amount('amountKopecks', 'Оплачено, ₽')}{input('recognitionDate', 'Учесть в прибыли на дату (необязательно)', 'date', false)}<p className="hint full">Если дату учёта не указать, расход уменьшит прибыль в день оплаты.</p></>}
        {kind === 'cashMovement' && <>{label('Движение', <select value={fields.direction} onChange={event => set('direction', event.target.value)}><option value="in">Вложение в кассу</option><option value="out">Снятие из кассы</option></select>)}{input('owner', 'Владелец (необязательно)', 'text', false)}{amount('amountKopecks', 'Сумма, ₽')}<p className="hint full">Вложения и снятия меняют кассу и не влияют на прибыль.</p></>}
        {!catalog && kind !== 'recipe' && input('note', 'Примечание (необязательно)', 'text', false, true)}
      </div></fieldset>
      {error && <div className="form-error" role="alert"><p>{error}</p>{conflict && <div className="actions"><button className="button" type="button" onClick={async () => { try { await onReload(); } catch { /* Parent displays reload error. */ } }}>Обновить данные</button><button className="button" type="button" onClick={onOpenLatest}>Открыть актуальную запись</button></div>}</div>}
      <div className="form-footer"><span className="hint">{record ? 'Изменение сохранится в общем учёте.' : 'Запись появится в общем учёте после сохранения.'}</span><button type="button" className="button" disabled={saving} onClick={onClose}>Отмена</button><button className="button primary" type="submit" disabled={saving || conflict}><Save size={18} />{saving ? 'Сохраняем…' : 'Сохранить'}</button></div>
    </form>
  </section>;
}
