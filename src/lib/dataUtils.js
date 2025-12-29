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

/**
 * Data Processing Utilities
 * Helper functions for processing expense data and date operations
 */

/**
 * Get date range for a specific period
 * @param {string} period - Period type: 'current-month', 'last-month', 'current-year', 'last-year', 'custom'
 * @param {Object} customRange - Custom date range {start, end}
 * @returns {Object} Date range with start and end dates
 */
export function getDateRange(period = 'current-month', customRange = null) {
  const now = new Date();
  let start, end;

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
 * @param {Array} expenses - Array of expense objects
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Array} Filtered expenses
 */
export function filterExpensesByDate(expenses, startDate, endDate) {
  return expenses.filter(expense => {
    const expenseDate = parseISO(expense.date || expense.expense_date);
    return isWithinInterval(expenseDate, { start: startDate, end: endDate });
  });
}

/**
 * Calculate total amount from expenses
 * @param {Array} expenses - Array of expense objects
 * @returns {number} Total amount
 */
export function calculateTotal(expenses) {
  return expenses.reduce((total, expense) => {
    return total + parseFloat(expense.amount || 0);
  }, 0);
}

/**
 * Group expenses by category
 * @param {Array} expenses - Array of expense objects
 * @returns {Object} Expenses grouped by category
 */
export function groupByCategory(expenses) {
  const grouped = {};

  expenses.forEach(expense => {
    const category = expense.category_name || expense.category?.name || 'Uncategorized';
    if (!grouped[category]) {
      grouped[category] = {
        expenses: [],
        total: 0
      };
    }
    grouped[category].expenses.push(expense);
    grouped[category].total += parseFloat(expense.amount || 0);
  });

  return grouped;
}

/**
 * Group expenses by vendor
 * @param {Array} expenses - Array of expense objects
 * @returns {Object} Expenses grouped by vendor
 */
export function groupByVendor(expenses) {
  const grouped = {};

  expenses.forEach(expense => {
    const vendor = expense.vendor_name || expense.vendor?.name || 'Unknown Vendor';
    if (!grouped[vendor]) {
      grouped[vendor] = {
        expenses: [],
        total: 0
      };
    }
    grouped[vendor].expenses.push(expense);
    grouped[vendor].total += parseFloat(expense.amount || 0);
  });

  return grouped;
}

/**
 * Group expenses by month
 * @param {Array} expenses - Array of expense objects
 * @returns {Object} Expenses grouped by month
 */
export function groupByMonth(expenses) {
  const grouped = {};

  expenses.forEach(expense => {
    const expenseDate = parseISO(expense.date || expense.expense_date);
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
    grouped[monthKey].total += parseFloat(expense.amount || 0);
  });

  return grouped;
}

/**
 * Sort expenses by date
 * @param {Array} expenses - Array of expense objects
 * @param {string} order - Sort order: 'asc' or 'desc'
 * @returns {Array} Sorted expenses
 */
export function sortByDate(expenses, order = 'desc') {
  return [...expenses].sort((a, b) => {
    const dateA = parseISO(a.date || a.expense_date);
    const dateB = parseISO(b.date || b.expense_date);
    return order === 'asc' ? dateA - dateB : dateB - dateA;
  });
}

/**
 * Sort expenses by amount
 * @param {Array} expenses - Array of expense objects
 * @param {string} order - Sort order: 'asc' or 'desc'
 * @returns {Array} Sorted expenses
 */
export function sortByAmount(expenses, order = 'desc') {
  return [...expenses].sort((a, b) => {
    const amountA = parseFloat(a.amount || 0);
    const amountB = parseFloat(b.amount || 0);
    return order === 'asc' ? amountA - amountB : amountB - amountA;
  });
}

/**
 * Get expense statistics
 * @param {Array} expenses - Array of expense objects
 * @returns {Object} Statistics object
 */
export function getExpenseStats(expenses) {
  if (expenses.length === 0) {
    return {
      count: 0,
      total: 0,
      average: 0,
      min: 0,
      max: 0
    };
  }

  const amounts = expenses.map(e => parseFloat(e.amount || 0));
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
 * @param {string} period - Period type
 * @param {Object} dateRange - Date range object
 * @returns {string} Formatted period string
 */
export function formatPeriodString(period, dateRange) {
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
