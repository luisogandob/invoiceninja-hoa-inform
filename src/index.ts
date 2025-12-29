import dotenv from 'dotenv';
import { format } from 'date-fns';
import { promises as fs } from 'fs';
import InvoiceNinjaClient from './lib/invoiceNinjaClient.js';
import PDFGenerator from './lib/pdfGenerator.js';
import EmailSender from './lib/emailSender.js';
import type { Expense, Invoice, Payment } from './lib/invoiceNinjaClient.js';
import type { ExpenseStats, InvoiceStats, PaymentStats, PeriodType, CustomRange, GroupedExpenses, GroupedInvoices, GroupedPayments } from './lib/dataUtils.js';
import {
  getDateRange,
  filterExpensesByDate,
  filterInvoicesByDate,
  filterPaymentsByDate,
  calculateTotal,
  calculateInvoiceTotal,
  calculatePaymentTotal,
  groupByCategory,
  groupByVendor,
  groupByClient,
  groupPaymentsByClient,
  sortByDate,
  sortInvoicesByDate,
  sortPaymentsByDate,
  getExpenseStats,
  getInvoiceStats,
  getPaymentStats,
  getUnpaidInvoices,
  formatPeriodString
} from './lib/dataUtils.js';

// Load environment variables
dotenv.config();

/**
 * Configuration constants
 */
const MAX_UNPAID_INVOICES_IN_EMAIL = 10;

/**
 * Report generation options
 */
export interface ReportOptions {
  period?: PeriodType;
  customRange?: CustomRange | null;
  emailTo?: string | null;
  saveToFile?: boolean;
  outputPath?: string;
}

/**
 * Report result
 */
export interface ReportResult {
  success: boolean;
  message: string;
  stats?: {
    expenseCount: number;
    incomeCount: number;
    paymentCount: number;
    unpaidInvoiceCount: number;
    totalExpenses: number;
    totalIncome: number;
    totalPayments: number;
    totalUnpaidBalance: number;
    netAmount: number;
    period: string;
  };
}

/**
 * Connection test result
 */
export interface ConnectionTestResult {
  invoiceNinja: boolean;
  email: boolean;
  error?: string;
}

/**
 * Main Application Class
 * Coordinates the HOA financial reporting workflow (incomes and expenses)
 */
class HOAInformAutomation {
  private invoiceNinja: InvoiceNinjaClient;
  private pdfGenerator: PDFGenerator;
  private emailSender: EmailSender;

  constructor() {
    this.invoiceNinja = new InvoiceNinjaClient();
    this.pdfGenerator = new PDFGenerator();
    this.emailSender = new EmailSender();
  }

