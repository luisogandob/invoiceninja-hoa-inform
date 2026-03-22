import { parseISO, isWithinInterval, isBefore, isEqual } from 'date-fns';
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

  /** Payments in the period grouped by client group */
  paymentsByGroup: PaymentsByGroup[];
  /** Accounts receivable at end of period, grouped by client group */
  arByGroup: ArByGroup[];
}

export interface PaymentsByGroup {
  groupName: string;
  total: number;
}

export interface ArByGroup {
  groupName: string;
  balance: number;
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
  const arAtPeriodStart = arAtPeriodEnd - totalInvoicedInPeriod + totalPaymentsInPeriod;

  // --- Payments by client group ---
  const paymentGroupMap: Record<string, number> = {};
  periodPayments.forEach(p => {
    const group = resolveGroup(p.client_id, p.client_name || p.client?.name);
    paymentGroupMap[group] = (paymentGroupMap[group] || 0) + parseFloat(String(p.amount || 0));
  });
  const paymentsByGroup: PaymentsByGroup[] = Object.entries(paymentGroupMap)
    .map(([groupName, total]) => ({ groupName, total }))
    .sort((a, b) => b.total - a.total);

  // --- AR by client group at end of period ---
  const arGroupMap: Record<string, number> = {};
  invoicesIssuedByPeriodEnd.forEach(inv => {
    const balance = parseFloat(String(inv.balance || 0));
    if (balance <= 0) return;
    const group = resolveGroup(inv.client_id, inv.client_name || inv.client?.name);
    arGroupMap[group] = (arGroupMap[group] || 0) + balance;
  });
  const arByGroup: ArByGroup[] = Object.entries(arGroupMap)
    .map(([groupName, balance]) => ({ groupName, balance }))
    .sort((a, b) => b.balance - a.balance);

  return {
    title,
    periodStart: formatDate(periodStart),
    periodEnd: formatDate(periodEnd),
    generatedAt,
    totalInvoicedInPeriod,
    totalPaymentsInPeriod,
    totalExpensesInPeriod,
    arAtPeriodStart: Math.max(0, arAtPeriodStart),
    arAtPeriodEnd,
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
