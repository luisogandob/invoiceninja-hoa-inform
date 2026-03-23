import { parseISO, isBefore, isAfter, isEqual, differenceInDays } from 'date-fns';
import type { Invoice, Payment, Expense, Client, ClientGroup } from './invoiceNinjaClient.js';

/**
 * Aggregated data needed to build the HOA income report.
 */
export interface HoaReportData {
  /** Report title */
  title: string;
  /** ISO date string for the first day of the period */
  periodStart: string;
  /** ISO date string for the last day of the period */
  periodEnd: string;
  /** Date the report was generated */
  generatedAt: Date;

  /** Total amount on invoices issued during the period (cuotas emitidas) */
  totalInvoicedInPeriod: number;
  /** Total payments received during the period */
  totalPaymentsInPeriod: number;
  /** Total expenses registered during the period */
  totalExpensesInPeriod: number;
  /**
   * Total of ALL expenses (from any date) whose payment_date falls within the period.
   * This is the sum that appears as the sub-line on the Gastos KPI card.
   */
  totalExpensesPaidInPeriod: number;
  /** Accounts receivable at the START of the period */
  arAtPeriodStart: number;
  /** Accounts receivable at the END of the period */
  arAtPeriodEnd: number;
  /**
   * Accounts payable at the START of the period.
   * Sum of allExpenses where expense.date ≤ periodStart AND
   * (no payment_date OR payment_date > periodStart).
   */
  apAtPeriodStart: number;
  /**
   * Accounts payable at the END of the period.
   * Sum of allExpenses where expense.date ≤ periodEnd AND
   * (no payment_date OR payment_date > periodEnd).
   * Matches the Invoice Ninja "outstanding expenses" view at period end.
   */
  apAtPeriodEnd: number;

  /** Payments in the period grouped by client group, with aging buckets */
  paymentsByGroup: PaymentsByGroup[];
  /** Accounts receivable at end of period, grouped by client group, with aging buckets */
  arByGroup: ArByGroup[];
  /** Accounts receivable at end of period, grouped by Unidad Vivienda (client.custom_value2) */
  arByUnit: ArByUnit[];
  /**
   * Accounts receivable at end of period, grouped by client group with a per-unit breakdown.
   * Used to render the stacked-by-unit AR bar chart (one column per group, stacked by unit).
   */
  arByGroupUnit: ArByGroupUnit[];

  /**
   * Period expenses grouped by category, sorted by amount descending.
   * Used to render the doughnut chart on the Análisis de Gastos page.
   */
  expensesByCategory: ExpenseByCategory[];

  /**
   * Period expenses grouped by vendor, sorted by amount descending.
   * Used to render the vendor table on the Análisis de Gastos page.
   */
  expensesByVendor: ExpenseByVendor[];

  /**
   * Chronological ledger of all cash inflows (payments) and outflows
   * (expenses paid within the period), sorted by date ascending.
   * Used to render the Flujo de Efectivo page.
   */
  cashFlowEntries: CashFlowEntry[];

  /**
   * Net result from the very beginning of time through the end of the period.
   * Computed as: SUM of all payments ever received (up to periodEnd)
   *              minus SUM of all expenses ever paid (payment_date ≤ periodEnd).
   */
  perpetualResult: number;

  /**
   * Estimated bank balance at the end of the period, pending reconciliation.
   * Computed as: perpetualResult + initialBalance (from INITIAL_BANK_BALANCE env var).
   */
  bankBalance: number;
}

export interface PaymentsByGroup {
  groupName: string;
  /** Sum of all aging buckets */
  total: number;
  /** Payments applied to invoices aged ≤35 days at time of payment (green) */
  aged0_35: number;
  /** Payments applied to invoices aged 36-95 days at time of payment (light orange) */
  aged36_95: number;
  /** Payments applied to invoices aged ≥96 days at time of payment (dark orange) */
  aged96plus: number;
}

export interface ArByGroup {
  groupName: string;
  /** Sum of all aging buckets */
  balance: number;
  /** Outstanding balance on invoices aged <90 days as of period end (orange) */
  aged0_90: number;
  /** Outstanding balance on invoices aged ≥90 days as of period end (red) */
  aged90plus: number;
  /**
   * Outstanding balance from late-fee/mora line items (purple).
   * Currently 0 — mora line-item identification is not yet implemented.
   */
  mora: number;
}

