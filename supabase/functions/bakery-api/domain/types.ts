export type RecipeUnit = 'g' | 'ml' | 'pcs';
export type BasePurchaseUnit = 'kg' | 'g' | 'l' | 'ml' | 'pcs';
export type PurchaseUnit = BasePurchaseUnit | 'pack';
export interface IngredientData { name: string; archived?: boolean; initialPriceKopecks: number | null; initialUnit: PurchaseUnit | null; initialPriceDate: string; }
export interface ProductData { name: string; salePriceKopecks: number; archived?: boolean; }
export interface EmployeeData { name: string; shiftRateKopecks: number; archived?: boolean; }
export interface PurchaseData { date: string; ingredientId: string; quantity: number; unit: PurchaseUnit; unitPriceKopecks: number; packQuantity?: number; packUnit?: BasePurchaseUnit; note?: string; }
export interface SaleLine { productId: string; quantity: number; unitPriceKopecks: number; }
export interface SaleData { date: string; shop: string; lines: SaleLine[]; note?: string; }
export interface RecipeLine { ingredientId: string; quantity: number; unit: RecipeUnit; }
export interface RecipeData { productId: string; effectiveFrom: string; lines: RecipeLine[]; }
export interface ShiftData { date: string; employeeId: string; rateKopecks: number; bonusKopecks: number; note?: string; }
export interface WagePaymentData { date: string; employeeId: string; amountKopecks: number; note?: string; }
export interface ExpenseData { date: string; recognitionDate?: string; category: string; amountKopecks: number; note?: string; }
export interface CashMovementData { date: string; direction: 'in' | 'out'; owner: string; amountKopecks: number; note?: string; }
export interface DataByKind { ingredient: IngredientData; product: ProductData; employee: EmployeeData; purchase: PurchaseData; sale: SaleData; recipe: RecipeData; shift: ShiftData; wagePayment: WagePaymentData; expense: ExpenseData; cashMovement: CashMovementData; }
export type RecordKind = keyof DataByKind;
export type BakeryRecord<K extends RecordKind = RecordKind> = K extends RecordKind ? { id: string; kind: K; data: DataByKind[K]; revision: number; createdAt: string; updatedAt: string; createdBy: string; updatedBy: string; deletedAt: string | null; } : never;
export interface AppUser { id: string; email: string; name: string; }
export interface Bootstrap { records: BakeryRecord[]; user: AppUser; serverTime: string; }
export interface Quote { perBaseKopecks: number | null; baseUnit: RecipeUnit | null; label: string; sourceDate: string | null; issue?: string; }
export interface IngredientCost { ingredientId: string; name: string; quantity: number; unit: RecipeUnit; amountKopecks: number | null; quoteLabel: string; issue?: string; }
export interface RecipeCost { productId: string; recipeId: string | null; unitCostKopecks: number | null; exactUnitCostKopecks: number | null; ingredients: IngredientCost[]; issues: string[]; }
export interface ProductReport { productId: string; name: string; quantity: number; revenueKopecks: number; materialCostKopecks: number | null; }
export interface MissingCost { productId: string; name: string; quantity: number; issues: string[]; }
export interface Report { from: string; to: string; revenueKopecks: number; materialCostKopecks: number | null; knownMaterialCostKopecks: number; wagesAccruedKopecks: number; wagesPaidKopecks: number; purchasesPaidKopecks: number; otherExpenseKopecks: number; expensesPaidKopecks: number; ownerInKopecks: number; ownerOutKopecks: number; cashInflowKopecks: number; cashOutflowKopecks: number; cashDeltaKopecks: number; profitKopecks: number | null; owedWagesKopecks: number; missing: MissingCost[]; products: ProductReport[]; }
export const RECORD_KINDS: RecordKind[] = ['ingredient','product','employee','purchase','sale','recipe','shift','wagePayment','expense','cashMovement'];