  /**
   * Generate and send financial report (incomes and expenses)
   */
  async generateAndSendReport(options: ReportOptions = {}): Promise<ReportResult> {
    const {
      period = (process.env.REPORT_PERIOD as PeriodType) || 'current-month',
      customRange = null,
      emailTo = null,
      saveToFile = false,
      outputPath = './financial-report.pdf'
    } = options;

    try {
      console.log('Starting HOA Financial Report Generation...');
      console.log(`Period: ${period}`);

      // Step 1: Get date range
      const dateRange = getDateRange(period, customRange);
      console.log(`Date range: ${dateRange.startISO} to ${dateRange.endISO}`);

      // Step 2: Fetch expenses from Invoice Ninja with date filters
      console.log('Fetching expenses from Invoice Ninja...');
      const allExpenses = await this.invoiceNinja.getExpenses({
        start_date: dateRange.startISO,
        end_date: dateRange.endISO
      });
      console.log(`Total expenses fetched for period: ${allExpenses.length}`);

      // Step 3: Fetch invoices (income) from Invoice Ninja with date filters
      console.log('Fetching invoices (income) from Invoice Ninja...');
      const allInvoices = await this.invoiceNinja.getInvoices({
        start_date: dateRange.startISO,
        end_date: dateRange.endISO
      });
      console.log(`Total invoices fetched for period: ${allInvoices.length}`);

      // Step 3b: Fetch payments made during the period
      console.log('Fetching payments from Invoice Ninja...');
      const allPayments = await this.invoiceNinja.getPayments({
        start_date: dateRange.startISO,
        end_date: dateRange.endISO
      });
      console.log(`Total payments fetched for period: ${allPayments.length}`);

      // Step 3c: Fetch all invoices to check for unpaid/partially paid ones
      console.log('Fetching all invoices to check for unpaid balances...');
      const allInvoicesEver = await this.invoiceNinja.getInvoices({});
      const unpaidInvoices = getUnpaidInvoices(allInvoicesEver);
      console.log(`Total unpaid/partially paid invoices: ${unpaidInvoices.length}`);

      // Step 4: Filter by date range (additional client-side filtering for safety)
      const filteredExpenses = filterExpensesByDate(allExpenses, dateRange.start, dateRange.end);
      const filteredInvoices = filterInvoicesByDate(allInvoices, dateRange.start, dateRange.end);
      const filteredPayments = filterPaymentsByDate(allPayments, dateRange.start, dateRange.end);
      console.log(`Expenses after filtering: ${filteredExpenses.length}`);
      console.log(`Invoices after filtering: ${filteredInvoices.length}`);
      console.log(`Payments after filtering: ${filteredPayments.length}`);

      if (filteredExpenses.length === 0 && filteredInvoices.length === 0 && filteredPayments.length === 0) {
        console.log('No financial records found for the selected period.');
        return {
          success: false,
          message: 'No financial records found for the selected period'
        };
      }

      // Step 5: Sort by date
      const sortedExpenses = sortByDate(filteredExpenses, 'asc');
      const sortedInvoices = sortInvoicesByDate(filteredInvoices, 'asc');
      const sortedPayments = sortPaymentsByDate(filteredPayments, 'asc');

      // Step 6: Calculate statistics
      const expenseStats = getExpenseStats(sortedExpenses);
      const incomeStats = getInvoiceStats(sortedInvoices);
      const paymentStats = getPaymentStats(sortedPayments);
      const totalExpenses = calculateTotal(sortedExpenses);
      const totalIncome = calculateInvoiceTotal(sortedInvoices);
      const totalPayments = calculatePaymentTotal(sortedPayments);
      const totalUnpaidBalance = unpaidInvoices.reduce((sum, inv) => sum + parseFloat(String(inv.balance || 0)), 0);
      const netAmount = totalPayments - totalExpenses; // Net is based on actual payments received
      
      console.log(`Total Invoiced: $${totalIncome.toFixed(2)}`);
      console.log(`Total Payments Received: $${totalPayments.toFixed(2)}`);
      console.log(`Total Expenses: $${totalExpenses.toFixed(2)}`);
      console.log(`Total Unpaid Balance: $${totalUnpaidBalance.toFixed(2)}`);
      console.log(`Net Amount (Payments - Expenses): $${netAmount.toFixed(2)}`);

      // Step 7: Group data for analysis
      const byCategory = groupByCategory(sortedExpenses);
      const byVendor = groupByVendor(sortedExpenses);
      const byClient = groupByClient(sortedInvoices);
      const paymentsByClient = groupPaymentsByClient(sortedPayments);
      console.log(`Expense Categories: ${Object.keys(byCategory).length}`);
      console.log(`Vendors: ${Object.keys(byVendor).length}`);
      console.log(`Clients: ${Object.keys(byClient).length}`);

      // Step 8: Generate PDF report
      console.log('Generating PDF report...');
      const reportTitle = process.env.REPORT_TITLE || 'HOA Financial Report';
      const periodString = formatPeriodString(period, dateRange);

      const pdfBuffer = await this.pdfGenerator.generateFinancialReport({
        expenses: sortedExpenses,
        invoices: sortedInvoices,
        payments: sortedPayments,
        unpaidInvoices: unpaidInvoices,
        title: reportTitle,
        period: periodString,
        totalExpenses: totalExpenses,
        totalIncome: totalIncome,
        totalPayments: totalPayments,
        totalUnpaidBalance: totalUnpaidBalance,
        netAmount: netAmount,
        generatedDate: new Date()
      });
      console.log('PDF generated successfully');

      // Step 9: Save to file if requested
      if (saveToFile) {
        await fs.writeFile(outputPath, pdfBuffer);
        console.log(`PDF saved to: ${outputPath}`);
      }

      // Step 10: Send email
      console.log('Sending email...');
      const emailSubject = `${reportTitle} - ${periodString}`;
      const emailText = this.generateEmailText(
        expenseStats, 
        incomeStats, 
        paymentStats, 
        totalExpenses, 
        totalIncome, 
        totalPayments,
        totalUnpaidBalance,
        netAmount, 
        periodString
      );
      const emailHtml = this.generateEmailHtml(
        expenseStats, 
        incomeStats, 
        paymentStats,
        totalExpenses, 
        totalIncome, 
        totalPayments,
        totalUnpaidBalance,
        netAmount, 
        periodString, 
        byCategory, 
        byClient,
        paymentsByClient,
        unpaidInvoices
      );
      const pdfFilename = `financial-report-${format(new Date(), 'yyyy-MM-dd')}.pdf`;

      await this.emailSender.sendFinancialReport({
        to: emailTo || undefined,
        subject: emailSubject,
        text: emailText,
        html: emailHtml,
        pdfBuffer: pdfBuffer,
        pdfFilename: pdfFilename
      });
      console.log('Email sent successfully');

      // Step 11: Cleanup
      await this.pdfGenerator.close();

      return {
        success: true,
        message: 'Report generated and sent successfully',
        stats: {
          expenseCount: expenseStats.count,
          incomeCount: incomeStats.count,
          paymentCount: paymentStats.count,
          unpaidInvoiceCount: unpaidInvoices.length,
          totalExpenses: totalExpenses,
          totalIncome: totalIncome,
          totalPayments: totalPayments,
          totalUnpaidBalance: totalUnpaidBalance,
          netAmount: netAmount,
          period: periodString
        }
      };

    } catch (error) {
      console.error('Error generating report:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Generate plain text email body
   */
  private generateEmailText(
    expenseStats: ExpenseStats,
    incomeStats: InvoiceStats,
    paymentStats: PaymentStats,
    totalExpenses: number,
    totalIncome: number,
    totalPayments: number,
    totalUnpaidBalance: number,
    netAmount: number,
    period: string
  ): string {
    return `
HOA Financial Report - ${period}

INVOICE SUMMARY:
- Total Invoices Issued: ${incomeStats.count}
- Total Invoiced Amount: $${totalIncome.toFixed(2)}
- Average Invoice: $${incomeStats.average.toFixed(2)}

PAYMENT SUMMARY (ACTUAL INCOME):
- Total Payments Received: ${paymentStats.count}
- Total Amount Received: $${totalPayments.toFixed(2)}
- Average Payment: $${paymentStats.average.toFixed(2)}

OUTSTANDING BALANCES:
- Total Unpaid/Partially Paid: $${totalUnpaidBalance.toFixed(2)}

EXPENSE SUMMARY:
- Total Expenses: ${expenseStats.count}
- Total Amount: $${totalExpenses.toFixed(2)}
- Average Expense: $${expenseStats.average.toFixed(2)}

NET RESULT (Payments Received - Expenses):
- Net Amount: $${netAmount.toFixed(2)} ${netAmount >= 0 ? '(Surplus)' : '(Deficit)'}

Please find the detailed financial report attached as a PDF.

This report was automatically generated by the HOA Financial Reporting System.
    `.trim();
  }

  /**
   * Generate HTML email body
   */
  private generateEmailHtml(
    expenseStats: ExpenseStats,
    incomeStats: InvoiceStats,
    paymentStats: PaymentStats,
    totalExpenses: number,
    totalIncome: number,
    totalPayments: number,
    totalUnpaidBalance: number,
    netAmount: number,
    period: string,
    byCategory: Record<string, GroupedExpenses>,
    byClient: Record<string, GroupedInvoices>,
    paymentsByClient: Record<string, GroupedPayments>,
    unpaidInvoices: Invoice[]
  ): string {
    const clientRows = Object.entries(byClient)
      .map(([client, data]) => `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${client}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">${data.invoices.length}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right; color: #27ae60;">$${data.total.toFixed(2)}</td>
        </tr>
      `).join('');

    const paymentClientRows = Object.entries(paymentsByClient)
      .map(([client, data]) => `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${client}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">${data.payments.length}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right; color: #27ae60;">$${data.total.toFixed(2)}</td>
        </tr>
      `).join('');

    const categoryRows = Object.entries(byCategory)
      .map(([category, data]) => `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${category}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">${data.expenses.length}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right; color: #e74c3c;">$${data.total.toFixed(2)}</td>
        </tr>
      `).join('');

    const unpaidRows = unpaidInvoices.slice(0, MAX_UNPAID_INVOICES_IN_EMAIL) // Show top unpaid in email
      .map((invoice) => {
        const balance = parseFloat(String(invoice.balance || 0));
        const client = invoice.client_name || invoice.client?.name || 'Unknown';
        const number = invoice.number || '-';
        return `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${number}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${client}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right; color: #e67e22;">$${balance.toFixed(2)}</td>
        </tr>
      `;
      }).join('');

    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    h1 { color: #2c3e50; }
    .summary { background-color: #ecf0f1; padding: 20px; border-radius: 5px; margin: 20px 0; }
    .summary-section { margin-bottom: 20px; }
    .summary-section h3 { margin-bottom: 10px; color: #34495e; }
    .summary-item { margin: 8px 0; }
    .net-result { font-size: 18px; font-weight: bold; padding: 15px; background-color: ${netAmount >= 0 ? '#d5f4e6' : '#fadbd8'}; border-radius: 5px; margin-top: 15px; }
    .income-color { color: #27ae60; }
    .payment-color { color: #3498db; }
    .expense-color { color: #e74c3c; }
    .unpaid-color { color: #e67e22; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background-color: #34495e; color: white; padding: 10px; text-align: left; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #7f8c8d; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>HOA Financial Report</h1>
    <p><strong>Period:</strong> ${period}</p>
    
    <div class="summary">
      <div class="summary-section">
        <h3 class="income-color">Invoices Issued</h3>
        <div class="summary-item"><strong>Total Invoices:</strong> ${incomeStats.count}</div>
        <div class="summary-item"><strong>Total Invoiced:</strong> <span class="income-color">$${totalIncome.toFixed(2)}</span></div>
        <div class="summary-item"><strong>Average Invoice:</strong> $${incomeStats.average.toFixed(2)}</div>
      </div>

      <div class="summary-section">
        <h3 class="payment-color">Payments Received (Actual Income)</h3>
        <div class="summary-item"><strong>Total Payments:</strong> ${paymentStats.count}</div>
        <div class="summary-item"><strong>Total Received:</strong> <span class="payment-color">$${totalPayments.toFixed(2)}</span></div>
        <div class="summary-item"><strong>Average Payment:</strong> $${paymentStats.average.toFixed(2)}</div>
      </div>

      <div class="summary-section">
        <h3 class="unpaid-color">Outstanding Balances</h3>
        <div class="summary-item"><strong>Unpaid/Partially Paid Invoices:</strong> ${unpaidInvoices.length}</div>
        <div class="summary-item"><strong>Total Outstanding:</strong> <span class="unpaid-color">$${totalUnpaidBalance.toFixed(2)}</span></div>
      </div>

      <div class="summary-section">
        <h3 class="expense-color">Expense Summary</h3>
        <div class="summary-item"><strong>Total Expenses:</strong> ${expenseStats.count}</div>
        <div class="summary-item"><strong>Total Amount:</strong> <span class="expense-color">$${totalExpenses.toFixed(2)}</span></div>
        <div class="summary-item"><strong>Average Expense:</strong> $${expenseStats.average.toFixed(2)}</div>
      </div>

      <div class="net-result">
        <strong>Net Amount (Payments - Expenses):</strong> $${netAmount.toFixed(2)} ${netAmount >= 0 ? '(Surplus)' : '(Deficit)'}
      </div>
    </div>

    ${Object.keys(byClient).length > 0 ? `
    <h2>Invoices Issued by Client</h2>
    <table>
      <thead>
        <tr>
          <th>Client</th>
          <th style="text-align: right;">Count</th>
          <th style="text-align: right;">Total</th>
        </tr>
      </thead>
      <tbody>
        ${clientRows}
      </tbody>
    </table>
    ` : ''}

    ${Object.keys(paymentsByClient).length > 0 ? `
    <h2>Payments Received by Client</h2>
    <table>
      <thead>
        <tr>
          <th>Client</th>
          <th style="text-align: right;">Count</th>
          <th style="text-align: right;">Total</th>
        </tr>
      </thead>
      <tbody>
        ${paymentClientRows}
      </tbody>
    </table>
    ` : ''}

    ${unpaidInvoices.length > 0 ? `
    <h2>Outstanding Invoices (Unpaid/Partially Paid)</h2>
    <table>
      <thead>
        <tr>
          <th>Invoice #</th>
          <th>Client</th>
          <th style="text-align: right;">Balance Due</th>
        </tr>
      </thead>
      <tbody>
        ${unpaidRows}
      </tbody>
    </table>
    ${unpaidInvoices.length > MAX_UNPAID_INVOICES_IN_EMAIL ? `<p><em>Showing top ${MAX_UNPAID_INVOICES_IN_EMAIL} of ${unpaidInvoices.length} unpaid invoices. See PDF for complete list.</em></p>` : ''}
    ` : ''}

    ${Object.keys(byCategory).length > 0 ? `
    <h2>Expenses by Category</h2>
    <table>
      <thead>
        <tr>
          <th>Category</th>
          <th style="text-align: right;">Count</th>
          <th style="text-align: right;">Total</th>
        </tr>
      </thead>
      <tbody>
        ${categoryRows}
      </tbody>
    </table>
    ` : ''}

    <p>Please find the detailed financial report attached as a PDF.</p>

    <div class="footer">
      <p>This report was automatically generated by the HOA Financial Reporting System.</p>
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Test connection to Invoice Ninja and Email
   */
  async testConnections(): Promise<ConnectionTestResult> {
    console.log('Testing connections...');

    try {
      // Test Invoice Ninja
      console.log('Testing Invoice Ninja API...');
      const expenses = await this.invoiceNinja.getExpenses({ per_page: 1 });
      console.log('✓ Invoice Ninja API connected');

      // Test Email
      console.log('Testing Email connection...');
      const emailVerified = await this.emailSender.verifyConnection();
      if (emailVerified) {
        console.log('✓ Email connection verified');
      } else {
        console.log('✗ Email connection failed');
      }

      return {
        invoiceNinja: true,
        email: emailVerified
      };
    } catch (error) {
      console.error('Connection test failed:', (error as Error).message);
      return {
        invoiceNinja: false,
        email: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * Test inform - Generate report and PDF without sending email
   * Prints data to screen and saves PDF to disk
   */
  async testInform(options: ReportOptions = {}): Promise<ReportResult> {
    const {
      period = (process.env.REPORT_PERIOD as PeriodType) || 'current-month',
      customRange = null,
      outputPath = './financial-report-test.pdf'
    } = options;

    try {
      console.log('═══════════════════════════════════════════════════════════');
      console.log('TEST INFORM - Financial Report Preview (No Email)');
      console.log('═══════════════════════════════════════════════════════════\n');

      // Step 1: Get date range
      const dateRange = getDateRange(period, customRange);
      console.log('📅 PERIOD INFORMATION:');
      console.log(`   Period Type: ${period}`);
      console.log(`   Date Range: ${dateRange.startISO} to ${dateRange.endISO}\n`);

      // Step 2: Fetch data from Invoice Ninja with date filters
      console.log('🔄 Fetching data from Invoice Ninja...');
      const allExpenses = await this.invoiceNinja.getExpenses({
        start_date: dateRange.startISO,
        end_date: dateRange.endISO
      });
      const allInvoices = await this.invoiceNinja.getInvoices({
        start_date: dateRange.startISO,
        end_date: dateRange.endISO
      });
      const allPayments = await this.invoiceNinja.getPayments({
        start_date: dateRange.startISO,
        end_date: dateRange.endISO
      });
      const allInvoicesEver = await this.invoiceNinja.getInvoices({});
      const unpaidInvoices = getUnpaidInvoices(allInvoicesEver);
      console.log(`   Total expenses fetched for period: ${allExpenses.length}`);
      console.log(`   Total invoices fetched for period: ${allInvoices.length}`);
      console.log(`   Total payments fetched for period: ${allPayments.length}`);
      console.log(`   Total unpaid/partially paid invoices: ${unpaidInvoices.length}`);

      // Step 3: Filter by date range (additional client-side filtering for safety)
      const filteredExpenses = filterExpensesByDate(allExpenses, dateRange.start, dateRange.end);
      const filteredInvoices = filterInvoicesByDate(allInvoices, dateRange.start, dateRange.end);
      const filteredPayments = filterPaymentsByDate(allPayments, dateRange.start, dateRange.end);
      console.log(`   Expenses after filtering: ${filteredExpenses.length}`);
      console.log(`   Invoices after filtering: ${filteredInvoices.length}`);
      console.log(`   Payments after filtering: ${filteredPayments.length}\n`);

      if (filteredExpenses.length === 0 && filteredInvoices.length === 0 && filteredPayments.length === 0) {
        console.log('⚠️  No financial records found for the selected period.\n');
        return {
          success: false,
          message: 'No financial records found for the selected period'
        };
      }

      // Step 4: Sort by date
      const sortedExpenses = sortByDate(filteredExpenses, 'asc');
      const sortedInvoices = sortInvoicesByDate(filteredInvoices, 'asc');
      const sortedPayments = sortPaymentsByDate(filteredPayments, 'asc');

      // Step 5: Calculate statistics
      const expenseStats = getExpenseStats(sortedExpenses);
      const incomeStats = getInvoiceStats(sortedInvoices);
      const paymentStats = getPaymentStats(sortedPayments);
      const totalExpenses = calculateTotal(sortedExpenses);
      const totalIncome = calculateInvoiceTotal(sortedInvoices);
      const totalPayments = calculatePaymentTotal(sortedPayments);
      const totalUnpaidBalance = unpaidInvoices.reduce((sum, inv) => sum + parseFloat(String(inv.balance || 0)), 0);
      const netAmount = totalPayments - totalExpenses;
      
      console.log('📊 FINANCIAL STATISTICS:');
      console.log('   INVOICES ISSUED:');
      console.log(`      Total Invoices: ${incomeStats.count}`);
      console.log(`      Total Invoiced: $${totalIncome.toFixed(2)}`);
      console.log(`      Average Invoice: $${incomeStats.average.toFixed(2)}`);
      console.log('');
      console.log('   PAYMENTS RECEIVED (ACTUAL INCOME):');
      console.log(`      Total Payments: ${paymentStats.count}`);
      console.log(`      Total Received: $${totalPayments.toFixed(2)}`);
      console.log(`      Average Payment: $${paymentStats.average.toFixed(2)}`);
      console.log('');
      console.log('   OUTSTANDING BALANCES:');
      console.log(`      Unpaid/Partially Paid Invoices: ${unpaidInvoices.length}`);
      console.log(`      Total Outstanding: $${totalUnpaidBalance.toFixed(2)}`);
      console.log('');
      console.log('   EXPENSES:');
      console.log(`      Total Expenses: ${expenseStats.count}`);
      console.log(`      Total Amount: $${totalExpenses.toFixed(2)}`);
      console.log(`      Average Expense: $${expenseStats.average.toFixed(2)}`);
      console.log('');
      console.log('   NET RESULT (Payments - Expenses):');
      console.log(`      Net Amount: $${netAmount.toFixed(2)} ${netAmount >= 0 ? '(Surplus)' : '(Deficit)'}\n`);

      // Step 6: Group data for analysis
      const byCategory = groupByCategory(sortedExpenses);
      const byVendor = groupByVendor(sortedExpenses);
      const byClient = groupByClient(sortedInvoices);
      const paymentsByClient = groupPaymentsByClient(sortedPayments);
      
      if (Object.keys(byClient).length > 0) {
        console.log('📋 INVOICES ISSUED BY CLIENT:');
        Object.entries(byClient).forEach(([client, data]) => {
          console.log(`   ${client}:`);
          console.log(`      Count: ${data.invoices.length}`);
          console.log(`      Total: $${data.total.toFixed(2)}`);
        });
        console.log('');
      }

      if (Object.keys(paymentsByClient).length > 0) {
        console.log('💵 PAYMENTS RECEIVED BY CLIENT:');
        Object.entries(paymentsByClient).forEach(([client, data]) => {
          console.log(`   ${client}:`);
          console.log(`      Count: ${data.payments.length}`);
          console.log(`      Total: $${data.total.toFixed(2)}`);
        });
        console.log('');
      }

      if (unpaidInvoices.length > 0) {
        console.log('⚠️  OUTSTANDING INVOICES (TOP 10):');
        unpaidInvoices.slice(0, MAX_UNPAID_INVOICES_IN_EMAIL).forEach((invoice) => {
          const balance = parseFloat(String(invoice.balance || 0));
          const client = invoice.client_name || invoice.client?.name || 'Unknown';
          const number = invoice.number || '-';
          console.log(`   Invoice #${number} - ${client}: $${balance.toFixed(2)}`);
        });
        if (unpaidInvoices.length > MAX_UNPAID_INVOICES_IN_EMAIL) {
          console.log(`   ... and ${unpaidInvoices.length - MAX_UNPAID_INVOICES_IN_EMAIL} more`);
        }
        console.log('');
      }

      if (Object.keys(byCategory).length > 0) {
        console.log('📋 EXPENSES BY CATEGORY:');
        Object.entries(byCategory).forEach(([category, data]) => {
          console.log(`   ${category}:`);
          console.log(`      Count: ${data.expenses.length}`);
          console.log(`      Total: $${data.total.toFixed(2)}`);
        });
        console.log('');
      }

      if (Object.keys(byVendor).length > 0) {
        console.log('🏢 EXPENSES BY VENDOR:');
        Object.entries(byVendor).forEach(([vendor, data]) => {
          console.log(`   ${vendor}:`);
          console.log(`      Count: ${data.expenses.length}`);
          console.log(`      Total: $${data.total.toFixed(2)}`);
        });
        console.log('');
      }

      if (sortedInvoices.length > 0) {
        console.log('💰 INVOICE DETAILS:');
        sortedInvoices.forEach((invoice, index) => {
          const invoiceDate = format(new Date(invoice.date || invoice.invoice_date || ''), 'yyyy-MM-dd');
          const description = invoice.public_notes || '-';
          const client = invoice.client_name || invoice.client?.name || '-';
          const number = invoice.number || '-';
          const amount = parseFloat(String(invoice.amount || 0)).toFixed(2);
          console.log(`   ${index + 1}. [${invoiceDate}] Invoice #${number}`);
          console.log(`      Client: ${client} | Amount: $${amount}`);
          if (description !== '-') console.log(`      Description: ${description}`);
        });
        console.log('');
      }

      if (sortedPayments.length > 0) {
        console.log('💵 PAYMENT DETAILS:');
        sortedPayments.forEach((payment, index) => {
          const paymentDate = format(new Date(payment.date || payment.payment_date || ''), 'yyyy-MM-dd');
          const client = payment.client_name || payment.client?.name || '-';
          const amount = parseFloat(String(payment.amount || 0)).toFixed(2);
          const reference = payment.transaction_reference || '-';
          console.log(`   ${index + 1}. [${paymentDate}] Payment from ${client}`);
          console.log(`      Amount: $${amount} | Reference: ${reference}`);
        });
        console.log('');
      }

      if (sortedExpenses.length > 0) {
        console.log('📝 EXPENSE DETAILS:');
        sortedExpenses.forEach((expense, index) => {
          const expenseDate = format(new Date(expense.date || expense.expense_date || ''), 'yyyy-MM-dd');
          const description = expense.public_notes || expense.description || '-';
          const vendor = expense.vendor_name || expense.vendor?.name || '-';
          const category = expense.category_name || expense.category?.name || '-';
          const amount = parseFloat(String(expense.amount || 0)).toFixed(2);
          console.log(`   ${index + 1}. [${expenseDate}] ${description}`);
          console.log(`      Vendor: ${vendor} | Category: ${category} | Amount: $${amount}`);
        });
        console.log('');
      }

      // Step 7: Generate PDF report
      console.log('📄 Generating PDF report...');
      const reportTitle = process.env.REPORT_TITLE || 'HOA Financial Report';
      const periodString = formatPeriodString(period, dateRange);

      const pdfBuffer = await this.pdfGenerator.generateFinancialReport({
        expenses: sortedExpenses,
        invoices: sortedInvoices,
        payments: sortedPayments,
        unpaidInvoices: unpaidInvoices,
        title: reportTitle,
        period: periodString,
        totalExpenses: totalExpenses,
        totalIncome: totalIncome,
        totalPayments: totalPayments,
        totalUnpaidBalance: totalUnpaidBalance,
        netAmount: netAmount,
        generatedDate: new Date()
      });

      // Step 8: Save PDF to file
      await fs.writeFile(outputPath, pdfBuffer);
      console.log(`✓ PDF generated and saved to: ${outputPath}\n`);

      // Step 9: Cleanup
      await this.pdfGenerator.close();

      console.log('═══════════════════════════════════════════════════════════');
      console.log('✓ TEST INFORM COMPLETED SUCCESSFULLY');
      console.log('═══════════════════════════════════════════════════════════\n');

      return {
        success: true,
        message: 'Test inform completed successfully',
        stats: {
          expenseCount: expenseStats.count,
          incomeCount: incomeStats.count,
          paymentCount: paymentStats.count,
          unpaidInvoiceCount: unpaidInvoices.length,
          totalExpenses: totalExpenses,
          totalIncome: totalIncome,
          totalPayments: totalPayments,
          totalUnpaidBalance: totalUnpaidBalance,
          netAmount: netAmount,
          period: periodString
        }
      };

    } catch (error) {
      console.error('\n✗ Error during test inform:', (error as Error).message);
      throw error;
    }
  }
}

// Main execution
async function main(): Promise<void> {
  const automation = new HOAInformAutomation();

  // Parse command line arguments
  const args = process.argv.slice(2);
  const command = args[0] || 'report';

  try {
    if (command === 'test') {
      // Test connections
      await automation.testConnections();
    } else if (command === 'test-inform') {
      // Test inform - Generate report without sending email
      const period = (args[1] as PeriodType) || (process.env.REPORT_PERIOD as PeriodType) || 'current-month';
      const result = await automation.testInform({
        period: period,
        outputPath: './financial-report-test.pdf'
      });
      if (result.stats) {
        console.log('Report Summary:');
        console.log(`  Period: ${result.stats.period}`);
        console.log(`  Invoices: ${result.stats.incomeCount} issued, $${result.stats.totalIncome.toFixed(2)}`);
        console.log(`  Payments: ${result.stats.paymentCount} received, $${result.stats.totalPayments.toFixed(2)}`);
        console.log(`  Outstanding: ${result.stats.unpaidInvoiceCount} invoices, $${result.stats.totalUnpaidBalance.toFixed(2)}`);
        console.log(`  Expenses: ${result.stats.expenseCount} items, $${result.stats.totalExpenses.toFixed(2)}`);
        console.log(`  Net: $${result.stats.netAmount.toFixed(2)} ${result.stats.netAmount >= 0 ? '(Surplus)' : '(Deficit)'}`);
      }
    } else if (command === 'report') {
      // Generate and send report
      const period = (args[1] as PeriodType) || (process.env.REPORT_PERIOD as PeriodType) || 'current-month';
      const result = await automation.generateAndSendReport({
        period: period,
        saveToFile: true
      });
      if (result.stats) {
        console.log('\n✓ Report generation completed successfully!');
        console.log(`  Period: ${result.stats.period}`);
        console.log(`  Invoices: ${result.stats.incomeCount} issued, $${result.stats.totalIncome.toFixed(2)}`);
        console.log(`  Payments: ${result.stats.paymentCount} received, $${result.stats.totalPayments.toFixed(2)}`);
        console.log(`  Outstanding: ${result.stats.unpaidInvoiceCount} invoices, $${result.stats.totalUnpaidBalance.toFixed(2)}`);
        console.log(`  Expenses: ${result.stats.expenseCount} items, $${result.stats.totalExpenses.toFixed(2)}`);
        console.log(`  Net: $${result.stats.netAmount.toFixed(2)} ${result.stats.netAmount >= 0 ? '(Surplus)' : '(Deficit)'}`);
      }
    } else {
      console.log('Unknown command. Usage:');
      console.log('  npm start test              - Test connections');
      console.log('  npm start test-inform [period] - Test report (no email)');
      console.log('  npm start report [period]   - Generate and send report');
      console.log('  Periods: current-month, last-month, current-year, last-year');
    }
  } catch (error) {
    console.error('\n✗ Error:', (error as Error).message);
    process.exit(1);
  }
}

// Run main function if this is the entry point
// Convert process.argv[1] to a file URL for comparison
import { pathToFileURL } from 'url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export default HOAInformAutomation;