/**
 * Accounts receivable grouped by the client's Unidad Vivienda (custom_value2).
 * Same aging-bucket structure as ArByGroup.
 */
export interface ArByUnit {
  unitName: string;
  /** Sum of all aging buckets */
  balance: number;
  /** Outstanding balance on invoices aged <90 days as of period end (orange) */
  aged0_90: number;
  /** Outstanding balance on invoices aged ≥90 days as of period end (red) */
  aged90plus: number;
  /**
   * Outstanding balance from late-fee/mora line items (purple).
   * Currently 0 — mora line-item identification is not yet implemented.
   */
  mora: number;
}

/**
 * Accounts receivable grouped by client group, with a per-unit breakdown for stacked charting.
 * One entry per client group; byUnit maps each Unidad Vivienda to its outstanding balance.
 */
export interface ArByGroupUnit {
  groupName: string;
  /** Total outstanding balance for this group (sum of byUnit values) */
  balance: number;
  /** Outstanding balance per Unidad Vivienda: unitName → balance */
  byUnit: Record<string, number>;
}

/** Expense total for a single category within the period */
export interface ExpenseByCategory {
  categoryName: string;
  amount: number;
}

/** Expense total for a single vendor within the period */
export interface ExpenseByVendor {
  vendorName: string;
  amount: number;
}

/**
 * A single entry in the cash flow ledger.
 * Payments are inflows (+), expenses paid are outflows (−).
 */
export interface CashFlowEntry {
  type: 'payment' | 'expense';
  /** YYYY-MM-DD — used for chronological sorting and display */
  date: string;
  /** Payment number (e.g. "PAY-0001") for payments, or expense document number */
  number: string;
  /** Client name (payment) or vendor name (expense) */
  name: string;
  amount: number;
  /**
   * For payments: comma-separated "INV-001 $150.00, INV-002 $50.00" invoice/amount list.
   * For expenses: "Categoria • Cliente" middle line (may be empty).
   */
  subLine: string;
  /**
   * For expenses only: public_notes (Notas), third line in description cell.
   * Unused for payment entries.
   */
  subLine2?: string;
}

/** Label used when a client has no group assigned */
const NO_GROUP_LABEL = 'Sin Grupo';

/** Label used when a client has no Unidad Vivienda (custom_value2) set */
const NO_UNIT_LABEL = 'Sin Unidad';

/**
 * Build the HoaReportData from raw Invoice Ninja data.
 *
 * Calculation notes:
 *  - totalInvoicedInPeriod : sum of invoice.amount for invoices issued within the period
 *  - totalPaymentsInPeriod : sum of payment.amount for payments received within the period
 *  - totalExpensesInPeriod        : sum of expense.amount for expenses registered within the period
 *  - totalExpensesPaidInPeriod    : sum of expense.amount for ALL expenses (any date)
 *                                   whose payment_date is within the period
 *  - apAtPeriodEnd                : sum of allExpenses where expense.date ≤ periodEnd AND
 *                                   (!payment_date OR payment_date > periodEnd)
 *  - apAtPeriodStart              : same logic with periodStart boundary
 *  - arAtPeriodEnd         : sum of invoice.balance for every invoice issued on or before
 *                            periodEnd (balance is the current outstanding amount)
 *  - arAtPeriodStart       : derived via accounting identity:
 *                            AR_end = AR_start + Invoiced_in_period − Paid_in_period
 *                            ⟹ AR_start = AR_end − Invoiced_in_period + Paid_in_period
 *
 * @param allInvoices    Every invoice fetched (no date filter) — used to compute AR
 * @param periodInvoices Invoices issued during the report period
 * @param periodPayments Payments received during the report period
 * @param periodExpenses Expenses registered during the report period
 * @param allExpenses    Every expense fetched (no date filter) — used to compute AP
 * @param allClients     All clients (used to resolve client → group)
 * @param clientGroups   All client groups from Invoice Ninja group_settings
 * @param periodStart    Start date of the report period
 * @param periodEnd      End date of the report period
 * @param title          Report title
 * @param generatedAt    Report generation timestamp
 * @param allTimePaymentsTotal     Sum of ALL payments received up to periodEnd (for perpetualResult)
 * @param allTimeExpensesPaidTotal Sum of ALL expenses paid (payment_date ≤ periodEnd) (for perpetualResult)
 * @param initialBalance           Opening/initial bank balance to add to perpetualResult (from INITIAL_BANK_BALANCE env)
 */
