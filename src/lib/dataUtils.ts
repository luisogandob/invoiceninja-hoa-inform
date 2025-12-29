import {
  format,
  startOfMonth,
  endOfMonth,
  startOfYear,
  endOfYear,
  subMonths,
  subYears,
  parseISO,
  isWithinInterval
} from 'date-fns';
import type { Expense } from './invoiceNinjaClient.js';

/**
 * Date range result
 */
export interface DateRange {
  start: Date;
  end: Date;
  startISO: string;
  endISO: string;
}

/**
 * Custom date range input
 */
export interface CustomRange {
  start: string | Date;
  end: string | Date;
}

/**
 * Grouped expenses data
 */
export interface GroupedExpenses {
  expenses: Expense[];
  total: number;
}

/**
 * Monthly grouped expenses
 */
export interface MonthlyGroupedExpenses {
  label: string;
  expenses: Expense[];
  total: number;
}

/**
 * Expense statistics
 */
export interface ExpenseStats {
  count: number;
  total: number;
  average: number;
  min: number;
  max: number;
}

/**
 * Period type
 */
export type PeriodType = 'current-month' | 'last-month' | 'current-year' | 'last-year' | 'custom';

/**
 * Sort order
 */
export type SortOrder = 'asc' | 'desc';

/**
 * Get date range for a specific period
 */
export function getDateRange(period: PeriodType = 'current-month', customRange: CustomRange | null = null): DateRange {
  const now = new Date();
  let start: Date, end: Date;

  switch (period) {
    case 'current-month':
      start = startOfMonth(now);
      end = endOfMonth(now);
      break;
    case 'last-month':
      const lastMonth = subMonths(now, 1);
      start = startOfMonth(lastMonth);
      end = endOfMonth(lastMonth);
      break;
    case 'current-year':
      start = startOfYear(now);
      end = endOfYear(now);
      break;
    case 'last-year':
      const lastYear = subYears(now, 1);
      start = startOfYear(lastYear);
      end = endOfYear(lastYear);
      break;
    case 'custom':
      if (!customRange || !customRange.start || !customRange.end) {
        throw new Error('Custom range requires start and end dates');
      }
      start = typeof customRange.start === 'string' ? parseISO(customRange.start) : customRange.start;
      end = typeof customRange.end === 'string' ? parseISO(customRange.end) : customRange.end;
      break;
    default:
      throw new Error(`Unknown period: ${period}`);
  }

  return {
    start,
    end,
    startISO: format(start, 'yyyy-MM-dd'),
    endISO: format(end, 'yyyy-MM-dd')
  };
}

/**
 * Filter expenses by date range
 */
export function filterExpensesByDate(expenses: Expense[], startDate: Date, endDate: Date): Expense[] {
  return expenses.filter(expense => {
    const expenseDate = parseISO(expense.date || expense.expense_date || '');
    return isWithinInterval(expenseDate, { start: startDate, end: endDate });
  });
}

/**
 * Calculate total amount from expenses
 */
export function calculateTotal(expenses: Expense[]): number {
  return expenses.reduce((total, expense) => {
    return total + parseFloat(String(expense.amount || 0));
  }, 0);
}

/**
 * Group expenses by category
 */
export function groupByCategory(expenses: Expense[]): Record<string, GroupedExpenses> {
  const grouped: Record<string, GroupedExpenses> = {};

  expenses.forEach(expense => {
    const category = expense.category_name || expense.category?.name || 'Uncategorized';
    if (!grouped[category]) {
      grouped[category] = {
        expenses: [],
        total: 0
      };
    }
    grouped[category].expenses.push(expense);
    grouped[category].total += parseFloat(String(expense.amount || 0));
  });

  return grouped;
}

/**
 * Group expenses by vendor
 */
export function groupByVendor(expenses: Expense[]): Record<string, GroupedExpenses> {
  const grouped: Record<string, GroupedExpenses> = {};

  expenses.forEach(expense => {
    const vendor = expense.vendor_name || expense.vendor?.name || 'Unknown Vendor';
    if (!grouped[vendor]) {
      grouped[vendor] = {
        expenses: [],
        total: 0
      };
    }
    grouped[vendor].expenses.push(expense);
    grouped[vendor].total += parseFloat(String(expense.amount || 0));
  });

  return grouped;
}

/**
 * Group expenses by month
 */
export function groupByMonth(expenses: Expense[]): Record<string, MonthlyGroupedExpenses> {
  const grouped: Record<string, MonthlyGroupedExpenses> = {};

  expenses.forEach(expense => {
    const expenseDate = parseISO(expense.date || expense.expense_date || '');
    const monthKey = format(expenseDate, 'yyyy-MM');
    const monthLabel = format(expenseDate, 'MMMM yyyy');

    if (!grouped[monthKey]) {
      grouped[monthKey] = {
        label: monthLabel,
        expenses: [],
        total: 0
      };
    }
    grouped[monthKey].expenses.push(expense);
    grouped[monthKey].total += parseFloat(String(expense.amount || 0));
  });

  return grouped;
}

/**
 * Sort expenses by date
 */
export function sortByDate(expenses: Expense[], order: SortOrder = 'desc'): Expense[] {
  return [...expenses].sort((a, b) => {
    const dateA = parseISO(a.date || a.expense_date || '');
    const dateB = parseISO(b.date || b.expense_date || '');
    return order === 'asc' ? dateA.getTime() - dateB.getTime() : dateB.getTime() - dateA.getTime();
  });
}

/**
 * Sort expenses by amount
 */
export function sortByAmount(expenses: Expense[], order: SortOrder = 'desc'): Expense[] {
  return [...expenses].sort((a, b) => {
    const amountA = parseFloat(String(a.amount || 0));
    const amountB = parseFloat(String(b.amount || 0));
    return order === 'asc' ? amountA - amountB : amountB - amountA;
  });
}

/**
 * Get expense statistics
 */
export function getExpenseStats(expenses: Expense[]): ExpenseStats {
  if (expenses.length === 0) {
    return {
      count: 0,
      total: 0,
      average: 0,
      min: 0,
      max: 0
    };
  }

  const amounts = expenses.map(e => parseFloat(String(e.amount || 0)));
  const total = amounts.reduce((sum, amount) => sum + amount, 0);

  return {
    count: expenses.length,
    total: total,
    average: total / expenses.length,
    min: Math.min(...amounts),
    max: Math.max(...amounts)
  };
}

/**
 * Format period string for display
 */
export function formatPeriodString(period: PeriodType, dateRange: DateRange): string {
  const { start, end } = dateRange;

  switch (period) {
    case 'current-month':
      return format(start, 'MMMM yyyy');
    case 'last-month':
      return format(start, 'MMMM yyyy');
    case 'current-year':
      return format(start, 'yyyy');
    case 'last-year':
      return format(start, 'yyyy');
    case 'custom':
      return `${format(start, 'MMM dd, yyyy')} - ${format(end, 'MMM dd, yyyy')}`;
    default:
      return `${format(start, 'MMM dd, yyyy')} - ${format(end, 'MMM dd, yyyy')}`;
  }
}
