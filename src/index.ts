import dotenv from 'dotenv';
import { format } from 'date-fns';
import { promises as fs } from 'fs';
import InvoiceNinjaClient from './lib/invoiceNinjaClient.js';
import PDFGenerator from './lib/pdfGenerator.js';
import EmailSender from './lib/emailSender.js';
import type { Expense } from './lib/invoiceNinjaClient.js';
import type { ExpenseStats, PeriodType, CustomRange, GroupedExpenses } from './lib/dataUtils.js';
import {
  getDateRange,
  filterExpensesByDate,
  calculateTotal,
  groupByCategory,
  groupByVendor,
  sortByDate,
  getExpenseStats,
  formatPeriodString
} from './lib/dataUtils.js';

// Load environment variables
dotenv.config();

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
    count: number;
    total: number;
    average: number;
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
 * Coordinates the expense automation workflow
 */
class HOAExpenseAutomation {
  private invoiceNinja: InvoiceNinjaClient;
  private pdfGenerator: PDFGenerator;
  private emailSender: EmailSender;

  constructor() {
    this.invoiceNinja = new InvoiceNinjaClient();
    this.pdfGenerator = new PDFGenerator();
    this.emailSender = new EmailSender();
  }

  /**
   * Generate and send expense report
   */
  async generateAndSendReport(options: ReportOptions = {}): Promise<ReportResult> {
    const {
      period = (process.env.REPORT_PERIOD as PeriodType) || 'current-month',
      customRange = null,
      emailTo = null,
      saveToFile = false,
      outputPath = './expense-report.pdf'
    } = options;

    try {
      console.log('Starting HOA Expense Report Generation...');
      console.log(`Period: ${period}`);

      // Step 1: Get date range
      const dateRange = getDateRange(period, customRange);
      console.log(`Date range: ${dateRange.startISO} to ${dateRange.endISO}`);

      // Step 2: Fetch expenses from Invoice Ninja
      console.log('Fetching expenses from Invoice Ninja...');
      const allExpenses = await this.invoiceNinja.getExpenses();
      console.log(`Total expenses in system: ${allExpenses.length}`);

      // Step 3: Filter expenses by date range
      const filteredExpenses = filterExpensesByDate(allExpenses, dateRange.start, dateRange.end);
      console.log(`Expenses in selected period: ${filteredExpenses.length}`);

      if (filteredExpenses.length === 0) {
        console.log('No expenses found for the selected period.');
        return {
          success: false,
          message: 'No expenses found for the selected period'
        };
      }

      // Step 4: Sort expenses by date
      const sortedExpenses = sortByDate(filteredExpenses, 'asc');

      // Step 5: Calculate statistics
      const stats = getExpenseStats(sortedExpenses);
      const totalAmount = calculateTotal(sortedExpenses);
      console.log(`Total amount: $${totalAmount.toFixed(2)}`);
      console.log(`Average expense: $${stats.average.toFixed(2)}`);

      // Step 6: Group data for analysis
      const byCategory = groupByCategory(sortedExpenses);
      const byVendor = groupByVendor(sortedExpenses);
      console.log(`Categories: ${Object.keys(byCategory).length}`);
      console.log(`Vendors: ${Object.keys(byVendor).length}`);

      // Step 7: Generate PDF report
      console.log('Generating PDF report...');
      const reportTitle = process.env.REPORT_TITLE || 'HOA Expense Report';
      const periodString = formatPeriodString(period, dateRange);

      const pdfBuffer = await this.pdfGenerator.generateExpenseReport({
        expenses: sortedExpenses,
        title: reportTitle,
        period: periodString,
        totalAmount: totalAmount,
        generatedDate: new Date()
      });
      console.log('PDF generated successfully');

      // Step 8: Save to file if requested
      if (saveToFile) {
        await fs.writeFile(outputPath, pdfBuffer);
        console.log(`PDF saved to: ${outputPath}`);
      }

      // Step 9: Send email
      console.log('Sending email...');
      const emailSubject = `${reportTitle} - ${periodString}`;
      const emailText = this.generateEmailText(stats, totalAmount, periodString);
      const emailHtml = this.generateEmailHtml(stats, totalAmount, periodString, byCategory);
      const pdfFilename = `expense-report-${format(new Date(), 'yyyy-MM-dd')}.pdf`;

      await this.emailSender.sendExpenseReport({
        to: emailTo || undefined,
        subject: emailSubject,
        text: emailText,
        html: emailHtml,
        pdfBuffer: pdfBuffer,
        pdfFilename: pdfFilename
      });
      console.log('Email sent successfully');

      // Step 10: Cleanup
      await this.pdfGenerator.close();

      return {
        success: true,
        message: 'Report generated and sent successfully',
        stats: {
          count: stats.count,
          total: totalAmount,
          average: stats.average,
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
  private generateEmailText(stats: ExpenseStats, totalAmount: number, period: string): string {
    return `
HOA Expense Report - ${period}

Summary:
- Total Expenses: ${stats.count}
- Total Amount: $${totalAmount.toFixed(2)}
- Average Expense: $${stats.average.toFixed(2)}
- Min Expense: $${stats.min.toFixed(2)}
- Max Expense: $${stats.max.toFixed(2)}

Please find the detailed expense report attached as a PDF.

This report was automatically generated by the HOA Expense Automation System.
    `.trim();
  }

  /**
   * Generate HTML email body
   */
  private generateEmailHtml(
    stats: ExpenseStats,
    totalAmount: number,
    period: string,
    byCategory: Record<string, GroupedExpenses>
  ): string {
    const categoryRows = Object.entries(byCategory)
      .map(([category, data]) => `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${category}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">${data.expenses.length}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">$${data.total.toFixed(2)}</td>
        </tr>
      `).join('');

    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    h1 { color: #2c3e50; }
    .summary { background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0; }
    .summary-item { margin: 8px 0; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background-color: #34495e; color: white; padding: 10px; text-align: left; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #7f8c8d; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>HOA Expense Report</h1>
    <p><strong>Period:</strong> ${period}</p>
    
    <div class="summary">
      <h2>Summary</h2>
      <div class="summary-item"><strong>Total Expenses:</strong> ${stats.count}</div>
      <div class="summary-item"><strong>Total Amount:</strong> $${totalAmount.toFixed(2)}</div>
      <div class="summary-item"><strong>Average Expense:</strong> $${stats.average.toFixed(2)}</div>
      <div class="summary-item"><strong>Min Expense:</strong> $${stats.min.toFixed(2)}</div>
      <div class="summary-item"><strong>Max Expense:</strong> $${stats.max.toFixed(2)}</div>
    </div>

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

    <p>Please find the detailed expense report attached as a PDF.</p>

    <div class="footer">
      <p>This report was automatically generated by the HOA Expense Automation System.</p>
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
      outputPath = './expense-report-test.pdf'
    } = options;

    try {
      console.log('═══════════════════════════════════════════════════════════');
      console.log('TEST INFORM - Report Preview (No Email)');
      console.log('═══════════════════════════════════════════════════════════\n');

      // Step 1: Get date range
      const dateRange = getDateRange(period, customRange);
      console.log('📅 PERIOD INFORMATION:');
      console.log(`   Period Type: ${period}`);
      console.log(`   Date Range: ${dateRange.startISO} to ${dateRange.endISO}\n`);

      // Step 2: Fetch expenses from Invoice Ninja
      console.log('🔄 Fetching expenses from Invoice Ninja...');
      const allExpenses = await this.invoiceNinja.getExpenses();
      console.log(`   Total expenses in system: ${allExpenses.length}`);

      // Step 3: Filter expenses by date range
      const filteredExpenses = filterExpensesByDate(allExpenses, dateRange.start, dateRange.end);
      console.log(`   Expenses in selected period: ${filteredExpenses.length}\n`);

      if (filteredExpenses.length === 0) {
        console.log('⚠️  No expenses found for the selected period.\n');
        return {
          success: false,
          message: 'No expenses found for the selected period'
        };
      }

      // Step 4: Sort expenses by date
      const sortedExpenses = sortByDate(filteredExpenses, 'asc');

      // Step 5: Calculate statistics
      const stats = getExpenseStats(sortedExpenses);
      const totalAmount = calculateTotal(sortedExpenses);
      
      console.log('📊 EXPENSE STATISTICS:');
      console.log(`   Total Expenses: ${stats.count}`);
      console.log(`   Total Amount: $${totalAmount.toFixed(2)}`);
      console.log(`   Average Expense: $${stats.average.toFixed(2)}`);
      console.log(`   Min Expense: $${stats.min.toFixed(2)}`);
      console.log(`   Max Expense: $${stats.max.toFixed(2)}\n`);

      // Step 6: Group data for analysis
      const byCategory = groupByCategory(sortedExpenses);
      const byVendor = groupByVendor(sortedExpenses);
      
      console.log('📋 EXPENSES BY CATEGORY:');
      Object.entries(byCategory).forEach(([category, data]) => {
        console.log(`   ${category}:`);
        console.log(`      Count: ${data.expenses.length}`);
        console.log(`      Total: $${data.total.toFixed(2)}`);
      });
      console.log('');

      console.log('🏢 EXPENSES BY VENDOR:');
      Object.entries(byVendor).forEach(([vendor, data]) => {
        console.log(`   ${vendor}:`);
        console.log(`      Count: ${data.expenses.length}`);
        console.log(`      Total: $${data.total.toFixed(2)}`);
      });
      console.log('');

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

      // Step 7: Generate PDF report
      console.log('📄 Generating PDF report...');
      const reportTitle = process.env.REPORT_TITLE || 'HOA Expense Report';
      const periodString = formatPeriodString(period, dateRange);

      const pdfBuffer = await this.pdfGenerator.generateExpenseReport({
        expenses: sortedExpenses,
        title: reportTitle,
        period: periodString,
        totalAmount: totalAmount,
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
          count: stats.count,
          total: totalAmount,
          average: stats.average,
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
  const automation = new HOAExpenseAutomation();

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
        outputPath: './expense-report-test.pdf'
      });
      if (result.stats) {
        console.log('Report Summary:');
        console.log(`  Period: ${result.stats.period}`);
        console.log(`  Expenses: ${result.stats.count}`);
        console.log(`  Total: $${result.stats.total.toFixed(2)}`);
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
        console.log(`  Expenses: ${result.stats.count}`);
        console.log(`  Total: $${result.stats.total.toFixed(2)}`);
      }
    } else {
      console.log('Unknown command. Usage:');
      console.log('  node dist/index.js test              - Test connections');
      console.log('  node dist/index.js test-inform [period] - Test report (no email)');
      console.log('  node dist/index.js report [period]   - Generate and send report');
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

export default HOAExpenseAutomation;
