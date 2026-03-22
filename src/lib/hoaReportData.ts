import { parseISO, isWithinInterval, isBefore, isEqual } from 'date-fns';
import type { Invoice, Payment, Expense } from './invoiceNinjaClient.js';

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

  /** Payments in the period grouped by client name */
  paymentsByClient: PaymentsByClient[];
  /** Accounts receivable at end of period, grouped by client name */
  arByClient: ArByClient[];
}

export interface PaymentsByClient {
  clientName: string;
  total: number;
}

export interface ArByClient {
  clientName: string;
  balance: number;
}

/**
 * Build the HoaReportData from raw Invoice Ninja data.
 *
 * @param allInvoices   Every invoice fetched (no date filter) — used to compute AR
 * @param periodInvoices Invoices issued during the report period
 * @param periodPayments Payments received during the report period
 * @param periodExpenses Expenses registered during the report period
 * @param periodStart   Start date of the report period
 * @param periodEnd     End date of the report period
 * @param title         Report title
 * @param generatedAt   Report generation timestamp
 */
export function buildHoaReportData(
  allInvoices: Invoice[],
  periodInvoices: Invoice[],
  periodPayments: Payment[],
  periodExpenses: Expense[],
  periodStart: Date,
  periodEnd: Date,
  title: string,
  generatedAt: Date
): HoaReportData {
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

  // --- Payments by client ---
  const paymentClientMap: Record<string, number> = {};
  periodPayments.forEach(p => {
    const client = p.client_name || p.client?.name || 'Unknown Client';
    paymentClientMap[client] = (paymentClientMap[client] || 0) + parseFloat(String(p.amount || 0));
  });
  const paymentsByClient: PaymentsByClient[] = Object.entries(paymentClientMap)
    .map(([clientName, total]) => ({ clientName, total }))
    .sort((a, b) => b.total - a.total);

  // --- AR by client at end of period ---
  const arClientMap: Record<string, number> = {};
  invoicesIssuedByPeriodEnd.forEach(inv => {
    const balance = parseFloat(String(inv.balance || 0));
    if (balance <= 0) return;
    const client = inv.client_name || inv.client?.name || 'Unknown Client';
    arClientMap[client] = (arClientMap[client] || 0) + balance;
  });
  const arByClient: ArByClient[] = Object.entries(arClientMap)
    .map(([clientName, balance]) => ({ clientName, balance }))
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
    paymentsByClient,
    arByClient
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