export function buildHoaReportData(
  allInvoices: Invoice[],
  periodInvoices: Invoice[],
  periodPayments: Payment[],
  periodExpenses: Expense[],
  allExpenses: Expense[],
  allClients: Client[],
  clientGroups: ClientGroup[],
  periodStart: Date,
  periodEnd: Date,
  title: string,
  generatedAt: Date,
  allTimePaymentsTotal = 0,
  allTimeExpensesPaidTotal = 0,
  initialBalance = 0
): HoaReportData {
  // --- Exclude soft-deleted records from all calculations ---
  // Invoice Ninja soft-deletes records (is_deleted=true) instead of removing them
  // from the API response. We must discard them to match the platform's totals.
  allInvoices    = excludeDeleted(allInvoices);
  periodInvoices = excludeDeleted(periodInvoices);
  periodPayments = excludeDeleted(periodPayments);
  periodExpenses = excludeDeleted(periodExpenses);
  allExpenses    = excludeDeleted(allExpenses);
  allClients     = excludeDeleted(allClients);

  // --- Lookup helpers ---
  // clientById: id → Client
  const clientById = new Map<string, Client>(allClients.map(c => [c.id, c]));
  // clientByName: name → Client (first match; for fallback when client_id is absent)
  const clientByName = new Map<string, Client>(
    allClients.filter(c => c.name).map(c => [c.name, c])
  );
  // groupNameById: group id → group name
  const groupNameById = new Map<string, string>(clientGroups.map(g => [g.id, g.name]));

  /** Resolve a client_id to its group name, falling back through client_name lookup */
  function resolveGroup(clientId: string | undefined, clientName: string | undefined): string {
    if (clientId) {
      const client = clientById.get(clientId);
      if (client?.group_settings_id) {
        return groupNameById.get(client.group_settings_id) ?? NO_GROUP_LABEL;
      }
    }
    // If no client_id, try to find the client by name
    if (clientName) {
      const c = clientByName.get(clientName);
      if (c?.group_settings_id) {
        return groupNameById.get(c.group_settings_id) ?? NO_GROUP_LABEL;
      }
    }
    return NO_GROUP_LABEL;
  }

  /** Resolve a client_id to its Unidad Vivienda (custom_value2), falling back through client_name */
  function resolveUnit(clientId: string | undefined, clientName: string | undefined): string {
    if (clientId) {
      const client = clientById.get(clientId);
      if (client?.custom_value2) return client.custom_value2;
    }
    if (clientName) {
      const c = clientByName.get(clientName);
      if (c?.custom_value2) return c.custom_value2;
    }
    return NO_UNIT_LABEL;
  }

  // --- Totals for the period ---
  const totalInvoicedInPeriod = periodInvoices.reduce(
    (sum, inv) => sum + parseFloat(String(inv.amount || 0)),
    0
  );

  const totalPaymentsInPeriod = periodPayments.reduce(
    (sum, p) => sum + parseFloat(String(p.amount || 0)),
    0
  );

  const totalExpensesInPeriod = periodExpenses.reduce(
    (sum, e) => sum + parseFloat(String(e.amount || 0)),
    0
  );

  // --- Expenses paid within the period ---
  // ALL expenses (regardless of creation date) whose payment_date falls within
  // [periodStart, periodEnd]. This drives the sub-line on the Gastos KPI card.
  const totalExpensesPaidInPeriod = allExpenses
    .filter(e => {
      if (!e.payment_date) return false;
      try {
        const d = parseISO(e.payment_date);
        return !isBefore(d, periodStart) && !isAfter(d, periodEnd);
      } catch { return false; }
    })
    .reduce((sum, e) => sum + parseFloat(String(e.amount || 0)), 0);

  // --- AR at end of period ---
  // All invoices issued on or before the period end date that still carry a balance.
  const invoicesIssuedByPeriodEnd = allInvoices.filter(inv => {
    const dateStr = inv.date || inv.invoice_date;
    if (!dateStr) return false;
    try {
      const d = parseISO(dateStr);
      return isBefore(d, periodEnd) || isEqual(d, periodEnd);
    } catch {
      return false;
    }
  });

  const arAtPeriodEnd = invoicesIssuedByPeriodEnd.reduce(
    (sum, inv) => sum + parseFloat(String(inv.balance || 0)),
    0
  );

  // --- AR at start of period ---
  // Accounting identity: AR_end = AR_start + Invoices_in_period - Payments_in_period
  // => AR_start = AR_end - Invoices_in_period + Payments_in_period
  // Clamped to 0 to guard against edge cases where payments or data gaps would
  // produce a negative result (e.g. period start is before the first invoice).
  const arAtPeriodStart = Math.max(0, arAtPeriodEnd - totalInvoicedInPeriod + totalPaymentsInPeriod);

  // --- Invoice date lookup (for payment aging) ---
  const invoiceDateById = new Map<string, Date>();
  allInvoices.forEach(inv => {
    if (!inv.id) return;
    const dateStr = inv.date || inv.invoice_date;
    if (!dateStr) return;
    try { invoiceDateById.set(inv.id, parseISO(dateStr)); } catch { /* skip malformed */ }
  });

  // --- Payments by client group with aging buckets ---
  interface GroupPayments { aged0_35: number; aged36_95: number; aged96plus: number; }
  const paymentGroupMap: Record<string, GroupPayments> = {};

  periodPayments.forEach(p => {
    const group = resolveGroup(p.client_id, p.client_name || p.client?.name);
    if (!paymentGroupMap[group]) {
      paymentGroupMap[group] = { aged0_35: 0, aged36_95: 0, aged96plus: 0 };
    }

    const paymentDate = (() => {
      const s = p.date || p.payment_date;
      if (!s) return null;
      try { return parseISO(s); } catch { return null; }
    })();

    // Use the full payment amount (p.amount) — not per-paymentable li.amount — so that
    // the sum of all aging buckets equals totalPaymentsInPeriod and matches the platform.
    const paymentAmt = parseFloat(String(p.amount || 0));
    const linkedInvoices = p.paymentables ?? p.invoices;
    if (paymentDate && linkedInvoices && linkedInvoices.length > 0) {
      // Determine aging bucket per linked invoice, then distribute p.amount proportionally.
      const liTotalAmt = linkedInvoices.reduce(
        (s, li) => s + parseFloat(String(li.amount || 0)), 0
      );
      linkedInvoices.forEach(li => {
        const invDate = invoiceDateById.get(li.invoice_id);
        // Proportional share of the FULL payment amount
        const liAmt = parseFloat(String(li.amount || 0));
        const share = liTotalAmt > 0
          ? paymentAmt * (liAmt / liTotalAmt)
          : paymentAmt / linkedInvoices.length;
        const age = invDate ? Math.max(0, differenceInDays(paymentDate, invDate)) : 0;
        if (!invDate || age <= 35) {
          paymentGroupMap[group].aged0_35 += share;
        } else if (age <= 95) {
          paymentGroupMap[group].aged36_95 += share;
        } else {
          paymentGroupMap[group].aged96plus += share;
        }
      });
    } else {
      // No linked-invoice detail → treat full payment as current
      paymentGroupMap[group].aged0_35 += paymentAmt;
    }
  });

  const paymentsByGroup: PaymentsByGroup[] = Object.entries(paymentGroupMap)
    .map(([groupName, b]) => ({
      groupName,
      total: b.aged0_35 + b.aged36_95 + b.aged96plus,
      aged0_35:   b.aged0_35,
      aged36_95:  b.aged36_95,
      aged96plus: b.aged96plus
    }))
    .sort((a, b) => a.groupName.localeCompare(b.groupName));

  // --- AR by client group with aging buckets ---
  interface GroupAR { aged0_90: number; aged90plus: number; mora: number; }
  const arGroupMap: Record<string, GroupAR> = {};

  invoicesIssuedByPeriodEnd.forEach(inv => {
    const balance = parseFloat(String(inv.balance || 0));
    if (balance <= 0) return;
    const group = resolveGroup(inv.client_id, inv.client_name || inv.client?.name);
    if (!arGroupMap[group]) {
      arGroupMap[group] = { aged0_90: 0, aged90plus: 0, mora: 0 };
    }

    const dateStr = inv.date || inv.invoice_date;
    try {
      const invDate = dateStr ? parseISO(dateStr) : null;
      const age = invDate ? Math.max(0, differenceInDays(periodEnd, invDate)) : 0;
      if (age < 90) {
        arGroupMap[group].aged0_90 += balance;
      } else {
        arGroupMap[group].aged90plus += balance;
      }
      // mora = 0: line-item-level late-fee identification is not yet implemented
    } catch {
      arGroupMap[group].aged0_90 += balance; // fallback
    }
  });

  const arByGroup: ArByGroup[] = Object.entries(arGroupMap)
    .map(([groupName, b]) => ({
      groupName,
      balance:    b.aged0_90 + b.aged90plus + b.mora,
      aged0_90:   b.aged0_90,
      aged90plus: b.aged90plus,
      mora:       b.mora
    }))
    .sort((a, b) => a.groupName.localeCompare(b.groupName));

  // --- AR by Unidad Vivienda (client.custom_value2) with aging buckets ---
  interface UnitAR { aged0_90: number; aged90plus: number; mora: number; }
  const arUnitMap: Record<string, UnitAR> = {};

  invoicesIssuedByPeriodEnd.forEach(inv => {
    const balance = parseFloat(String(inv.balance || 0));
    if (balance <= 0) return;
    const unit = resolveUnit(inv.client_id, inv.client_name || inv.client?.name);
    if (!arUnitMap[unit]) {
      arUnitMap[unit] = { aged0_90: 0, aged90plus: 0, mora: 0 };
    }

    const dateStr = inv.date || inv.invoice_date;
    try {
      const invDate = dateStr ? parseISO(dateStr) : null;
      const age = invDate ? Math.max(0, differenceInDays(periodEnd, invDate)) : 0;
      if (age < 90) {
        arUnitMap[unit].aged0_90 += balance;
      } else {
        arUnitMap[unit].aged90plus += balance;
      }
    } catch {
      arUnitMap[unit].aged0_90 += balance; // fallback
    }
  });

  const arByUnit: ArByUnit[] = Object.entries(arUnitMap)
    .map(([unitName, b]) => ({
      unitName,
      balance:    b.aged0_90 + b.aged90plus + b.mora,
      aged0_90:   b.aged0_90,
      aged90plus: b.aged90plus,
      mora:       b.mora
    }))
    .sort((a, b) => a.unitName.localeCompare(b.unitName));

  // --- AR by client group × Unidad Vivienda (for stacked bar chart) ---
  // Accumulates invoice.balance into [groupName][unitName] so the chart can render
  // one column per group with each column stacked by unit.
  const arGroupUnitMap: Record<string, Record<string, number>> = {};

  invoicesIssuedByPeriodEnd.forEach(inv => {
    const balance = parseFloat(String(inv.balance || 0));
    if (balance <= 0) return;
    const group = resolveGroup(inv.client_id, inv.client_name || inv.client?.name);
    const unit  = resolveUnit(inv.client_id, inv.client_name || inv.client?.name);
    if (!arGroupUnitMap[group]) arGroupUnitMap[group] = {};
    arGroupUnitMap[group][unit] = (arGroupUnitMap[group][unit] ?? 0) + balance;
  });

  const arByGroupUnit: ArByGroupUnit[] = Object.entries(arGroupUnitMap)
    .map(([groupName, byUnit]) => ({
      groupName,
      balance: Object.values(byUnit).reduce((s, v) => s + v, 0),
      byUnit
    }))
    .sort((a, b) => a.groupName.localeCompare(b.groupName));

  // --- Accounts payable ---
  //   1. It was created on or before the boundary (expense.date ≤ boundary), AND
  //   2. It has no payment_date (never paid), OR its payment_date is after the boundary.
  // This mirrors the Invoice Ninja "Expenses" outstanding view at a point in time.
  const isExpenseUnpaidAt = (e: Expense, boundary: Date): boolean => {
    const dateStr = e.date;
    if (!dateStr) return false;
    try {
      const expDate = parseISO(dateStr);
      if (isAfter(expDate, boundary)) return false; // created after boundary — not counted yet
      if (!e.payment_date) return true;             // no payment — outstanding
      const payDate = parseISO(e.payment_date);
      return isAfter(payDate, boundary);            // paid after boundary — still outstanding at boundary
    } catch { return false; }
  };

  const apAtPeriodEnd = allExpenses
    .filter(e => isExpenseUnpaidAt(e, periodEnd))
    .reduce((sum, e) => sum + parseFloat(String(e.amount || 0)), 0);

  const apAtPeriodStart = allExpenses
    .filter(e => isExpenseUnpaidAt(e, periodStart))
    .reduce((sum, e) => sum + parseFloat(String(e.amount || 0)), 0);

  // --- Expenses by category (for doughnut chart) ---
  // Group period expenses by their category name, then sort by amount descending.
  const expenseCategoryMap: Record<string, number> = {};
  periodExpenses.forEach(e => {
    const name = e.category_name ?? e.category?.name ?? 'Sin Categoría';
    expenseCategoryMap[name] = (expenseCategoryMap[name] ?? 0) + parseFloat(String(e.amount || 0));
  });
  const expensesByCategory: ExpenseByCategory[] = Object.entries(expenseCategoryMap)
    .map(([categoryName, amount]) => ({ categoryName, amount }))
    .sort((a, b) => b.amount - a.amount);

  // --- Expenses by vendor (for summary table) ---
  // Group period expenses by their vendor name, then sort by amount descending.
  const expenseVendorMap: Record<string, number> = {};
  periodExpenses.forEach(e => {
    const name = e.vendor_name ?? e.vendor?.name ?? 'Sin Suplidor';
    expenseVendorMap[name] = (expenseVendorMap[name] ?? 0) + parseFloat(String(e.amount || 0));
  });
  const expensesByVendor: ExpenseByVendor[] = Object.entries(expenseVendorMap)
    .map(([vendorName, amount]) => ({ vendorName, amount }))
    .sort((a, b) => b.amount - a.amount);

  // --- Cash flow ledger (Flujo de Efectivo) ---
  // Combines payments received and expenses paid within the period,
  // sorted chronologically (ascending by date).

  // Build a lookup: invoice id → invoice number for the sub-line display.
  const invoiceNumberById = new Map<string, string>();
  allInvoices.forEach(inv => {
    if (!inv.id) return;
    invoiceNumberById.set(inv.id, inv.number || inv.id);
  });

  // Payment inflow entries
  const cfPayments: CashFlowEntry[] = periodPayments.map(p => {
    const linked = p.paymentables ?? p.invoices ?? [];
    const invoiceParts = linked
      .filter(li => li.invoice_id)
      .map(li => {
        const num = invoiceNumberById.get(li.invoice_id) ?? li.invoice_id;
        const applied = parseFloat(String(li.amount || 0));
        return { num, text: `${num} $${applied.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` };
      })
      .sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true, sensitivity: 'base' }))
      .map(x => x.text);
    return {
      type:    'payment',
      date:    p.date || p.payment_date || '',
      number:  p.number || '',
      name:    (p.client_id && clientById.get(p.client_id)?.name) || p.client_name || p.client?.name || 'Sin Cliente',
      amount:  parseFloat(String(p.amount || 0)),
      subLine: invoiceParts.join(', ')
    };
  });

  // Expense outflow entries (only expenses whose payment_date falls in the period)
  const cfExpenses: CashFlowEntry[] = allExpenses
    .filter(e => {
      if (!e.payment_date) return false;
      try {
        const d = parseISO(e.payment_date);
        return !isBefore(d, periodStart) && !isAfter(d, periodEnd);
      } catch { return false; }
    })
    .map(e => {
      const categoryPart = e.category_name || e.category?.name || '';
      const clientPart   = e.client_name || '';
      const subLine  = [categoryPart, clientPart].filter(Boolean).join(' • ');
      const subLine2 = e.public_notes || '';
      return {
        type:    'expense' as const,
        date:    e.payment_date!,
        number:  e.number || '',
        name:    e.vendor_name || e.vendor?.name || 'Sin Suplidor',
        amount:  parseFloat(String(e.amount || 0)),
        subLine,
        subLine2,
      };
    });

  // Merge and sort ascending by date string (YYYY-MM-DD lexicographic = chronological)
  const cashFlowEntries: CashFlowEntry[] = [...cfPayments, ...cfExpenses]
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    title,
    periodStart: formatDate(periodStart),
    periodEnd: formatDate(periodEnd),
    generatedAt,
    totalInvoicedInPeriod,
    totalPaymentsInPeriod,
    totalExpensesInPeriod,
    totalExpensesPaidInPeriod,
    arAtPeriodStart,
    arAtPeriodEnd,
    apAtPeriodStart,
    apAtPeriodEnd,
    paymentsByGroup,
    arByGroup,
    arByUnit,
    arByGroupUnit,
    expensesByCategory,
    expensesByVendor,
    cashFlowEntries,
    perpetualResult: allTimePaymentsTotal - allTimeExpensesPaidTotal,
    bankBalance: (allTimePaymentsTotal - allTimeExpensesPaidTotal) + initialBalance,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a copy of the array with soft-deleted records removed. */
function excludeDeleted<T extends { is_deleted?: boolean }>(items: T[]): T[] {
  return items.filter(item => !item.is_deleted);
}

function formatDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
