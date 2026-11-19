'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Check, ChevronRight, Download, History, LayoutDashboard, LogOut, Pencil, Plus, Receipt, RefreshCw, Settings, ShoppingBasket, Store, Trash2, Users, Wallet, Wheat, X } from 'lucide-react';
import RecordForm, { kindNames, units } from '@/components/RecordForm';
import { calculateReport, costForProduct, dateLabel, money, quoteFor, todayMoscow } from '@/lib/accounting';
import { ApiError, downloadBackup, getBootstrap, saveRecord, setRecordDeleted } from '@/lib/client';
import type { BakeryRecord, Bootstrap, DataByKind, RecordKind } from '@/lib/types';

type View = 'summary' | 'sales' | 'purchases' | 'recipes' | 'staff' | 'expenses' | 'cash' | 'settings';
type Editor = { key: number; kind: RecordKind; record?: BakeryRecord; preset?: Record<string, string> };
const navigation = [
  { id: 'summary', label: 'Сводка', icon: LayoutDashboard, subtitle: 'Что заработали, потратили и ещё нужно учесть.' },
  { id: 'sales', label: 'Продажи', icon: Store, subtitle: 'Накладные магазинов и полученные наличные.' },
  { id: 'purchases', label: 'Закупки', icon: ShoppingBasket, subtitle: 'Покупки сырья, количество и закупочные цены.' },
  { id: 'recipes', label: 'Рецептуры', icon: BookOpen, subtitle: 'Состав на одно изделие и расчётная стоимость сырья.' },
  { id: 'staff', label: 'Сотрудники', icon: Users, subtitle: 'Фактические выходы, премии и выплаты зарплаты.' },
  { id: 'expenses', label: 'Расходы', icon: Receipt, subtitle: 'Газ, доставка и другие затраты пекарни.' },
  { id: 'cash', label: 'Касса владельцев', icon: Wallet, subtitle: 'Вложения и снятия совладельцев.' },
  { id: 'settings', label: 'Настройки', icon: Settings, subtitle: 'Доступ, справочники и сохранность общего учёта.' },
] as const;
const catalogKinds = new Set<RecordKind>(['ingredient', 'product', 'employee']);
const EMPTY_RECORDS: BakeryRecord[] = [];
const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 });
function ofKind<K extends RecordKind>(records: BakeryRecord[], kind: K): BakeryRecord<K>[] { return records.filter(record => record.kind === kind) as BakeryRecord<K>[]; }
function recordDate(record: BakeryRecord) { return 'date' in record.data ? record.data.date : 'effectiveFrom' in record.data ? record.data.effectiveFrom : record.updatedAt.slice(0, 10); }
function amountFor(record: BakeryRecord) {
  switch (record.kind) {
    case 'sale': return record.data.lines.reduce((sum, line) => sum + Math.round(line.quantity * line.unitPriceKopecks), 0);
    case 'purchase': return Math.round(record.data.quantity * record.data.unitPriceKopecks);
    case 'shift': return record.data.rateKopecks + record.data.bonusKopecks;
    case 'wagePayment': case 'expense': case 'cashMovement': return record.data.amountKopecks;
    default: return null;
  }
}
function Empty({ children }: { children: ReactNode }) { return <div className="empty"><BookOpen size={24} aria-hidden="true" /><p>{children}</p></div>; }
function Metric({ label, value, note, positive }: { label: string; value: string; note?: string; positive?: boolean }) { return <div className="metric"><span>{label}</span><strong className={positive ? 'positive' : undefined}>{value}</strong>{note && <small>{note}</small>}</div>; }

