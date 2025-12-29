import dotenv from 'dotenv';
import { format } from 'date-fns';
import InvoiceNinjaClient from './lib/invoiceNinjaClient.js';
import PDFGenerator from './lib/pdfGenerator.js';
import EmailSender from './lib/emailSender.js';
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
 * Main Application Class
 * Coordinates the expense automation workflow
 */
class HOAExpenseAutomation {
  constructor() {
    this.invoiceNinja = new InvoiceNinjaClient();
    this.pdfGenerator = new PDFGenerator();
    this.emailSender = new EmailSender();
  }

  /**
   * Generate and send expense report
   * @param {Object} options - Report options
   * @param {string} options.period - Report period ('current-month', 'last-month', 'current-year', 'last-year', 'custom')
   * @param {Object} options.customRange - Custom date range for 'custom' period
   * @param {string} options.emailTo - Recipient email address(es)
   * @param {boolean} options.saveToFile - Whether to save PDF to file
   * @param {string} options.outputPath - Output path for PDF file
   */
  async generateAndSendReport(options = {}) {
    const {
      period = process.env.REPORT_PERIOD || 'current-month',
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
        const fs = await import('fs');
        await fs.promises.writeFile(outputPath, pdfBuffer);
        console.log(`PDF saved to: ${outputPath}`);
      }

      // Step 9: Send email
      console.log('Sending email...');
      const emailSubject = `${reportTitle} - ${periodString}`;
      const emailText = this.generateEmailText(stats, totalAmount, periodString);
      const emailHtml = this.generateEmailHtml(stats, totalAmount, periodString, byCategory);
      const pdfFilename = `expense-report-${format(new Date(), 'yyyy-MM-dd')}.pdf`;

      await this.emailSender.sendExpenseReport({
        to: emailTo,
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
      console.error('Error generating report:', error.message);
      throw error;
    }
  }

  /**
   * Generate plain text email body
   * @private
   */
  generateEmailText(stats, totalAmount, period) {
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
   * @private
   */
  generateEmailHtml(stats, totalAmount, period, byCategory) {
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
  async testConnections() {
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
      console.error('Connection test failed:', error.message);
      return {
        invoiceNinja: false,
        email: false,
        error: error.message
      };
    }
  }
}

// Main execution
async function main() {
  const automation = new HOAExpenseAutomation();

  // Parse command line arguments
  const args = process.argv.slice(2);
  const command = args[0] || 'report';

  try {
    if (command === 'test') {
      // Test connections
      await automation.testConnections();
    } else if (command === 'report') {
      // Generate and send report
      const period = args[1] || process.env.REPORT_PERIOD || 'current-month';
      const result = await automation.generateAndSendReport({
        period: period,
        saveToFile: true
      });
      console.log('\n✓ Report generation completed successfully!');
      console.log(`  Period: ${result.stats.period}`);
      console.log(`  Expenses: ${result.stats.count}`);
      console.log(`  Total: $${result.stats.total.toFixed(2)}`);
    } else {
      console.log('Unknown command. Usage:');
      console.log('  node src/index.js test          - Test connections');
      console.log('  node src/index.js report [period] - Generate report');
      console.log('  Periods: current-month, last-month, current-year, last-year');
    }
  } catch (error) {
    console.error('\n✗ Error:', error.message);
    process.exit(1);
  }
}

// Run main function if this is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export default HOAExpenseAutomation;
