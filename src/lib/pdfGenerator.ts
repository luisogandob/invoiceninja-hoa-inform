import jsreport from '@jsreport/jsreport-core';
import chromePdf from '@jsreport/jsreport-chrome-pdf';
import { format } from 'date-fns';
import type { Expense, Invoice } from './invoiceNinjaClient.js';

/**
 * Report data structure for financial reports (incomes and expenses)
 */
export interface ReportData {
  expenses: Expense[];
  invoices: Invoice[];
  title: string;
  period: string;
  totalExpenses: number;
  totalIncome: number;
  netAmount: number;
  generatedDate: Date;
}

/**
 * JSReport instance type
 */
type JSReportInstance = any;

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

    const { expenses, invoices, title, period, totalExpenses, totalIncome, netAmount, generatedDate } = reportData;

    const htmlTemplate = this.createHTMLTemplate(expenses, invoices, title, period, totalExpenses, totalIncome, netAmount, generatedDate);

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
    title: string,
    period: string,
    totalExpenses: number,
    totalIncome: number,
    netAmount: number,
    generatedDate: Date
  ): string {
    const incomeRows = invoices.map(invoice => {
      const dateStr = invoice.date || invoice.invoice_date || new Date().toISOString();
      return `
      <tr>
        <td>${format(new Date(dateStr), 'yyyy-MM-dd')}</td>
        <td>${this.escapeHtml(invoice.number || '-')}</td>
        <td>${this.escapeHtml(invoice.client_name || invoice.client?.name || '-')}</td>
        <td>${this.escapeHtml(invoice.public_notes || '-')}</td>
        <td style="text-align: right;">$${this.formatAmount(invoice.amount)}</td>
      </tr>
    `;
    }).join('');

    const expenseRows = expenses.map(expense => {
      const dateStr = expense.date || expense.expense_date || new Date().toISOString();
      return `
      <tr>
        <td>${format(new Date(dateStr), 'yyyy-MM-dd')}</td>
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
      <span>Total Income:</span>
      <span class="income-color">$${this.formatAmount(totalIncome)}</span>
    </div>
    <div class="summary-row">
      <span>Total Expenses:</span>
      <span class="expense-color">$${this.formatAmount(totalExpenses)}</span>
    </div>
    <div class="summary-row net">
      <span>Net Amount:</span>
      <span style="color: ${netAmount >= 0 ? '#27ae60' : '#e74c3c'};">$${this.formatAmount(netAmount)}</span>
    </div>
  </div>

  <h2>Income</h2>
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
      ${invoices.length === 0 ? '<tr><td colspan="5" style="text-align: center; color: #95a5a6;">No income records for this period</td></tr>' : incomeRows}
      ${invoices.length > 0 ? `
      <tr class="total-row">
        <td colspan="4" style="text-align: right;">TOTAL INCOME:</td>
        <td style="text-align: right;" class="income-color">$${this.formatAmount(totalIncome)}</td>
      </tr>
      ` : ''}
    </tbody>
  </table>

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