export default function BakeryApp({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [view, setView] = useState<View>('summary');
  const [from, setFrom] = useState(todayMoscow);
  const [to, setTo] = useState(todayMoscow);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<BakeryRecord | null>(null);
  const [actionError, setActionError] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [formSaving, setFormSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const refreshingRef = useRef(false);
  const formRef = useRef<HTMLDivElement>(null);
  const deleteDialogRef = useRef<HTMLElement>(null);
  const editorCounter = useRef(0);

  async function leave() {
    if (signingOut || formSaving || (editor && !window.confirm('Выйти из учёта? Несохранённый ввод формы будет потерян.'))) return;
    setSigningOut(true);
    try { await onSignOut(); }
    catch (cause) { setConnectionError(cause instanceof Error ? cause.message : 'Не удалось выйти. Повторите попытку.'); }
    finally { setSigningOut(false); }
  }

  const refresh = useCallback(async (silent = false) => {
    if (refreshingRef.current) return;
    refreshingRef.current = true; setRefreshing(true);
    try {
      const data = await getBootstrap();
      setBootstrap(current => {
        const merged = new Map(data.records.map(record => [record.id, record]));
        for (const record of current?.records || []) {
          const fetched = merged.get(record.id);
          if (!fetched || fetched.revision < record.revision) merged.set(record.id, record);
        }
        return { ...data, records: [...merged.values()] };
      });
      setConnectionError(''); if (!silent) setNotice('Данные обновлены.');
    }
    catch (cause) { setConnectionError(cause instanceof Error ? cause.message : 'Не удалось обновить данные.'); }
    finally { refreshingRef.current = false; setRefreshing(false); }
  }, []);
  useEffect(() => {
    void refresh(true);
    const interval = window.setInterval(() => { if (!document.hidden) void refresh(true); }, 30_000);
    const focus = () => { void refresh(true); };
    window.addEventListener('focus', focus);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', focus); };
  }, [refresh]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    if (!deleteTarget) return;
    const previous = document.activeElement as HTMLElement | null;
    deleteDialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => previous?.focus();
  }, [deleteTarget]);

  const records = bootstrap?.records || EMPTY_RECORDS;
  const live = useMemo(() => records.filter(record => !record.deletedAt), [records]);
  const products = ofKind(live, 'product');
  const ingredients = ofKind(live, 'ingredient');
  const employees = ofKind(live, 'employee');
  const name = (id: string) => { const record = records.find(item => item.id === id); return record && 'name' in record.data ? record.data.name : 'Запись не найдена'; };
  const validPeriod = Boolean(from && to && from <= to);
  const report = useMemo(() => calculateReport(records, from, to), [records, from, to]);
  const periodRecords = live.filter(record => recordDate(record) >= from && recordDate(record) <= to).sort((a, b) => recordDate(b).localeCompare(recordDate(a)) || b.updatedAt.localeCompare(a.updatedAt));
  const currentNav = navigation.find(item => item.id === view)!;
  function closeEditor() { if (!window.confirm('Закрыть форму? Несохранённый ввод будет потерян.')) return; setEditor(null); }
  function open(kind: RecordKind, record?: BakeryRecord, preset?: Record<string, string>) {
    if (formSaving) { setNotice('Дождитесь завершения сохранения текущей записи.'); return; }
    if (editor && !window.confirm('Открыть другую запись? Несохранённый ввод текущей формы будет потерян.')) return;
    setEditor({ key: ++editorCounter.current, kind, record, preset }); setNotice('');
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }
  const upsert = (record: BakeryRecord) => setBootstrap(current => {
    if (!current) return current;
    const existing = current.records.find(item => item.id === record.id);
    if (existing && existing.revision > record.revision) return current;
    return { ...current, records: [...current.records.filter(item => item.id !== record.id), record] };
  });
  async function save(data: DataByKind[RecordKind], existing: BakeryRecord | undefined, id: string) {
    if (!editor) return;
    setFormSaving(true);
    try { const record = await saveRecord(editor.kind, data, existing, id); upsert(record); setEditor(null); setNotice('Запись сохранена в общем учёте.'); }
    catch (cause) { if (cause instanceof ApiError && cause.status === 409) void refresh(true); throw cause; }
    finally { setFormSaving(false); }
  }
  async function deleteOrRestore(record: BakeryRecord, restore = false) {
    if (pendingId) return;
    setPendingId(record.id); setActionError('');
    try { const result = await setRecordDeleted(record, restore); upsert(result); setDeleteTarget(null); setNotice(restore ? 'Операция восстановлена.' : 'Операция удалена. Её можно восстановить в настройках.'); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Не удалось изменить запись.'); if (cause instanceof ApiError && cause.status === 409) void refresh(true); }
    finally { setPendingId(null); }
  }
  function openLatest() {
    const latest = records.find(record => record.id === editor?.record?.id);
    if (!latest) { setNotice('Актуальная запись ещё не получена. Обновите данные.'); return; }
    if (latest.deletedAt) { setNotice('Операция удалена другим совладельцем. Её можно восстановить в настройках.'); return; }
    if (!window.confirm('Заменить ввод в форме актуальной записью? Скопируйте нужные изменения перед продолжением.')) return;
    setEditor({ key: ++editorCounter.current, kind: latest.kind, record: latest });
  }
  function addButton(kind: RecordKind, text: string, preset?: Record<string, string>, primary = true) { return <button type="button" className={`button ${primary ? 'primary' : ''}`} onClick={() => open(kind, undefined, preset)}><Plus size={18} />{text}</button>; }
  function recordTitle(record: BakeryRecord): string {
    switch (record.kind) {
      case 'sale': return record.data.shop;
      case 'purchase': return name(record.data.ingredientId);
      case 'recipe': return name(record.data.productId);
      case 'shift': case 'wagePayment': return name(record.data.employeeId);
      case 'expense': return record.data.category;
      case 'cashMovement': return `${record.data.direction === 'in' ? 'Вложение' : 'Снятие'}${record.data.owner ? ` · ${record.data.owner}` : ''}`;
      default: return record.data.name;
    }
  }
  function recordDescription(record: BakeryRecord): ReactNode {
    switch (record.kind) {
      case 'sale': return <>{record.data.lines.map((line, index) => <span key={index} className="record-line">{name(line.productId)} · {numberFormat.format(line.quantity)} шт. × {money(line.unitPriceKopecks)}</span>)}<small>Оплачено наличными</small></>;
      case 'purchase': return <>{numberFormat.format(record.data.quantity)} {units[record.data.unit]} × {money(record.data.unitPriceKopecks)}{record.data.unit === 'pack' && <small>В упаковке: {record.data.packQuantity} {record.data.packUnit ? units[record.data.packUnit] : ''}</small>}</>;
      case 'shift': return <>Ставка {money(record.data.rateKopecks)} · премия {money(record.data.bonusKopecks)}<small>Начислено за выход</small></>;
      case 'wagePayment': return 'Фактически выплачено из кассы';
      case 'expense': return <>Оплачено {dateLabel(record.data.date)}{record.data.recognitionDate && <small>В прибыли: {dateLabel(record.data.recognitionDate)}</small>}</>;
      case 'cashMovement': return 'На прибыль не влияет';
      case 'recipe': return record.data.lines.map(line => `${name(line.ingredientId)} ${line.quantity} ${units[line.unit]}`).join(', ');
      default: return '';
    }
  }
  function ledger(items: BakeryRecord[], empty: string) {
    if (!items.length) return <Empty>{empty}</Empty>;
    return <div className="records-list">{items.map(record => <article className="record-row" key={record.id}>
      <div className="record-date">{dateLabel(recordDate(record))}<small>{kindNames[record.kind]}</small></div>
      <div className="record-main"><h3>{recordTitle(record)}</h3><div className="record-description">{recordDescription(record)}</div>{'note' in record.data && record.data.note && <p className="record-note">{record.data.note}</p>}<details className="audit"><summary>История записи</summary><p>Создано: {new Date(record.createdAt).toLocaleString('ru-RU')} · {record.createdBy}</p><p>Изменено: {new Date(record.updatedAt).toLocaleString('ru-RU')} · {record.updatedBy}</p></details></div>
      <div className="record-end">{amountFor(record) != null && <strong className={record.kind === 'cashMovement' && record.data.direction === 'in' ? 'positive' : ''}>{record.kind === 'cashMovement' ? (record.data.direction === 'in' ? '+' : '−') : ''}{money(amountFor(record)!)}</strong>}<div className="actions"><button type="button" className="icon-button" title="Изменить" aria-label={`Изменить: ${recordTitle(record)}`} onClick={() => open(record.kind, record)}><Pencil size={17} /></button><button type="button" className="icon-button danger" title="Удалить" aria-label={`Удалить: ${recordTitle(record)}`} onClick={() => { setDeleteTarget(record); setActionError(''); }}><Trash2 size={17} /></button></div></div>
    </article>)}</div>;
  }
  function summary() {
    return <>
      <div className="money-strip"><Metric label="Получено от магазинов" value={money(report.revenueKopecks)} note="Продажи за выбранный период" /><Metric label="Потрачено из кассы" value={money(report.cashOutflowKopecks)} note="С учётом снятий владельцев" /><Metric label="Изменение кассы" value={money(report.cashDeltaKopecks)} positive={report.cashDeltaKopecks >= 0} note="Приходы минус выплаты за период" /></div>
      <section className="profit-panel"><div><h2>Расчётная прибыль за период</h2><strong className="profit-number">{report.profitKopecks == null ? 'Расчёт неполный' : money(report.profitKopecks)}</strong><p>Продажи минус сырьё в проданной выпечке, начисленная зарплата и расходы периода.</p></div><div className="profit-split"><span className="status">Доли 50 / 50</span><strong>{report.profitKopecks == null ? 'Доли пока не рассчитаны' : `${money(Math.round(report.profitKopecks / 2))} каждому`}</strong><small>Доля прибыли не означает выплату или свободные деньги в кассе.</small></div></section>
      {report.missing.length > 0 && <section className="warning-panel"><h2>Нужно дополнить расчёт</h2><p>Есть продажи без полной стоимости сырья. Известная часть сырья: {money(report.knownMaterialCostKopecks)}.</p><ul>{report.missing.map(item => <li key={item.productId}><strong>{item.name}</strong> · {item.quantity} шт. — {item.issues.join('; ')}</li>)}</ul><button type="button" className="button" onClick={() => setView('recipes')}>Открыть рецептуры<ChevronRight size={17} /></button></section>}
      <section className="section"><div className="section-heading"><h2>Из чего складывается результат</h2>{addButton('sale', 'Добавить накладную')}</div><ul className="ledger-totals"><li><span>Продажи</span><strong className="positive">{money(report.revenueKopecks)}</strong></li><li><span>Расчётное сырьё в проданных изделиях</span><strong>{report.materialCostKopecks == null ? 'Неполный расчёт' : money(report.materialCostKopecks)}</strong></li><li><span>Начислено за выходы и премии</span><strong>{money(report.wagesAccruedKopecks)}</strong></li><li><span>Прочие расходы периода</span><strong>{money(report.otherExpenseKopecks)}</strong></li></ul><p className="hint">Закупки уменьшают кассу. В прибыли учитывается только расчётная стоимость сырья в проданной выпечке.</p></section>
      <section className="section"><div className="section-heading"><h2>Движение денег</h2><span className="period-caption">{dateLabel(from)} — {dateLabel(to)}</span></div><ul className="ledger-totals"><li><span>Оплачено сырьё</span><strong>{money(report.purchasesPaidKopecks)}</strong></li><li><span>Выплачено сотрудникам</span><strong>{money(report.wagesPaidKopecks)}</strong></li><li><span>Оплачено прочих расходов</span><strong>{money(report.expensesPaidKopecks)}</strong></li><li><span>Вложения владельцев</span><strong>{money(report.ownerInKopecks)}</strong></li><li><span>Снятия владельцев</span><strong>{money(report.ownerOutKopecks)}</strong></li><li><span>Долг по зарплате на конец периода</span><strong>{money(report.owedWagesKopecks)}</strong></li></ul></section>
      <section className="section"><h2>Продано по изделиям</h2>{report.products.length ? <div className="product-report">{report.products.map(item => <div key={item.productId}><div><strong>{item.name}</strong><small>{numberFormat.format(item.quantity)} шт. · сырьё {item.materialCostKopecks == null ? 'не рассчитано' : money(item.materialCostKopecks)}</small></div><strong>{money(item.revenueKopecks)}</strong></div>)}</div> : <Empty>Продаж за этот период пока нет. Добавьте первую накладную.</Empty>}</section>
      <div className="actions quick-actions">{addButton('purchase', 'Записать закупку', undefined, false)}{addButton('shift', 'Отметить выход', undefined, false)}{addButton('expense', 'Добавить расход', undefined, false)}</div>
    </>;
  }
  function catalogRows(kind: 'product' | 'ingredient' | 'employee') {
    const catalogs = kind === 'product' ? products : kind === 'ingredient' ? ingredients : employees;
    return <div className="catalog-list">{catalogs.map(record => <div className="catalog-row" key={record.id}><div><strong>{record.data.name}</strong>{record.data.archived && <span className="archive-tag">В архиве</span>}<small>{record.kind === 'product' ? `${money(record.data.salePriceKopecks)} за штуку` : record.kind === 'employee' ? `${money(record.data.shiftRateKopecks)} за выход` : record.data.initialPriceKopecks == null ? 'Начальная цена не указана' : `${money(record.data.initialPriceKopecks)}${record.data.initialUnit ? ` / ${units[record.data.initialUnit]}` : ' · единица не уточнена'} с ${dateLabel(record.data.initialPriceDate)}`}</small></div><button type="button" className="button" onClick={() => open(kind, record)}><Pencil size={16} />Изменить</button></div>)}</div>;
  }
  function recipesView() {
    return <>
      <section className="info-note"><BookOpen size={21} /><p>Расчёт на <strong>{dateLabel(to)}</strong> по действующей рецептуре и последней известной закупочной цене. Это оценка: потери и остатки партий здесь не учитываются.</p></section>
      <div className="section-heading"><h2>Состав на одно изделие</h2><div className="actions">{addButton('product', 'Добавить изделие', undefined, false)}{addButton('recipe', 'Новая рецептура')}</div></div>
      <div className="recipe-products">{products.filter(product => !product.data.archived).map(product => {
        const cost = costForProduct(product.id, to, records);
        const versions = ofKind(live, 'recipe').filter(recipe => recipe.data.productId === product.id).sort((a, b) => b.data.effectiveFrom.localeCompare(a.data.effectiveFrom));
        const current = versions.find(recipe => recipe.id === cost.recipeId);
        return <article className="recipe-product" key={product.id}><div className="recipe-product-top"><div><h3>{product.data.name}</h3><small>Продажа {money(product.data.salePriceKopecks)} за шт.</small></div><div className="recipe-amount"><strong>{cost.unitCostKopecks == null ? 'Не рассчитано' : money(cost.unitCostKopecks)}</strong><small>Сырьё на 1 шт.</small></div><button type="button" className="button" onClick={() => current ? open('recipe', current) : open('recipe', undefined, { productId: product.id })}><Pencil size={17} />{current ? 'Изменить состав' : 'Заполнить состав'}</button></div><p className="recipe-description">{current ? `С ${dateLabel(current.data.effectiveFrom)}: ${current.data.lines.map(line => `${name(line.ingredientId)} ${numberFormat.format(line.quantity)} ${units[line.unit]}`).join(', ')}` : 'Действующая рецептура не заполнена.'}</p>{cost.issues.length > 0 && <ul className="cost-issues">{cost.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}<details className="recipe-history"><summary>Версии рецептуры ({versions.length})</summary><p className="hint">Новая версия сохраняет прежний состав для прошлых дат.</p>{versions.map(recipe => <div className="version-row" key={recipe.id}><span>Действует с {dateLabel(recipe.data.effectiveFrom)}</span><div className="actions"><button type="button" className="text-button" onClick={() => open('recipe', recipe)}>Изменить</button><button type="button" className="icon-button danger" aria-label={`Удалить рецептуру ${product.data.name} от ${recipe.data.effectiveFrom}`} onClick={() => { setDeleteTarget(recipe); setActionError(''); }}><Trash2 size={17} /></button></div></div>)}<button type="button" className="text-button" onClick={() => open('recipe', undefined, { productId: product.id })}>Добавить версию с новой даты</button></details></article>;
      })}</div>
      <details className="catalog-section"><summary>Изделия и цены продажи</summary>{catalogRows('product')}</details>
    </>;
  }
  function staffView() {
    return <><div className="mini-summary"><Metric label="Начислено за период" value={money(report.wagesAccruedKopecks)} /><Metric label="Выплачено за период" value={money(report.wagesPaidKopecks)} /><Metric label="Долг на конец периода" value={money(report.owedWagesKopecks)} /></div><div className="section-heading"><h2>Команда пекарни</h2>{addButton('employee', 'Добавить сотрудника')}</div><div className="people">{employees.filter(employee => !employee.data.archived).map(employee => {
      const shifts = ofKind(periodRecords, 'shift').filter(shift => shift.data.employeeId === employee.id);
      const paid = ofKind(periodRecords, 'wagePayment').filter(payment => payment.data.employeeId === employee.id).reduce((sum, payment) => sum + payment.data.amountKopecks, 0);
      const accrued = shifts.reduce((sum, shift) => sum + shift.data.rateKopecks + shift.data.bonusKopecks, 0);
      const allAccrued = ofKind(live, 'shift').filter(shift => shift.data.employeeId === employee.id && shift.data.date <= to).reduce((sum, shift) => sum + shift.data.rateKopecks + shift.data.bonusKopecks, 0);
      const allPaid = ofKind(live, 'wagePayment').filter(payment => payment.data.employeeId === employee.id && payment.data.date <= to).reduce((sum, payment) => sum + payment.data.amountKopecks, 0);
      return <article className="person" key={employee.id}><div className="person-top"><div className="person-name"><span className="avatar">{employee.data.name.slice(0, 1)}</span><div><h3>{employee.data.name}</h3><small>{money(employee.data.shiftRateKopecks)} за выход</small></div></div><button type="button" className="icon-button" aria-label={`Изменить сотрудника ${employee.data.name}`} onClick={() => open('employee', employee)}><Pencil size={18} /></button></div><div className="person-details"><span>Выходов за период: <strong>{shifts.length}</strong></span><span>Начислено: <strong>{money(accrued)}</strong></span><span>Выплачено: <strong>{money(paid)}</strong></span><span>Осталось выплатить на {dateLabel(to)}: <strong>{money(Math.max(0, allAccrued - allPaid))}</strong></span>{allPaid > allAccrued && <span>Аванс: <strong>{money(allPaid - allAccrued)}</strong></span>}</div><div className="actions">{addButton('shift', 'Отметить выход', { employeeId: employee.id, rateKopecks: String(employee.data.shiftRateKopecks / 100) }, false)}{addButton('wagePayment', 'Записать выплату', { employeeId: employee.id }, false)}</div></article>;
    })}</div><section className="section"><div className="section-heading"><h2>Выходы и выплаты за период</h2><div className="actions">{addButton('shift', 'Выход', undefined, false)}{addButton('wagePayment', 'Выплата', undefined, false)}</div></div>{ledger(periodRecords.filter(record => record.kind === 'shift' || record.kind === 'wagePayment'), 'Пока нет выходов и выплат. Отметьте фактический выход сотрудника.')}</section><details className="catalog-section"><summary>Все сотрудники, включая архив</summary>{catalogRows('employee')}</details></>;
  }
  async function backup() { if (backupBusy) return; setBackupBusy(true); setActionError(''); try { await downloadBackup(); setNotice('Резервная копия выгружена.'); } catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Не удалось выгрузить копию.'); } finally { setBackupBusy(false); } }
  function settingsView() {
    const deleted = records.filter(record => record.deletedAt && !catalogKinds.has(record.kind)).sort((a, b) => b.deletedAt!.localeCompare(a.deletedAt!));
    return <><section className="settings-section"><h2>Общий учёт</h2><div className="account-panel"><span className="avatar">{bootstrap?.user.name?.slice(0, 1) || 'В'}</span><div><strong>{bootstrap?.user.name || 'Владелец'}</strong><p>{bootstrap?.user.email}</p><small>Текущий пользователь · вход по почте и паролю</small></div></div><p className="hint">Записи хранятся в общей базе. Изменения другого совладельца подгружаются при возврате в окно и примерно каждые 30 секунд. Доступ ограничен разрешёнными пользователями.</p><p className="hint">Второй владелец создаёт свой вход с отдельным паролем. Его подтверждённой почте нужно выдать доступ к общей базе пекарни.</p><div className="actions"><button type="button" className="button" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={17} className={refreshing ? 'spin' : ''} />Обновить данные</button><button type="button" className="button" disabled={signingOut || formSaving} onClick={() => void leave()}><LogOut size={17} />{signingOut ? 'Выходим…' : 'Выйти из учёта'}</button></div></section><section className="settings-section"><div className="section-heading"><div><h2>Резервная копия</h2><p className="hint">Все справочники, операции и удалённые записи в JSON.</p></div><button type="button" className="button primary" onClick={() => void backup()} disabled={backupBusy}><Download size={18} />{backupBusy ? 'Выгружаем…' : 'Скачать копию'}</button></div></section><section className="settings-section"><div className="section-heading"><h2>Справочники</h2></div><details className="catalog-section"><summary>Сырьё ({ingredients.length})</summary>{catalogRows('ingredient')}{addButton('ingredient', 'Добавить сырьё', undefined, false)}</details><details className="catalog-section"><summary>Изделия ({products.length})</summary>{catalogRows('product')}{addButton('product', 'Добавить изделие', undefined, false)}</details><details className="catalog-section"><summary>Сотрудники ({employees.length})</summary>{catalogRows('employee')}{addButton('employee', 'Добавить сотрудника', undefined, false)}</details><p className="hint">Архив скрывает позицию из новых операций и сохраняет прежние продажи и расчёты. Снимите отметку «В архиве», чтобы вернуть её.</p></section><section className="settings-section"><h2><History size={21} />Удалённые операции</h2><p className="hint">Восстановление вернёт операцию в отчёты и пересчитает её даты.</p>{deleted.length ? <div className="deleted-list">{deleted.map(record => <article className="deleted-row" key={record.id}><div><strong>{recordTitle(record)}</strong><small>{kindNames[record.kind]} · {dateLabel(recordDate(record))}{amountFor(record) != null ? ` · ${money(amountFor(record)!)}` : ''}</small></div><button type="button" className="button" disabled={pendingId === record.id} onClick={() => void deleteOrRestore(record, true)}><History size={17} />{pendingId === record.id ? 'Восстанавливаем…' : 'Восстановить'}</button></article>)}</div> : <Empty>Удалённых операций нет.</Empty>}</section></>;
  }
  function content() {
    if (!validPeriod && view !== 'settings') return <div className="form-error" role="alert">Укажите обе даты: начало периода должно быть раньше или равно окончанию.</div>;
    switch (view) {
      case 'summary': return summary();
      case 'sales': return <><div className="section-heading"><p className="hint">В одной накладной может быть несколько изделий. Цены сохраняются в каждой строке.</p>{addButton('sale', 'Добавить накладную')}</div>{ledger(periodRecords.filter(record => record.kind === 'sale'), 'Продаж за период пока нет. Добавьте накладную магазина.')}<div className="total-row"><span>Получено наличными</span><strong>{money(report.revenueKopecks)}</strong></div></>;
      case 'purchases': return <><div className="section-heading"><p className="hint">Закупки оплачены из кассы. Укажите фактическое количество и цену за выбранную единицу.</p>{addButton('purchase', 'Записать закупку')}</div>{ledger(periodRecords.filter(record => record.kind === 'purchase'), 'Закупок за период пока нет. Запишите покупку сырья.')}<div className="total-row"><span>Оплачено сырьё</span><strong>{money(report.purchasesPaidKopecks)}</strong></div><section className="section"><div className="section-heading"><h2>Сырьё и цены на {dateLabel(to)}</h2>{addButton('ingredient', 'Добавить сырьё', undefined, false)}</div><div className="catalog-list">{ingredients.filter(ingredient => !ingredient.data.archived).map(ingredient => { const quote = quoteFor(ingredient.id, to, records); return <div className="catalog-row" key={ingredient.id}><div><strong>{ingredient.data.name}</strong><small>{quote.label}</small>{quote.issue && <small className="warning-text">{quote.issue}</small>}</div><button type="button" className="button" onClick={() => open('ingredient', ingredient)}><Pencil size={16} />Изменить</button></div>; })}</div><p className="hint">Неуточнённые цены и единицы не подставляются автоматически. Масса и объём между собой не переводятся.</p></section></>;
      case 'recipes': return recipesView();
      case 'staff': return staffView();
      case 'expenses': return <><div className="section-heading"><p className="hint">Начисление и выплата зарплаты — в разделе «Сотрудники».</p>{addButton('expense', 'Добавить расход')}</div>{ledger(periodRecords.filter(record => record.kind === 'expense'), 'Оплаченных расходов за период пока нет.')}<div className="total-row"><span>Оплачено за период</span><strong>{money(report.expensesPaidKopecks)}</strong></div><p className="hint">В прибыли периода учтено {money(report.otherExpenseKopecks)} по дате признания расхода.</p></>;
      case 'cash': return <><div className="mini-summary"><Metric label="Вложено за период" value={money(report.ownerInKopecks)} /><Metric label="Снято за период" value={money(report.ownerOutKopecks)} /><Metric label="Изменение кассы по всем операциям" value={money(report.cashDeltaKopecks)} /></div><div className="section-heading"><p className="hint">Движения владельцев не меняют прибыль и не считаются автоматической выплатой доли.</p>{addButton('cashMovement', 'Добавить движение')}</div>{ledger(periodRecords.filter(record => record.kind === 'cashMovement'), 'Движений владельцев за период пока нет.')}</>;
      case 'settings': return settingsView();
    }
  }
  if (!bootstrap) return <main className="loading-screen"><Wheat size={36} /><h1>Своя пекарня</h1><p>{connectionError || 'Открываем общий учёт…'}</p>{connectionError && <button className="button primary" type="button" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={18} />Повторить</button>}<button className="text-button" type="button" disabled={signingOut} onClick={() => void leave()}>Выйти и сменить аккаунт</button></main>;
  return <div className="bakery-app"><a href="#main-content" className="skip-link">Перейти к содержимому</a><div className="app-shell"><aside className="sidebar"><a className="brand" href="#main-content" onClick={() => setView('summary')}><Wheat size={29} /><div>Своя пекарня<small>Ежедневный учёт</small></div></a><nav aria-label="Разделы пекарни">{navigation.map(item => { const Icon = item.icon; return <button key={item.id} type="button" aria-current={view === item.id ? 'page' : undefined} onClick={() => { setView(item.id); setActionError(''); }}><Icon size={19} /><span>{item.label}</span></button>; })}</nav><div className="owners"><div className="owner-avatars"><span>1</span><span>2</span></div><div>Два совладельца<small>Общий учёт пекарни</small></div></div></aside>
      <main className="main" id="main-content"><header className="page-header"><div><h1>{currentNav.label === 'Сводка' ? 'Сводка пекарни' : currentNav.label}</h1><p>{currentNav.subtitle}</p></div><button type="button" className="button refresh-button" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={17} className={refreshing ? 'spin' : ''} /><span>{refreshing ? 'Обновляем…' : 'Обновить'}</span></button></header>
        {view !== 'settings' && <section className="period-bar" aria-label="Период отчёта"><div className="period-fields"><label>С<input type="date" aria-label="Начало периода" value={from} onChange={event => setFrom(event.target.value)} required /></label><label>По<input type="date" aria-label="Конец периода" value={to} onChange={event => setTo(event.target.value)} required /></label></div><div className="period-presets"><button className="text-button" type="button" onClick={() => { const today = todayMoscow(); setFrom(today); setTo(today); }}>Сегодня</button><button className="text-button" type="button" onClick={() => { const today = todayMoscow(); setFrom(`${today.slice(0, 7)}-01`); setTo(today); }}>Этот месяц</button></div></section>}
        {connectionError && <div className="connection-error" role="alert"><p>{connectionError} Показаны последние полученные данные.</p><button className="text-button" type="button" onClick={() => void refresh()}>Повторить</button></div>}
        {notice && <div className="notice" role="status"><Check size={18} /><span>{notice}</span><button className="icon-button" aria-label="Скрыть уведомление" type="button" onClick={() => setNotice('')}><X size={16} /></button></div>}
        {actionError && !deleteTarget && <div className="form-error" role="alert">{actionError}</div>}
        <div ref={formRef} className="form-anchor">{editor && <RecordForm key={editor.key} kind={editor.kind} record={editor.record} preset={editor.preset} records={records} date={to} onSave={save} onClose={closeEditor} onReload={() => refresh()} onOpenLatest={openLatest} />}</div>
        <div className="page-content">{content()}</div><footer>Расчётная себестоимость по рецептурам и последним ценам на дату продажи. Данные обновлены: {new Date(bootstrap.serverTime).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}.</footer>
      </main></div>
      {deleteTarget && <div className="dialog-backdrop" onClick={event => { if (event.target === event.currentTarget && !pendingId) setDeleteTarget(null); }}><section ref={deleteDialogRef} role="dialog" aria-modal="true" aria-labelledby="delete-title" className="confirm-dialog" onKeyDown={event => { if (event.key === 'Escape' && !pendingId) { event.preventDefault(); setDeleteTarget(null); } if (event.key === 'Tab') { const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')); const first = buttons[0]; const last = buttons[buttons.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } }}><h2 id="delete-title">Удалить операцию?</h2><p><strong>{recordTitle(deleteTarget)}</strong> · {dateLabel(recordDate(deleteTarget))}</p><p>Она исчезнет из отчётов. Восстановить её можно в настройках. Связанные даты будут пересчитаны.</p>{actionError && <p className="error-text" role="alert">{actionError}</p>}<div className="actions"><button type="button" className="button" disabled={!!pendingId} onClick={() => setDeleteTarget(null)}>Отмена</button><button type="button" className="button delete-button" disabled={!!pendingId} onClick={() => void deleteOrRestore(deleteTarget)}><Trash2 size={17} />{pendingId ? 'Удаляем…' : 'Удалить'}</button></div></section></div>}
    </div>;
}


