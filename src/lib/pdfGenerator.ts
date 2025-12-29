import jsreport from '@jsreport/jsreport-core';
import chromePdf from '@jsreport/jsreport-chrome-pdf';
import { format } from 'date-fns';
import type { Expense, Invoice, Payment } from './invoiceNinjaClient.js';

/**
 * Report data structure for financial reports (incomes and expenses)
 */
export interface ReportData {
  expenses: Expense[];
  invoices: Invoice[];
  payments?: Payment[];
  unpaidInvoices?: Invoice[];
  title: string;
  period: string;
  totalExpenses: number;
  totalIncome: number;
  totalPayments?: number;
  totalUnpaidBalance?: number;
  netAmount: number;
  generatedDate: Date;
}

/**
 * JSReport instance type
 */
type JSReportInstance = any;

/**
 * Configuration constants
 */
const MAX_UNPAID_INVOICES_IN_PDF = 20;

/**
 * PDF Generator using JSReport
 * Generates financial reports (income and expenses) in PDF format
 */
class PDFGenerator {
  private jsreport: JSReportInstance | null = null;

  /**
   * Initialize JSReport instance
   */
  async init(): Promise<void> {
    if (this.jsreport) {
      return;
    }

    this.jsreport = jsreport();
    this.jsreport.use(chromePdf({
      timeout: 60000
    }));

    await this.jsreport.init();
    console.log('JSReport initialized successfully');
  }

