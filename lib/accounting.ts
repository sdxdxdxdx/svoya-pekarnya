import type { BakeryRecord, IngredientCost, MissingCost, ProductReport, Quote, RecipeCost, RecipeUnit, Report } from './types.ts';

const rubles = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const unitNames: Record<string, string> = { kg: 'кг', g: 'г', l: 'л', ml: 'мл', pcs: 'шт.', pack: 'уп.' };

// Restore a decimal half-kopeck boundary when binary arithmetic lands one ULP below it.
function roundKopecks(value: number): number {
  return Math.round(value + Number.EPSILON * Math.abs(value));
}

export function money(kopecks: number): string {
  return Number.isFinite(kopecks) ? rubles.format(kopecks / 100) : '—';
}

export function todayMoscow(): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function dateLabel(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date.slice(8)}.${date.slice(5, 7)}.${date.slice(0, 4)}` : date;
}

function newest(a: BakeryRecord, b: BakeryRecord): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function conversion(unit: string): { baseUnit: RecipeUnit; factor: number } | null {
  if (unit === 'kg') return { baseUnit: 'g', factor: 1000 };
  if (unit === 'g') return { baseUnit: 'g', factor: 1 };
  if (unit === 'l') return { baseUnit: 'ml', factor: 1000 };
  if (unit === 'ml') return { baseUnit: 'ml', factor: 1 };
  if (unit === 'pcs') return { baseUnit: 'pcs', factor: 1 };
  return null;
}

export function quoteFor(ingredientId: string, date: string, records: BakeryRecord[]): Quote {
  const ingredient = records.find(r => r.id === ingredientId && r.kind === 'ingredient' && !r.deletedAt);
  if (!ingredient || ingredient.kind !== 'ingredient') return { perBaseKopecks: null, baseUnit: null, label: 'Нет сырья', sourceDate: null, issue: 'Сырьё не найдено или удалено.' };
  const name = ingredient.data.name;
  const purchases = records.filter((r): r is BakeryRecord<'purchase'> => r.kind === 'purchase' && !r.deletedAt && r.data.ingredientId === ingredientId && r.data.date <= date);
  purchases.sort((a, b) => a.data.date.localeCompare(b.data.date) || newest(a, b));
  const purchase = purchases.at(-1);
  const sourceDate = purchase?.data.date ?? (ingredient.data.initialPriceDate <= date ? ingredient.data.initialPriceDate : null);
  const price = purchase?.data.unitPriceKopecks ?? (sourceDate ? ingredient.data.initialPriceKopecks : null);
  const unit = purchase?.data.unit ?? ingredient.data.initialUnit;
  const missing = (issue: string): Quote => ({ perBaseKopecks: null, baseUnit: null, label: 'Цена не определена', sourceDate, issue: `${name}: ${issue}` });
  if (price === null || !Number.isFinite(price) || price < 0) return missing('нет цены на выбранную дату.');
  if (!unit) return missing('уточните единицу начальной цены.');
  if (unit === 'pack') {
    const amount = purchase?.data.packQuantity;
    const contents = purchase?.data.packUnit ? conversion(purchase.data.packUnit) : null;
    if (!amount || !Number.isFinite(amount) || amount <= 0 || !contents) return missing('укажите содержимое упаковки и его единицу.');
    return { perBaseKopecks: price / (amount * contents.factor), baseUnit: contents.baseUnit, sourceDate, label: `${money(price)} / уп. (${amount} ${unitNames[purchase!.data.packUnit!]})` };
  }
  const converted = conversion(unit);
  if (!converted) return missing('неподходящая единица цены.');
  return { perBaseKopecks: price / converted.factor, baseUnit: converted.baseUnit, sourceDate, label: `${money(price)} / ${unitNames[unit]}` };
}

interface CostDetails { cost: RecipeCost; knownExactKopecks: number; }

function recipeDetails(productId: string, date: string, records: BakeryRecord[]): CostDetails {
  const base: RecipeCost = { productId, recipeId: null, unitCostKopecks: null, exactUnitCostKopecks: null, ingredients: [], issues: [] };
  const product = records.find(r => r.kind === 'product' && r.id === productId && !r.deletedAt);
  if (!product) return { cost: { ...base, issues: ['Изделие не найдено или удалено.'] }, knownExactKopecks: 0 };
  const recipes = records.filter((r): r is BakeryRecord<'recipe'> => r.kind === 'recipe' && !r.deletedAt && r.data.productId === productId && r.data.effectiveFrom <= date);
  recipes.sort((a, b) => a.data.effectiveFrom.localeCompare(b.data.effectiveFrom) || newest(a, b));
  const recipe = recipes.at(-1);
  if (!recipe || recipe.data.lines.length === 0) return { cost: { ...base, issues: ['Нет действующей рецептуры на выбранную дату.'] }, knownExactKopecks: 0 };
  let knownExactKopecks = 0;
  const issues: string[] = [];
  const ingredients: IngredientCost[] = recipe.data.lines.map(line => {
    const ingredient = records.find(r => r.id === line.ingredientId && r.kind === 'ingredient' && !r.deletedAt);
    const name = ingredient?.kind === 'ingredient' ? ingredient.data.name : 'Удалённое сырьё';
    const quote = quoteFor(line.ingredientId, date, records);
    let issue = quote.issue;
    let exact: number | null = null;
    if (!issue && quote.baseUnit !== line.unit) issue = `${name}: единица рецептуры ${unitNames[line.unit]} несовместима с единицей цены ${unitNames[quote.baseUnit ?? ''] ?? 'не указана'}.`;
    if (!issue && quote.perBaseKopecks !== null) {
      exact = line.quantity * quote.perBaseKopecks;
      if (!Number.isFinite(exact) || !Number.isFinite(line.quantity) || line.quantity <= 0) {
        exact = null;
        issue = `${name}: некорректное количество или стоимость.`;
      }
    }
    if (exact !== null) knownExactKopecks += exact;
    if (issue) issues.push(issue);
    return { ingredientId: line.ingredientId, name, quantity: line.quantity, unit: line.unit, amountKopecks: exact === null ? null : roundKopecks(exact), quoteLabel: quote.label, ...(issue ? { issue } : {}) };
  });
  const complete = issues.length === 0 && ingredients.every(i => i.amountKopecks !== null);
  return { knownExactKopecks, cost: { productId, recipeId: recipe.id, unitCostKopecks: complete ? roundKopecks(knownExactKopecks) : null, exactUnitCostKopecks: complete ? knownExactKopecks : null, ingredients, issues: [...new Set(issues)] } };
}

export function costForProduct(productId: string, date: string, records: BakeryRecord[]): RecipeCost {
  return recipeDetails(productId, date, records).cost;
}

export function calculateReport(records: BakeryRecord[], from: string, to: string): Report {
  const active = records.filter(r => !r.deletedAt);
  const within = (date: string) => date >= from && date <= to;
  const report: Report = { from, to, revenueKopecks: 0, materialCostKopecks: 0, knownMaterialCostKopecks: 0, wagesAccruedKopecks: 0, wagesPaidKopecks: 0, purchasesPaidKopecks: 0, otherExpenseKopecks: 0, expensesPaidKopecks: 0, ownerInKopecks: 0, ownerOutKopecks: 0, cashInflowKopecks: 0, cashOutflowKopecks: 0, cashDeltaKopecks: 0, profitKopecks: 0, owedWagesKopecks: 0, missing: [], products: [] };
  const products = new Map<string, ProductReport & { exactCost: number }>();
  const missing = new Map<string, MissingCost>();
  const employeeAccruals = new Map<string, number>();
  const employeePayments = new Map<string, number>();
  let exactKnown = 0;
  for (const record of active) {
    if (record.kind === 'sale' && within(record.data.date)) {
      for (const line of record.data.lines) {
        const catalog = active.find(r => r.kind === 'product' && r.id === line.productId);
        const name = catalog?.kind === 'product' ? catalog.data.name : 'Удалённое изделие';
        const product = products.get(line.productId) ?? { productId: line.productId, name, quantity: 0, revenueKopecks: 0, materialCostKopecks: 0, exactCost: 0 };
        const revenue = roundKopecks(line.quantity * line.unitPriceKopecks);
        report.revenueKopecks += revenue;
        product.revenueKopecks += revenue;
        product.quantity += line.quantity;
        const detail = recipeDetails(line.productId, record.data.date, active);
        exactKnown += detail.knownExactKopecks * line.quantity;
        if (detail.cost.exactUnitCostKopecks === null) {
          report.materialCostKopecks = null;
          product.materialCostKopecks = null;
          const item = missing.get(line.productId) ?? { productId: line.productId, name, quantity: 0, issues: [] };
          item.quantity += line.quantity;
          item.issues = [...new Set([...item.issues, ...detail.cost.issues])];
          missing.set(line.productId, item);
        } else product.exactCost += detail.cost.exactUnitCostKopecks * line.quantity;
        products.set(line.productId, product);
      }
    } else if (record.kind === 'shift') {
      const accrual = record.data.rateKopecks + record.data.bonusKopecks;
      if (within(record.data.date)) report.wagesAccruedKopecks += accrual;
      if (record.data.date <= to) employeeAccruals.set(record.data.employeeId, (employeeAccruals.get(record.data.employeeId) ?? 0) + accrual);
    } else if (record.kind === 'wagePayment') {
      if (within(record.data.date)) report.wagesPaidKopecks += record.data.amountKopecks;
      if (record.data.date <= to) employeePayments.set(record.data.employeeId, (employeePayments.get(record.data.employeeId) ?? 0) + record.data.amountKopecks);
    } else if (record.kind === 'purchase' && within(record.data.date)) report.purchasesPaidKopecks += roundKopecks(record.data.quantity * record.data.unitPriceKopecks);
    else if (record.kind === 'expense') {
      if (within(record.data.recognitionDate ?? record.data.date)) report.otherExpenseKopecks += record.data.amountKopecks;
      if (within(record.data.date)) report.expensesPaidKopecks += record.data.amountKopecks;
    } else if (record.kind === 'cashMovement' && within(record.data.date)) {
      if (record.data.direction === 'in') report.ownerInKopecks += record.data.amountKopecks;
      else report.ownerOutKopecks += record.data.amountKopecks;
    }
  }
  report.knownMaterialCostKopecks = roundKopecks(exactKnown);
  if (report.materialCostKopecks !== null) report.materialCostKopecks = report.knownMaterialCostKopecks;
  report.profitKopecks = report.materialCostKopecks === null ? null : report.revenueKopecks - report.materialCostKopecks - report.wagesAccruedKopecks - report.otherExpenseKopecks;
  report.cashInflowKopecks = report.revenueKopecks + report.ownerInKopecks;
  report.cashOutflowKopecks = report.purchasesPaidKopecks + report.wagesPaidKopecks + report.expensesPaidKopecks + report.ownerOutKopecks;
  report.cashDeltaKopecks = report.cashInflowKopecks - report.cashOutflowKopecks;
  for (const [employeeId, accrued] of employeeAccruals) report.owedWagesKopecks += Math.max(0, accrued - (employeePayments.get(employeeId) ?? 0));
  report.products = [...products.values()].map(({ exactCost, ...product }) => ({ ...product, materialCostKopecks: product.materialCostKopecks === null ? null : roundKopecks(exactCost) }));
  report.missing = [...missing.values()];
  return report;
}
