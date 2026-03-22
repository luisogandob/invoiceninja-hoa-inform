import dotenv from 'dotenv';
import { format } from 'date-fns';
import { promises as fs } from 'fs';
import InvoiceNinjaClient from './lib/invoiceNinjaClient.js';
import EmailSender from './lib/emailSender.js';
import HoaReportGenerator from './lib/hoaReportGenerator.js';
import { buildHoaReportData } from './lib/hoaReportData.js';
import type { PeriodType, CustomRange } from './lib/dataUtils.js';
import {
  getDateRange,
  filterInvoicesByDate,
  filterPaymentsByDate,
  filterExpensesByDate,
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
    incomeCount: number;
    paymentCount: number;
    unpaidInvoiceCount: number;
    totalIncome: number;
    totalPayments: number;
    totalUnpaidBalance: number;
    arAtPeriodStart: number;
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
 * Coordinates the HOA financial reporting workflow
 */
class HOAInformAutomation {
  private invoiceNinja: InvoiceNinjaClient;
  private emailSender: EmailSender;
  private hoaReportGenerator: HoaReportGenerator;

  constructor() {
    this.invoiceNinja = new InvoiceNinjaClient();
    this.emailSender = new EmailSender();
    this.hoaReportGenerator = new HoaReportGenerator();
  }

  /**
   * Generate and send the HOA income report as a PDF via email.
   *
   * Report sections:
   *  1. Header  — title, period dates, generation date
   *  2. KPI totals — cuotas emitidas, pagos recibidos, CxC inicio, CxC final
   *  3. Bar chart — payments received in period by client
   *  4. Bar chart — accounts receivable at end of period by client
   */
  async generateAndSendReport(options: ReportOptions = {}): Promise<ReportResult> {
    const {
      period = (process.env.REPORT_PERIOD as PeriodType) || 'current-month',
      customRange = null,
      emailTo = null,
      saveToFile = false,
      outputPath = './hoa-report.pdf'
    } = options;

    try {
      console.log('Starting HOA Report Generation...');

      const dateRange = getDateRange(period, customRange);
      console.log(`Date range: ${dateRange.startISO} to ${dateRange.endISO}`);

      console.log('Fetching invoices for period...');
      const periodInvoices = await this.invoiceNinja.getInvoices({
        start_date: dateRange.startISO,
        end_date: dateRange.endISO
      });
      const filteredPeriodInvoices = filterInvoicesByDate(periodInvoices, dateRange.start, dateRange.end);

      console.log('Fetching payments for period...');
      const periodPayments = await this.invoiceNinja.getPayments({
        start_date: dateRange.startISO,
        end_date: dateRange.endISO,
        include: 'invoices'
      });
      const filteredPeriodPayments = filterPaymentsByDate(periodPayments, dateRange.start, dateRange.end);

      console.log('Fetching expenses for period...');
      const periodExpenses = await this.invoiceNinja.getExpenses({
        start_date: dateRange.startISO,
        end_date: dateRange.endISO
      });
      const filteredPeriodExpenses = filterExpensesByDate(periodExpenses, dateRange.start, dateRange.end);

      console.log('Fetching all invoices for AR calculation...');
      const allInvoices = await this.invoiceNinja.getInvoices({});

      console.log('Fetching all expenses for AP calculation...');
      const allExpenses = await this.invoiceNinja.getExpenses({});

      console.log('Fetching all clients and client groups...');
      const [allClients, clientGroups] = await Promise.all([
        this.invoiceNinja.getClients(),
        this.invoiceNinja.getClientGroups()
      ]);

      const reportTitle = process.env.REPORT_TITLE || 'Informe HOA';
      const reportData = buildHoaReportData(
        allInvoices,
        filteredPeriodInvoices,
        filteredPeriodPayments,
        filteredPeriodExpenses,
        allExpenses,
        allClients,
        clientGroups,
        dateRange.start,
        dateRange.end,
        reportTitle,
        new Date()
      );

      console.log(`Cuotas emitidas: $${reportData.totalInvoicedInPeriod.toFixed(2)}`);
      console.log(`Pagos recibidos: $${reportData.totalPaymentsInPeriod.toFixed(2)}`);
      console.log(`Gastos:          $${reportData.totalExpensesInPeriod.toFixed(2)}`);
      console.log(`CxC inicio:      $${reportData.arAtPeriodStart.toFixed(2)}`);
      console.log(`CxC final:       $${reportData.arAtPeriodEnd.toFixed(2)}`);

      console.log('Generating PDF...');
      const pdfBuffer = await this.hoaReportGenerator.generatePdf(reportData);

      if (saveToFile) {
        await fs.writeFile(outputPath, pdfBuffer);
        console.log(`PDF saved to: ${outputPath}`);
      }

      const periodString = formatPeriodString(period, dateRange);
      const emailSubject = `${reportTitle} - ${periodString}`;
      const emailText = [
        `${reportTitle} — ${periodString}`,
        '',
        `Cuotas Emitidas en el Período:           $${reportData.totalInvoicedInPeriod.toFixed(2)}`,
        `Pagos Recibidos en el Período:           $${reportData.totalPaymentsInPeriod.toFixed(2)}`,
        `Gastos del Período:                      $${reportData.totalExpensesInPeriod.toFixed(2)}`,
        `Cuentas x Cobrar al Inicio del Período:  $${reportData.arAtPeriodStart.toFixed(2)}`,
        `Cuentas x Cobrar al Final del Período:   $${reportData.arAtPeriodEnd.toFixed(2)}`,
        '',
        'Ver el reporte adjunto en PDF para los detalles por cliente.'
      ].join('\n');

      await this.emailSender.sendFinancialReport({
        to: emailTo || undefined,
        subject: emailSubject,
        text: emailText,
        html: `<pre style="font-family:monospace">${emailText}</pre>`,
        pdfBuffer,
        pdfFilename: `hoa-report-${format(new Date(), 'yyyy-MM-dd')}.pdf`
      });
      console.log('Email sent successfully');

      await this.hoaReportGenerator.close();

      const unpaidCount = allInvoices.filter(inv => parseFloat(String(inv.balance || 0)) > 0).length;

      return {
        success: true,
        message: 'Report generated and sent successfully',
        stats: {
          incomeCount: filteredPeriodInvoices.length,
          paymentCount: filteredPeriodPayments.length,
          unpaidInvoiceCount: unpaidCount,
          totalIncome: reportData.totalInvoicedInPeriod,
          totalPayments: reportData.totalPaymentsInPeriod,
          totalUnpaidBalance: reportData.arAtPeriodEnd,
          arAtPeriodStart: reportData.arAtPeriodStart,
          period: periodString
        }
      };
    } catch (error) {
      console.error('Error generating report:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Preview the HOA report: print KPIs to console and save PDF to disk
   * without sending email.
   */
  async testInform(options: ReportOptions = {}): Promise<ReportResult> {
    const {
      period = (process.env.REPORT_PERIOD as PeriodType) || 'current-month',
      customRange = null,
      outputPath = './hoa-report-test.pdf'
    } = options;

    try {
      console.log('═══════════════════════════════════════════════════════════');
      console.log('TEST INFORM — HOA Report Preview (No Email)');
      console.log('═══════════════════════════════════════════════════════════\n');

      const dateRange = getDateRange(period, customRange);
      console.log(`📅 Período: ${dateRange.startISO} → ${dateRange.endISO}\n`);

      console.log('🔄 Fetching data from Invoice Ninja...');
      const periodInvoices = await this.invoiceNinja.getInvoices({
        start_date: dateRange.startISO,
        end_date: dateRange.endISO
      });
      const filteredPeriodInvoices = filterInvoicesByDate(periodInvoices, dateRange.start, dateRange.end);

      const periodPayments = await this.invoiceNinja.getPayments({
        start_date: dateRange.startISO,
        end_date: dateRange.endISO,
        include: 'invoices'
      });
      const filteredPeriodPayments = filterPaymentsByDate(periodPayments, dateRange.start, dateRange.end);

      const periodExpenses = await this.invoiceNinja.getExpenses({
        start_date: dateRange.startISO,
        end_date: dateRange.endISO
      });
      const filteredPeriodExpenses = filterExpensesByDate(periodExpenses, dateRange.start, dateRange.end);

      const allInvoices = await this.invoiceNinja.getInvoices({});
      const allExpenses = await this.invoiceNinja.getExpenses({});
      console.log(`   Facturas en período: ${filteredPeriodInvoices.length}`);
      console.log(`   Pagos en período:    ${filteredPeriodPayments.length}`);
      console.log(`   Gastos en período:   ${filteredPeriodExpenses.length}`);
      console.log(`   Total facturas:      ${allInvoices.length}`);
      console.log(`   Total gastos:        ${allExpenses.length}\n`);

      const [allClients, clientGroups] = await Promise.all([
        this.invoiceNinja.getClients(),
        this.invoiceNinja.getClientGroups()
      ]);
      console.log(`   Clientes totales:    ${allClients.length}`);
      console.log(`   Grupos de clientes:  ${clientGroups.length}\n`);

      const reportTitle = process.env.REPORT_TITLE || 'Informe HOA';
      const reportData = buildHoaReportData(
        allInvoices,
        filteredPeriodInvoices,
        filteredPeriodPayments,
        filteredPeriodExpenses,
        allExpenses,
        allClients,
        clientGroups,
        dateRange.start,
        dateRange.end,
        reportTitle,
        new Date()
      );

      console.log('📊 TOTALES:');
      console.log(`   Cuotas Emitidas en el Período:          $${reportData.totalInvoicedInPeriod.toFixed(2)}`);
      console.log(`   Pagos Recibidos en el Período:          $${reportData.totalPaymentsInPeriod.toFixed(2)}`);
      console.log(`   Gastos del Período:                     $${reportData.totalExpensesInPeriod.toFixed(2)}`);
      console.log(`   Cuentas x Cobrar — Inicio del Período:  $${reportData.arAtPeriodStart.toFixed(2)}`);
      console.log(`   Cuentas x Cobrar — Final del Período:   $${reportData.arAtPeriodEnd.toFixed(2)}`);
      console.log(`   Cuentas x Pagar  — Inicio del Período:  $${reportData.apAtPeriodStart.toFixed(2)}`);
      console.log(`   Cuentas x Pagar  — Final del Período:   $${reportData.apAtPeriodEnd.toFixed(2)}\n`);

      if (reportData.paymentsByGroup.length > 0) {
        console.log('💵 PAGOS POR GRUPO DE CLIENTES:');
        reportData.paymentsByGroup.forEach(p => {
          console.log(`   ${p.groupName}: $${p.total.toFixed(2)}`);
        });
        console.log('');
      }

      if (reportData.arByGroup.length > 0) {
        console.log('📋 CUENTAS x COBRAR POR GRUPO DE CLIENTES:');
        reportData.arByGroup.forEach(a => {
          console.log(`   ${a.groupName}: $${a.balance.toFixed(2)}`);
        });
        console.log('');
      }

      console.log('📄 Generating PDF...');
      const pdfBuffer = await this.hoaReportGenerator.generatePdf(reportData);
      await fs.writeFile(outputPath, pdfBuffer);
      console.log(`✓ PDF saved to: ${outputPath}\n`);

      await this.hoaReportGenerator.close();

      const periodString = formatPeriodString(period, dateRange);
      console.log('═══════════════════════════════════════════════════════════');
      console.log('✓ TEST INFORM COMPLETED SUCCESSFULLY');
      console.log('═══════════════════════════════════════════════════════════\n');

      const unpaidCount = allInvoices.filter(inv => parseFloat(String(inv.balance || 0)) > 0).length;

      return {
        success: true,
        message: 'Test inform completed successfully',
        stats: {
          incomeCount: filteredPeriodInvoices.length,
          paymentCount: filteredPeriodPayments.length,
          unpaidInvoiceCount: unpaidCount,
          totalIncome: reportData.totalInvoicedInPeriod,
          totalPayments: reportData.totalPaymentsInPeriod,
          totalUnpaidBalance: reportData.arAtPeriodEnd,
          arAtPeriodStart: reportData.arAtPeriodStart,
          period: periodString
        }
      };
    } catch (error) {
      console.error('\n✗ Error during test inform:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Test connection to Invoice Ninja and Email
   */
  async testConnections(): Promise<ConnectionTestResult> {
    console.log('Testing connections...');

    try {
      console.log('Testing Invoice Ninja API...');
      await this.invoiceNinja.getInvoices({ per_page: 1 });
      console.log('✓ Invoice Ninja API connected');

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
}

// Main execution
async function main(): Promise<void> {
  const automation = new HOAInformAutomation();

  const args = process.argv.slice(2);
  const command = args[0] || 'report';

  try {
    if (command === 'test') {
      await automation.testConnections();
    } else if (command === 'test-inform') {
      const period = (args[1] as PeriodType) || (process.env.REPORT_PERIOD as PeriodType) || 'current-month';
      const result = await automation.testInform({
        period,
        outputPath: './hoa-report-test.pdf'
      });
      if (result.stats) {
        console.log('Resumen:');
        console.log(`  Período:         ${result.stats.period}`);
        console.log(`  Cuotas emitidas: $${result.stats.totalIncome.toFixed(2)}`);
        console.log(`  Pagos recibidos: $${result.stats.totalPayments.toFixed(2)}`);
        console.log(`  CxC inicio:      $${result.stats.arAtPeriodStart.toFixed(2)}`);
        console.log(`  CxC final:       $${result.stats.totalUnpaidBalance.toFixed(2)}`);
      }
    } else if (command === 'report') {
      const period = (args[1] as PeriodType) || (process.env.REPORT_PERIOD as PeriodType) || 'current-month';
      const result = await automation.generateAndSendReport({
        period,
        saveToFile: true
      });
      if (result.stats) {
        console.log('\n✓ Report generation completed successfully!');
        console.log(`  Período:         ${result.stats.period}`);
        console.log(`  Cuotas emitidas: $${result.stats.totalIncome.toFixed(2)}`);
        console.log(`  Pagos recibidos: $${result.stats.totalPayments.toFixed(2)}`);
        console.log(`  CxC inicio:      $${result.stats.arAtPeriodStart.toFixed(2)}`);
        console.log(`  CxC final:       $${result.stats.totalUnpaidBalance.toFixed(2)}`);
      }
    } else {
      console.log('Uso:');
      console.log('  npm start test              - Probar conexiones');
      console.log('  npm start test-inform [período] - Previsualizar reporte (sin email)');
      console.log('  npm start report [período]  - Generar y enviar reporte');
      console.log('  Períodos: current-month, last-month, current-year, last-year');
    }
  } catch (error) {
    console.error('\n✗ Error:', (error as Error).message);
    process.exit(1);
  }
}

// Run main function if this is the entry point
import { pathToFileURL } from 'url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export default HOAInformAutomation;