  /**
   * Generate financial report PDF with both incomes and expenses
   */
  async generateFinancialReport(reportData: ReportData): Promise<Buffer> {
    await this.init();

    const { 
      expenses, 
      invoices, 
      payments = [],
      unpaidInvoices = [],
      title, 
      period, 
      totalExpenses, 
      totalIncome, 
      totalPayments = 0,
      totalUnpaidBalance = 0,
      netAmount, 
      generatedDate 
    } = reportData;

    const htmlTemplate = this.createHTMLTemplate(
      expenses, 
      invoices, 
      payments,
      unpaidInvoices,
      title, 
      period, 
      totalExpenses, 
      totalIncome, 
      totalPayments,
      totalUnpaidBalance,
      netAmount, 
      generatedDate
    );

    try {
      const result = await this.jsreport.render({
        template: {
          content: htmlTemplate,
          engine: 'none',
          recipe: 'chrome-pdf',
          chrome: {
            format: 'A4',
            displayHeaderFooter: true,
            headerTemplate: '<div></div>',
            footerTemplate: `
              <div style="width: 100%; text-align: center; font-size: 10px; padding: 10px;">
                <span class="pageNumber"></span> / <span class="totalPages"></span>
              </div>
            `,
            marginTop: '1cm',
            marginBottom: '1.5cm',
            marginLeft: '1cm',
            marginRight: '1cm'
          }
        }
      });

      return result.content;
    } catch (error) {
      console.error('Error generating PDF:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Create HTML template for the financial report
   */
  private createHTMLTemplate(
    expenses: Expense[],
    invoices: Invoice[],
    payments: Payment[],
    unpaidInvoices: Invoice[],
    title: string,
    period: string,
    totalExpenses: number,
    totalIncome: number,
    totalPayments: number,
    totalUnpaidBalance: number,
    netAmount: number,
    generatedDate: Date
  ): string {
    const incomeRows = invoices.map(invoice => {
      const formattedDate = this.formatDate(invoice.date || invoice.invoice_date);
      return `
      <tr>
        <td>${formattedDate}</td>
        <td>${this.escapeHtml(invoice.number || '-')}</td>
        <td>${this.escapeHtml(invoice.client_name || invoice.client?.name || '-')}</td>
        <td>${this.escapeHtml(invoice.public_notes || '-')}</td>
        <td style="text-align: right;">$${this.formatAmount(invoice.amount)}</td>
      </tr>
    `;
    }).join('');

    const paymentRows = payments.map(payment => {
      const formattedDate = this.formatDate(payment.date || payment.payment_date);
      return `
      <tr>
        <td>${formattedDate}</td>
        <td>${this.escapeHtml(payment.client_name || payment.client?.name || '-')}</td>
        <td>${this.escapeHtml(payment.transaction_reference || '-')}</td>
        <td style="text-align: right;">$${this.formatAmount(payment.amount)}</td>
      </tr>
    `;
    }).join('');

    const unpaidRows = unpaidInvoices.slice(0, MAX_UNPAID_INVOICES_IN_PDF).map(invoice => {
      const formattedDate = this.formatDate(invoice.date || invoice.invoice_date);
      const balance = parseFloat(String(invoice.balance || 0));
      return `
      <tr>
        <td>${formattedDate}</td>
        <td>${this.escapeHtml(invoice.number || '-')}</td>
        <td>${this.escapeHtml(invoice.client_name || invoice.client?.name || '-')}</td>
        <td style="text-align: right;">$${this.formatAmount(invoice.amount)}</td>
        <td style="text-align: right; color: #e67e22; font-weight: bold;">$${balance.toFixed(2)}</td>
      </tr>
    `;
    }).join('');

    const expenseRows = expenses.map(expense => {
      const formattedDate = this.formatDate(expense.date || expense.expense_date);
      return `
      <tr>
        <td>${formattedDate}</td>
        <td>${this.escapeHtml(expense.public_notes || expense.description || '-')}</td>
        <td>${this.escapeHtml(expense.vendor_name || expense.vendor?.name || '-')}</td>
        <td>${this.escapeHtml(expense.category_name || expense.category?.name || '-')}</td>
        <td style="text-align: right;">$${this.formatAmount(expense.amount)}</td>
      </tr>
    `;
    }).join('');

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${this.escapeHtml(title)}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: Arial, sans-serif;
      padding: 20px;
      color: #333;
    }
    .header {
      text-align: center;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 2px solid #2c3e50;
    }
    h1 {
      color: #2c3e50;
      font-size: 24px;
      margin-bottom: 10px;
    }
    h2 {
      color: #2c3e50;
      font-size: 18px;
      margin-top: 30px;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 1px solid #bdc3c7;
    }
    .subtitle {
      color: #7f8c8d;
      font-size: 14px;
      margin-bottom: 5px;
    }
    .summary {
      background-color: #ecf0f1;
      padding: 20px;
      margin: 20px 0;
      border-radius: 5px;
    }
    .summary-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      font-size: 14px;
    }
    .summary-row.net {
      font-weight: bold;
      font-size: 16px;
      padding-top: 15px;
      border-top: 2px solid #34495e;
      margin-top: 10px;
    }
    .income-color {
      color: #27ae60;
    }
    .payment-color {
      color: #3498db;
    }
    .unpaid-color {
      color: #e67e22;
    }
    .expense-color {
      color: #e74c3c;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      margin-bottom: 30px;
    }
    th {
      background-color: #34495e;
      color: white;
      padding: 12px;
      text-align: left;
      font-weight: bold;
      font-size: 12px;
      text-transform: uppercase;
    }
    th.income-header {
      background-color: #27ae60;
    }
    th.payment-header {
      background-color: #3498db;
    }
    th.unpaid-header {
      background-color: #e67e22;
    }
    th.expense-header {
      background-color: #e74c3c;
    }
    td {
      padding: 10px 12px;
      border-bottom: 1px solid #ecf0f1;
      font-size: 11px;
    }
    tr:hover {
      background-color: #f8f9fa;
    }
    .total-row {
      background-color: #ecf0f1;
      font-weight: bold;
      font-size: 14px;
    }
    .total-row td {
      padding: 15px 12px;
      border-top: 2px solid #34495e;
    }
    .footer {
      margin-top: 30px;
      text-align: center;
      color: #95a5a6;
      font-size: 10px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${this.escapeHtml(title)}</h1>
    <div class="subtitle">Period: ${this.escapeHtml(period)}</div>
    <div class="subtitle">Generated: ${format(generatedDate, 'yyyy-MM-dd HH:mm')}</div>
  </div>

  <div class="summary">
    <div class="summary-row">
      <span>Total Invoiced:</span>
      <span class="income-color">$${this.formatAmount(totalIncome)}</span>
    </div>
    <div class="summary-row">
      <span>Total Payments Received:</span>
      <span class="payment-color">$${this.formatAmount(totalPayments)}</span>
    </div>
    <div class="summary-row">
      <span>Total Outstanding Balance:</span>
      <span class="unpaid-color">$${this.formatAmount(totalUnpaidBalance)}</span>
    </div>
    <div class="summary-row">
      <span>Total Expenses:</span>
      <span class="expense-color">$${this.formatAmount(totalExpenses)}</span>
    </div>
    <div class="summary-row net">
      <span>Net Amount (Payments - Expenses):</span>
      <span style="color: ${netAmount >= 0 ? '#27ae60' : '#e74c3c'};">$${this.formatAmount(netAmount)}</span>
    </div>
  </div>

  <h2>Invoices Issued</h2>
  <table>
    <thead>
      <tr>
        <th class="income-header">Date</th>
        <th class="income-header">Invoice #</th>
        <th class="income-header">Client</th>
        <th class="income-header">Description</th>
        <th class="income-header" style="text-align: right;">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${invoices.length === 0 ? '<tr><td colspan="5" style="text-align: center; color: #95a5a6;">No invoices issued in this period</td></tr>' : incomeRows}
      ${invoices.length > 0 ? `
      <tr class="total-row">
        <td colspan="4" style="text-align: right;">TOTAL INVOICED:</td>
        <td style="text-align: right;" class="income-color">$${this.formatAmount(totalIncome)}</td>
      </tr>
      ` : ''}
    </tbody>
  </table>

  <h2>Payments Received</h2>
  <table>
    <thead>
      <tr>
        <th class="payment-header">Date</th>
        <th class="payment-header">Client</th>
        <th class="payment-header">Reference</th>
        <th class="payment-header" style="text-align: right;">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${payments.length === 0 ? '<tr><td colspan="4" style="text-align: center; color: #95a5a6;">No payments received in this period</td></tr>' : paymentRows}
      ${payments.length > 0 ? `
      <tr class="total-row">
        <td colspan="3" style="text-align: right;">TOTAL PAYMENTS RECEIVED:</td>
        <td style="text-align: right;" class="payment-color">$${this.formatAmount(totalPayments)}</td>
      </tr>
      ` : ''}
    </tbody>
  </table>

  ${unpaidInvoices.length > 0 ? `
  <h2>Outstanding Invoices (Unpaid/Partially Paid)</h2>
  <table>
    <thead>
      <tr>
        <th class="unpaid-header">Date</th>
        <th class="unpaid-header">Invoice #</th>
        <th class="unpaid-header">Client</th>
        <th class="unpaid-header" style="text-align: right;">Total</th>
        <th class="unpaid-header" style="text-align: right;">Balance Due</th>
      </tr>
    </thead>
    <tbody>
      ${unpaidRows}
      <tr class="total-row">
        <td colspan="4" style="text-align: right;">TOTAL OUTSTANDING:</td>
        <td style="text-align: right;" class="unpaid-color">$${this.formatAmount(totalUnpaidBalance)}</td>
      </tr>
    </tbody>
  </table>
  ${unpaidInvoices.length > MAX_UNPAID_INVOICES_IN_PDF ? `<p style="font-size: 11px; color: #95a5a6; margin-top: -20px;"><em>Showing top ${MAX_UNPAID_INVOICES_IN_PDF} of ${unpaidInvoices.length} unpaid invoices.</em></p>` : ''}
  ` : ''}

  <h2>Expenses</h2>
  <table>
    <thead>
      <tr>
        <th class="expense-header">Date</th>
        <th class="expense-header">Description</th>
        <th class="expense-header">Vendor</th>
        <th class="expense-header">Category</th>
        <th class="expense-header" style="text-align: right;">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${expenses.length === 0 ? '<tr><td colspan="5" style="text-align: center; color: #95a5a6;">No expense records for this period</td></tr>' : expenseRows}
      ${expenses.length > 0 ? `
      <tr class="total-row">
        <td colspan="4" style="text-align: right;">TOTAL EXPENSES:</td>
        <td style="text-align: right;" class="expense-color">$${this.formatAmount(totalExpenses)}</td>
      </tr>
      ` : ''}
    </tbody>
  </table>

  <div class="footer">
    <p>This report was automatically generated by the HOA Financial Reporting System</p>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Format a date string to yyyy-MM-dd format
   */
  private formatDate(dateStr: string | undefined): string {
    if (!dateStr) {
      return 'N/A';
    }
    try {
      return format(new Date(dateStr), 'yyyy-MM-dd');
    } catch {
      return format(new Date(), 'yyyy-MM-dd');
    }
  }

  /**
   * Format amount to 2 decimal places
   */
  private formatAmount(amount: number): string {
    return parseFloat(String(amount || 0)).toFixed(2);
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
  }

  /**
   * Close JSReport instance
   */
  async close(): Promise<void> {
    if (this.jsreport) {
      await this.jsreport.close();
      this.jsreport = null;
    }
  }
}

export default PDFGenerator;
