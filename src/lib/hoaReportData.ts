import { parseISO, isBefore, isEqual, differenceInDays } from 'date-fns';
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
  /** Accounts receivable at the START of the period */
  arAtPeriodStart: number;
  /** Accounts receivable at the END of the period */
  arAtPeriodEnd: number;
  /**
   * Accounts payable at the START of the period.
   * Currently 0 — AP tracking requires the InvoiceNinja Bills module
   * which is not yet integrated.
   */
  apAtPeriodStart: number;
  /**
   * Accounts payable at the END of the period.
   * Currently 0 — AP tracking requires the InvoiceNinja Bills module
   * which is not yet integrated.
   */
  apAtPeriodEnd: number;

  /** Payments in the period grouped by client group, with aging buckets */
  paymentsByGroup: PaymentsByGroup[];
  /** Accounts receivable at end of period, grouped by client group, with aging buckets */
  arByGroup: ArByGroup[];
}

export interface PaymentsByGroup {
  groupName: string;
  /** Sum of all aging buckets */
  total: number;
  /** Payments applied to invoices aged ≤30 days at time of payment (green) */
  aged0_30: number;
  /** Payments applied to invoices aged 31-90 days at time of payment (yellow) */
  aged31_90: number;
  /** Payments applied to invoices aged >90 days at time of payment (orange) */
  aged90plus: number;
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

/** Label used when a client has no group assigned */
const NO_GROUP_LABEL = 'Sin Grupo';

/**
 * Build the HoaReportData from raw Invoice Ninja data.
 *
 * Calculation notes:
 *  - totalInvoicedInPeriod : sum of invoice.amount for invoices issued within the period
 *  - totalPaymentsInPeriod : sum of payment.amount for payments received within the period
 *  - totalExpensesInPeriod : sum of expense.amount for expenses registered within the period
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
 * @param allClients     All clients (used to resolve client → group)
 * @param clientGroups   All client groups from Invoice Ninja group_settings
 * @param periodStart    Start date of the report period
 * @param periodEnd      End date of the report period
 * @param title          Report title
 * @param generatedAt    Report generation timestamp
 */
export function buildHoaReportData(
  allInvoices: Invoice[],
  periodInvoices: Invoice[],
  periodPayments: Payment[],
  periodExpenses: Expense[],
  allClients: Client[],
  clientGroups: ClientGroup[],
  periodStart: Date,
  periodEnd: Date,
  title: string,
  generatedAt: Date
): HoaReportData {
  // --- Lookup helpers ---
  // clientById: id → Client
  const clientById = new Map<string, Client>(allClients.map(c => [c.id, c]));
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
      const clientByName = allClients.find(c => c.name === clientName);
      if (clientByName?.group_settings_id) {
        return groupNameById.get(clientByName.group_settings_id) ?? NO_GROUP_LABEL;
      }
    }
    return NO_GROUP_LABEL;
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
  interface GroupPayments { aged0_30: number; aged31_90: number; aged90plus: number; }
  const paymentGroupMap: Record<string, GroupPayments> = {};

  periodPayments.forEach(p => {
    const group = resolveGroup(p.client_id, p.client_name || p.client?.name);
    if (!paymentGroupMap[group]) {
      paymentGroupMap[group] = { aged0_30: 0, aged31_90: 0, aged90plus: 0 };
    }

    const paymentDate = (() => {
      const s = p.date || p.payment_date;
      if (!s) return null;
      try { return parseISO(s); } catch { return null; }
    })();

    const linkedInvoices = p.invoices;
    if (paymentDate && linkedInvoices && linkedInvoices.length > 0) {
      // Distribute payment by how old each linked invoice was at the time of payment
      linkedInvoices.forEach(li => {
        const invDate = invoiceDateById.get(li.invoice_id);
        const amount = parseFloat(String(li.amount || 0));
        if (invDate) {
          const age = Math.max(0, differenceInDays(paymentDate, invDate));
          if (age <= 30) {
            paymentGroupMap[group].aged0_30 += amount;
          } else if (age <= 90) {
            paymentGroupMap[group].aged31_90 += amount;
          } else {
            paymentGroupMap[group].aged90plus += amount;
          }
        } else {
          paymentGroupMap[group].aged0_30 += amount; // unknown invoice age → treat as current
        }
      });
    } else {
      // No linked-invoice detail → treat full payment as current
      const amount = parseFloat(String(p.amount || 0));
      paymentGroupMap[group].aged0_30 += amount;
    }
  });

  const paymentsByGroup: PaymentsByGroup[] = Object.entries(paymentGroupMap)
    .map(([groupName, b]) => ({
      groupName,
      total: b.aged0_30 + b.aged31_90 + b.aged90plus,
      aged0_30:   b.aged0_30,
      aged31_90:  b.aged31_90,
      aged90plus: b.aged90plus
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

  return {
    title,
    periodStart: formatDate(periodStart),
    periodEnd: formatDate(periodEnd),
    generatedAt,
    totalInvoicedInPeriod,
    totalPaymentsInPeriod,
    totalExpensesInPeriod,
    arAtPeriodStart,
    arAtPeriodEnd,
    apAtPeriodStart: 0,
    apAtPeriodEnd:   0,
    paymentsByGroup,
    arByGroup
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
