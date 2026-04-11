import dotenv from 'dotenv';
import { format } from 'date-fns';
import { es as esLocale } from 'date-fns/locale';
import { promises as fs, readFileSync } from 'fs';
import { resolve as resolvePath, relative as pathRelative, isAbsolute as isAbsolutePath } from 'path';
import InvoiceNinjaClient from './lib/invoiceNinjaClient.js';
import EmailSender from './lib/emailSender.js';
import HoaReportGenerator from './lib/hoaReportGenerator.js';
import { buildHoaReportData } from './lib/hoaReportData.js';
import type { CompanyInfo } from './lib/hoaReportData.js';
import { buildReportEmailHtml } from './lib/emailTemplate.js';
import { createDb, getSyncMeta, syncDb, queryForReport, getCompanyProfileFromDb, getContactsWithEmail } from './lib/localDb.js';
import type { SyncMode, ContactWithEmail } from './lib/localDb.js';
import type { PeriodType, CustomRange } from './lib/dataUtils.js';
import { getDateRange, formatPeriodString } from './lib/dataUtils.js';

// Load environment variables
dotenv.config();

/**
 * Build the CompanyInfo object for the report cover page.
 *
 * Data source priority (highest → lowest):
 *  1. `COMPANY_*` environment variables (explicit overrides by the operator)
 *  2. Cached Invoice Ninja company profile fetched during the last `sync`
 *
 * This means the user never has to set the `COMPANY_*` env vars unless they
 * want to override a specific field that comes from Invoice Ninja.
 *
 * @param db  Open SQLite database to read the cached company profile from.
 */
function buildCompanyInfo(db: ReturnType<typeof createDb>): CompanyInfo {
  // Load the cached IN company profile (may be null if sync hasn't run yet)
  const cached = getCompanyProfileFromDb(db);
  const s = cached?.settings;

  // Build a single address string from the available address parts
  const cachedAddress = [
    s?.address1,
    s?.address2,
    [s?.city, s?.state, s?.postal_code].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ') || undefined;

  // Env-var values override the cached API data field-by-field
  return {
    name:    process.env.COMPANY_NAME    || s?.name          || undefined,
    rnc:     process.env.COMPANY_RNC     || s?.id_number     || undefined,
    website: process.env.COMPANY_WEBSITE || s?.website       || undefined,
    email:   process.env.COMPANY_EMAIL   || s?.email         || undefined,
    phone:   process.env.COMPANY_PHONE   || s?.phone         || undefined,
    address: process.env.COMPANY_ADDRESS || cachedAddress,
    logoUrl: process.env.COMPANY_LOGO_URL || cached?.logo    || undefined,
  };
}

/**
 * Sanitize a string for use as a filename component.
 * Replaces characters that are not alphanumeric or Latin extended with underscores,
 * collapses consecutive underscores, and strips leading/trailing underscores.
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\u00C0-\u024F]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Escape a string for safe insertion into HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One entry in the per-contact email delivery log.
 */
interface DeliveryLogEntry {
  clientName:  string;
  contactName?: string;
  email:       string;
  sentAt:      Date;
  status:      'ok' | 'error';
  error?:      string;
}

/**
 * Build the HTML body for the operator summary email.
 *
 * Contains a results table (client | contact | email | date-time | status)
 * and high-level counters.  The PDF is sent as an attachment separately.
 */
function buildSummaryEmailHtml(
  log: DeliveryLogEntry[],
  reportTitle: string,
  periodString: string,
  companyInfo: CompanyInfo | undefined,
  pdfFilename: string,
): string {
  const companyName = companyInfo?.name ?? 'HOA';
  const now         = new Date();
  const sentCount   = log.filter(e => e.status === 'ok').length;
  const errorCount  = log.filter(e => e.status === 'error').length;

  const tableRows = log.map(e => {
    const dt      = format(e.sentAt, 'dd/MM/yyyy HH:mm:ss');
    const statusTd = e.status === 'ok'
      ? `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#16a34a;white-space:nowrap;">✓ Enviado</td>`
      : `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#dc2626;white-space:nowrap;">✗ ${esc(e.error ?? 'Error')}</td>`;
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;">${esc(e.clientName)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;">${esc(e.contactName || '—')}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;">${esc(e.email)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;white-space:nowrap;">${dt}</td>
      ${statusTd}
    </tr>`;
  }).join('');

  const statusBadge = errorCount === 0
    ? `<span style="background:#dcfce7;color:#166534;padding:4px 12px;border-radius:12px;font-size:13px;font-weight:600;">✓ Completado sin errores</span>`
    : `<span style="background:#fef9c3;color:#854d0e;padding:4px 12px;border-radius:12px;font-size:13px;font-weight:600;">⚠️ Completado con ${errorCount} error(es)</span>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Resumen de envíos — ${esc(reportTitle)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" style="max-width:700px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:#1e3a5f;padding:24px 32px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">${esc(companyName)}</h1>
              <p style="margin:6px 0 0;color:#93c5fd;font-size:13px;">Resumen de envíos del informe</p>
            </td>
          </tr>

          <!-- Summary bar -->
          <tr>
            <td style="padding:20px 32px;background:#f8fafc;border-bottom:1px solid #e5e7eb;">
              <p style="margin:0 0 8px;font-size:15px;color:#111827;font-weight:600;">${esc(reportTitle)}</p>
              <p style="margin:0 0 12px;font-size:14px;color:#6b7280;">Período: <strong>${esc(periodString)}</strong></p>
              <p style="margin:0 0 8px;font-size:14px;color:#374151;">
                📧 <strong>${log.length}</strong> destinatario(s) procesado(s) —
                <strong style="color:#16a34a;">${sentCount}</strong> enviado(s),
                <strong style="color:#dc2626;">${errorCount}</strong> error(es)
              </p>
              <p style="margin:0 0 4px;font-size:14px;color:#374151;">
                📎 Archivo adjunto: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">${esc(pdfFilename)}</code>
              </p>
              <p style="margin:8px 0 0;">${statusBadge}</p>
            </td>
          </tr>

          <!-- Delivery table -->
          <tr>
            <td style="padding:24px 32px;">
              <h2 style="margin:0 0 16px;font-size:15px;color:#111827;">Detalle de envíos</h2>
              <div style="overflow-x:auto;">
                <table style="width:100%;border-collapse:collapse;font-size:13px;color:#374151;">
                  <thead>
                    <tr style="background:#f3f4f6;">
                      <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e5e7eb;white-space:nowrap;">Cliente</th>
                      <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e5e7eb;white-space:nowrap;">Contacto</th>
                      <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e5e7eb;white-space:nowrap;">Correo</th>
                      <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e5e7eb;white-space:nowrap;">Fecha y hora</th>
                      <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #e5e7eb;">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${tableRows || '<tr><td colspan="5" style="padding:12px 10px;color:#9ca3af;font-style:italic;">Sin destinatarios</td></tr>'}
                  </tbody>
                </table>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:14px 32px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0;font-size:11px;color:#9ca3af;">${esc(companyName)} &copy; ${now.getFullYear()} — Generado el ${format(now, 'dd/MM/yyyy HH:mm', { locale: esLocale })}</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}


/**
 * Load the documentation markdown from REPORT_DOCS_PATH (default: ./report-docs.md).
 * Returns an empty string if the file does not exist.
 */
function readDocsMarkdown(): string {
  const docsPath = process.env.REPORT_DOCS_PATH || './report-docs.md';
  // Restrict to Markdown files to prevent accidental reads of sensitive files.
  if (!docsPath.toLowerCase().endsWith('.md')) {
    console.warn(`[readDocsMarkdown] REPORT_DOCS_PATH must end with ".md". Ignoring: "${docsPath}"`);
    return '';
  }
  // Guard against path-traversal: resolved path must stay within cwd.
  // Use path.relative() so the check works correctly on all platforms.
  const cwd = resolvePath('.');
  const resolved = resolvePath(docsPath);
  const rel = pathRelative(cwd, resolved);
  if (rel.startsWith('..') || isAbsolutePath(rel)) {
    console.warn(`[readDocsMarkdown] REPORT_DOCS_PATH outside working directory. Ignoring: "${docsPath}"`);
    return '';
  }
  try {
    return readFileSync(resolved, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Report generation options
 */
export interface ReportOptions {
  period?: PeriodType;
  customRange?: CustomRange | null;
  /**
   * Controls what happens after the PDF is generated and uploaded:
   *  - 'attach'       — upload to Invoice Ninja only; no email is sent.
   *  - 'email-all'    — send the report to every registered contact.
   *  - 'email-single' — send the report only to `singleRecipient`.
   * Defaults to 'attach' when omitted.
   */
  deliveryMode?: 'attach' | 'email-all' | 'email-single';
  /** Required when deliveryMode is 'email-single'. */
  singleRecipient?: string | null;
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
   * Synchronise the local SQLite cache with Invoice Ninja.
   *
   * - `full`        — clears all data, then fetches everything from the API.
   * - `incremental` — fetches only records changed since the last successful sync.
   *
   * This method should be run before generating reports.  It does not produce
   * any PDF or send any email.
   */
  async syncData(mode: SyncMode = 'full'): Promise<void> {
    const dbPath = process.env.DB_CACHE_PATH;
    const db = createDb(dbPath);
    try {
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`SYNC — Sincronizando datos desde Invoice Ninja (modo: ${mode})`);
      console.log('═══════════════════════════════════════════════════════════\n');

      const stats = await syncDb(db, this.invoiceNinja, mode, msg => console.log(msg));
      const elapsed = (stats.elapsedMs / 1000).toFixed(1);

      console.log('\n══════════════════════════════════════════════════════');
      console.log(`✓ Sincronización ${mode.toUpperCase()} completada en ${elapsed}s`);
      console.log(`  Facturas:    ${stats.invoices}`);
      console.log(`  Pagos:       ${stats.payments}`);
      console.log(`  Gastos:      ${stats.expenses}`);
      console.log(`  Clientes:    ${stats.clients}  (${stats.contacts} contactos)`);
      console.log(`  Grupos:      ${stats.clientGroups}`);
      console.log(`  Proveedores: ${stats.vendors}`);
      console.log(`  Categorías:  ${stats.expenseCategories}`);
      console.log('══════════════════════════════════════════════════════\n');
    } finally {
      db.close();
    }
  }

  /**
   * Open the local SQLite cache, verify it has been synced, and return a
   * `DbQueryResult` for the given date range.  Throws a clear error when the
   * cache is empty (i.e. `syncData` has never been run).
   */
  private openAndQuery(start: Date, end: Date) {
    const dbPath = process.env.DB_CACHE_PATH;
    const db = createDb(dbPath);
    const meta = getSyncMeta(db);
    if (!meta) {
      db.close();
      throw new Error(
        'La base de datos local no contiene datos.\n' +
        'Ejecute "npm start sync" (o "npm start sync full") antes de generar reportes.'
      );
    }
    console.log(`ℹ️  Usando datos del caché (último sync: ${meta.lastSyncAt}, modo: ${meta.lastSyncMode})`);
    return { db, result: queryForReport(db, start, end) };
  }

  /**
   * Generate and send the HOA income report as a PDF via email.
   *
   * Full delivery flow:
   *  1. Generate the PDF from the local SQLite cache.
   *  2. Save the PDF to disk (when `saveToFile` is true).
   *  3. Upload the PDF to Invoice Ninja as a public company document.
   *  4. (email-all / email-single only) Send the report email:
   *       - 'email-all'    — send to every client contact that has an email address.
   *       - 'email-single' — send ONLY to `singleRecipient`.
   *  5. (email-all / email-single only) Send an operator summary email (with
   *     delivery table + PDF) to the `EMAIL_SUMMARIZE_TO` env variable.
   *
   * When deliveryMode is 'attach', only steps 1–3 are executed (no email).
   *
   * Reads all data from the local SQLite cache — does NOT call the Invoice
   * Ninja API.  Run `syncData()` first to populate the cache.
   */
  async generateAndSendReport(options: ReportOptions = {}): Promise<ReportResult> {
    const {
      period = (process.env.REPORT_PERIOD as PeriodType) || 'current-month',
      customRange = null,
      deliveryMode = 'attach',
      singleRecipient = null,
      saveToFile = false,
      outputPath = './hoa-report.pdf'
    } = options;

    try {
      console.log('═══════════════════════════════════════════════════════════');
      console.log('REPORT — Generando informe HOA');
      console.log('═══════════════════════════════════════════════════════════\n');

      const dateRange = getDateRange(period, customRange);
      console.log(`📅 Período: ${dateRange.startISO} → ${dateRange.endISO}`);

      const reportTitle = process.env.REPORT_TITLE || 'Informe HOA';

      const { db, result } = this.openAndQuery(dateRange.start, dateRange.end);
      let reportData;
      let filteredPeriodInvoicesLength = 0;
      let filteredPeriodPaymentsLength = 0;
      let allInvoicesRef: ReturnType<typeof queryForReport>['allInvoices'] = [];
      let contacts: ContactWithEmail[] = [];
      let companyId: string | undefined;

      try {
        const {
          allInvoices, periodInvoices, periodPayments,
          periodExpenses, allExpenses, allClients, clientGroups,
          allTimePaymentsTotal, allTimeExpensesPaidTotal, invoiceLastPaymentDate,
          primaryContactByClientId,
        } = result;

        allInvoicesRef = allInvoices;
        filteredPeriodInvoicesLength = periodInvoices.length;
        filteredPeriodPaymentsLength = periodPayments.length;

        reportData = buildHoaReportData(
          allInvoices,
          periodInvoices,
          periodPayments,
          periodExpenses,
          allExpenses,
          allClients,
          clientGroups,
          dateRange.start,
          dateRange.end,
          reportTitle,
          new Date(),
          allTimePaymentsTotal,
          allTimeExpensesPaidTotal,
          parseFloat(process.env.INITIAL_BANK_BALANCE || '0') || 0,
          invoiceLastPaymentDate,
          primaryContactByClientId
        );
        reportData.companyInfo  = buildCompanyInfo(db);
        reportData.docsMarkdown = readDocsMarkdown();

        // Collect contacts with email only when the delivery mode requires it
        contacts  = deliveryMode !== 'attach' ? getContactsWithEmail(db) : [];
        companyId = getCompanyProfileFromDb(db)?.id;
      } finally {
        db.close();
      }

      console.log(`\n💰 Totales del período:`);
      console.log(`   Cuotas emitidas: $${reportData.totalInvoicedInPeriod.toFixed(2)}`);
      console.log(`   Pagos recibidos: $${reportData.totalPaymentsInPeriod.toFixed(2)}`);
      console.log(`   Gastos:          $${reportData.totalExpensesInPeriod.toFixed(2)}`);
      console.log(`   CxC inicio:      $${reportData.arAtPeriodStart.toFixed(2)}`);
      console.log(`   CxC final:       $${reportData.arAtPeriodEnd.toFixed(2)}\n`);

      const totalSteps = deliveryMode === 'attach' ? 2 : 4;

      // ── Step 1: Generate PDF ──────────────────────────────────────────────
      console.log(`📄 [1/${totalSteps}] Generando PDF...`);
      const pdfBuffer = await this.hoaReportGenerator.generatePdf(reportData);
      await this.hoaReportGenerator.close();

      // Build the PDF filename: CompanyName_HOA_YYYYMMDD-YYYYMMDD.pdf
      const safeCompanyName = sanitizeFilename(reportData.companyInfo?.name || 'HOA');
      const pdfFilename = `${safeCompanyName}_HOA_${format(dateRange.start, 'yyyyMMdd')}-${format(dateRange.end, 'yyyyMMdd')}.pdf`;

      if (saveToFile) {
        await fs.writeFile(outputPath, pdfBuffer);
        console.log(`   ✓ PDF guardado en: ${outputPath}`);
      }
      console.log(`   ✓ PDF generado (${(pdfBuffer.length / 1024).toFixed(0)} KB) → ${pdfFilename}`);

      // ── Step 2: Upload PDF to Invoice Ninja as company document ───────────
      console.log(`\n☁️  [2/${totalSteps}] Subiendo PDF a Invoice Ninja...`);
      if (companyId) {
        try {
          await this.invoiceNinja.uploadCompanyDocument(companyId, pdfBuffer, pdfFilename);
          console.log(`   ✓ Documento subido como documento público de empresa`);
        } catch (uploadErr) {
          console.warn(`   ⚠️  No se pudo subir el documento a Invoice Ninja: ${(uploadErr as Error).message}`);
        }
      } else {
        console.warn('   ⚠️  ID de empresa no disponible — omitiendo subida a Invoice Ninja');
      }

      // ── Steps 3 & 4: Email delivery (skipped in 'attach' mode) ──────────
      const periodString = formatPeriodString(period, dateRange);

      if (deliveryMode === 'attach') {
        console.log('\n   ℹ️  Modo "attach": envío de correos omitido.');
      } else {
        const emailSubject = `${reportTitle} — ${periodString}`;
        const emailText = [
          `${reportTitle} — ${periodString}`,
          '',
          'El informe financiero correspondiente al período indicado está disponible como adjunto en formato PDF.',
          'Le invitamos a revisarlo y no dude en contactarnos ante cualquier consulta.',
        ].join('\n');

        const deliveryLog: DeliveryLogEntry[] = [];

        if (deliveryMode === 'email-single') {
          // Send ONLY to the specified address
          console.log(`\n📧 [3/4] Enviando correo a destinatario específico: ${singleRecipient}...`);
          try {
            const html = await buildReportEmailHtml({
              companyInfo: reportData.companyInfo,
              reportTitle,
              periodString,
            });
            await this.emailSender.sendFinancialReport({
              to:      singleRecipient!,
              subject: emailSubject,
              text:    emailText,
              html,
              pdfBuffer,
              pdfFilename,
            });
            deliveryLog.push({
              clientName:  '—',
              contactName: undefined,
              email:       singleRecipient!,
              sentAt:      new Date(),
              status:      'ok',
            });
            console.log(`   ✓ ${singleRecipient}`);
          } catch (mailErr) {
            const errMsg = (mailErr as Error).message;
            deliveryLog.push({
              clientName:  '—',
              contactName: undefined,
              email:       singleRecipient!,
              sentAt:      new Date(),
              status:      'error',
              error:       errMsg,
            });
            console.warn(`   ✗ ${singleRecipient} — ${errMsg}`);
          }
        } else {
          // deliveryMode === 'email-all' — send to every registered contact
          console.log(`\n📧 [3/4] Enviando correos a contactos (${contacts.length} destinatario(s))...`);

          if (contacts.length === 0) {
            console.log('   ℹ️  No se encontraron contactos con correo registrado.');
          }

          for (let i = 0; i < contacts.length; i++) {
            const contact = contacts[i];
            const prefix  = `   [${i + 1}/${contacts.length}]`;

            try {
              const html = await buildReportEmailHtml({
                companyInfo:   reportData.companyInfo,
                reportTitle,
                periodString,
                recipientName: contact.full_name || undefined,
              });

              await this.emailSender.sendFinancialReport({
                to:      contact.email,
                subject: emailSubject,
                text:    emailText,
                html,
                pdfBuffer,
                pdfFilename,
              });

              deliveryLog.push({
                clientName:  contact.client_name,
                contactName: contact.full_name,
                email:       contact.email,
                sentAt:      new Date(),
                status:      'ok',
              });
              console.log(`${prefix} ✓ ${contact.full_name ? `${contact.full_name} <${contact.email}>` : contact.email} (${contact.client_name})`);
            } catch (mailErr) {
              const errMsg = (mailErr as Error).message;
              deliveryLog.push({
                clientName:  contact.client_name,
                contactName: contact.full_name,
                email:       contact.email,
                sentAt:      new Date(),
                status:      'error',
                error:       errMsg,
              });
              console.warn(`${prefix} ✗ ${contact.full_name ? `${contact.full_name} <${contact.email}>` : contact.email} — ${errMsg}`);
            }
          }
        }

        const sentOk  = deliveryLog.filter(e => e.status === 'ok').length;
        const sentErr = deliveryLog.filter(e => e.status === 'error').length;
        console.log(`\n   Resultado: ${sentOk} enviado(s), ${sentErr} error(es)`);

        // ── Step 4: Send operator summary email ─────────────────────────────
        console.log('\n📋 [4/4] Enviando correo resumen al operador...');
        const summaryHtml = buildSummaryEmailHtml(
          deliveryLog,
          reportTitle,
          periodString,
          reportData.companyInfo,
          pdfFilename,
        );
        const totalRecipients = deliveryMode === 'email-single' ? 1 : contacts.length;
        const summarySubject = `${reportTitle} — Resumen de envíos (${periodString})`;
        const summaryText = [
          `Resumen de envíos: ${reportTitle} — ${periodString}`,
          '',
          `Total destinatarios: ${totalRecipients}`,
          `Enviados exitosamente: ${sentOk}`,
          `Errores: ${sentErr}`,
          '',
          'El PDF del informe está adjunto a este correo.',
        ].join('\n');

        await this.emailSender.sendFinancialReport({
          subject:     summarySubject,
          text:        summaryText,
          html:        summaryHtml,
          pdfBuffer,
          pdfFilename,
        });
        console.log(`   ✓ Resumen enviado`);
      }

      console.log('\n═══════════════════════════════════════════════════════════');
      console.log('✓ REPORT COMPLETADO EXITOSAMENTE');
      console.log('═══════════════════════════════════════════════════════════\n');

      const unpaidCount = allInvoicesRef.filter(inv => parseFloat(String(inv.balance || 0)) > 0).length;

      return {
        success: true,
        message: deliveryMode === 'attach'
          ? 'Report generated and uploaded successfully'
          : 'Report generated and sent successfully',
        stats: {
          incomeCount:        filteredPeriodInvoicesLength,
          paymentCount:       filteredPeriodPaymentsLength,
          unpaidInvoiceCount: unpaidCount,
          totalIncome:        reportData.totalInvoicedInPeriod,
          totalPayments:      reportData.totalPaymentsInPeriod,
          totalUnpaidBalance: reportData.arAtPeriodEnd,
          arAtPeriodStart:    reportData.arAtPeriodStart,
          period:             periodString,
        }
      };
    } catch (error) {
      console.error('\n✗ Error generando reporte:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Preview the HOA report: print KPIs to console and save PDF to disk
   * without sending email.
   *
   * Reads all data from the local SQLite cache — does NOT call the Invoice
   * Ninja API.  Run `syncData()` first to populate the cache.
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

      const { db, result } = this.openAndQuery(dateRange.start, dateRange.end);
      let reportData;
      let periodInvoicesLen = 0;
      let periodPaymentsLen = 0;
      let allInvoicesForStats: ReturnType<typeof queryForReport>['allInvoices'] = [];
      try {
        const {
          allInvoices, periodInvoices, periodPayments,
          periodExpenses, allExpenses, allClients, clientGroups,
          allTimePaymentsTotal, allTimeExpensesPaidTotal, invoiceLastPaymentDate,
          primaryContactByClientId,
        } = result;

        allInvoicesForStats  = allInvoices;
        periodInvoicesLen    = periodInvoices.length;
        periodPaymentsLen    = periodPayments.length;

        console.log(`   Facturas en período: ${periodInvoices.length}`);
        console.log(`   Pagos en período:    ${periodPayments.length}`);
        console.log(`   Gastos en período:   ${periodExpenses.length}`);
        console.log(`   Total facturas:      ${allInvoices.length}`);
        console.log(`   Total gastos:        ${allExpenses.length}`);
        console.log(`   Clientes totales:    ${allClients.length}`);
        console.log(`   Grupos de clientes:  ${clientGroups.length}\n`);

        const reportTitle = process.env.REPORT_TITLE || 'Informe HOA';
        reportData = buildHoaReportData(
          allInvoices,
          periodInvoices,
          periodPayments,
          periodExpenses,
          allExpenses,
          allClients,
          clientGroups,
          dateRange.start,
          dateRange.end,
          reportTitle,
          new Date(),
          allTimePaymentsTotal,
          allTimeExpensesPaidTotal,
          parseFloat(process.env.INITIAL_BANK_BALANCE || '0') || 0,
          invoiceLastPaymentDate,
          primaryContactByClientId
        );
        reportData.companyInfo  = buildCompanyInfo(db);
        reportData.docsMarkdown = readDocsMarkdown();
      } finally {
        db.close();
      }

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

      const unpaidCount = allInvoicesForStats.filter(inv => parseFloat(String(inv.balance || 0)) > 0).length;

      return {
        success: true,
        message: 'Test inform completed successfully',
        stats: {
          incomeCount: periodInvoicesLen,
          paymentCount: periodPaymentsLen,
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

  /**
   * Send a test email to the given address using the branded HTML template.
   * Reads company info from the local cache (no PDF generated).
   */
  async sendTestEmail(to: string): Promise<void> {
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`TEST EMAIL — Enviando email de prueba a: ${to}`);
    console.log('═══════════════════════════════════════════════════════════\n');

    const dbPath = process.env.DB_CACHE_PATH;
    const db = createDb(dbPath);
    let companyInfo: CompanyInfo | undefined;
    try {
      companyInfo = buildCompanyInfo(db);
    } finally {
      db.close();
    }

    await this.emailSender.sendTestEmail(to, companyInfo);
    console.log(`\n✓ Email de prueba enviado exitosamente a: ${to}`);
  }
}

// Main execution
async function main(): Promise<void> {
  const automation = new HOAInformAutomation();

  const args = process.argv.slice(2);
  const command = args[0];

  try {
    if (!command) {
      // No command provided — show error (do NOT default to report/current-month)
      console.error('✗ Error: Debe especificar un comando y período.\n');
      printUsage();
      process.exit(1);
    } else if (command === 'test') {
      await automation.testConnections();
    } else if (command === 'test-email') {
      // npm start test-email <email>
      const emailArg = args[1];
      if (!emailArg) {
        console.error('✗ Error: Debe especificar el email destinatario.\n');
        console.error('  Uso: npm start test-email <email>');
        process.exit(1);
      }
      await automation.sendTestEmail(emailArg);
    } else if (command === 'sync') {
      // "sync" defaults to full; "sync incremental" for incremental mode
      const rawMode = (args[1] ?? 'full').toLowerCase();
      const mode: SyncMode = rawMode === 'incremental' ? 'incremental' : 'full';
      await automation.syncData(mode);
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
      // npm start report <period> attach
      // npm start report <period> email all
      // npm start report <period> email <address>
      const period = args[1] as PeriodType | undefined;
      if (!period) {
        console.error('✗ Error: Debe especificar el período.\n');
        console.error('  Uso: npm start report <período> attach');
        console.error('       npm start report <período> email all');
        console.error('       npm start report <período> email <destinatario>');
        console.error('  Períodos: last-month, current-month, current-year, last-year');
        process.exit(1);
      }

      const subcommand = args[2];
      if (!subcommand) {
        console.error('✗ Error: Debe especificar un subcomando (attach / email all / email <destinatario>).\n');
        console.error('  Uso: npm start report <período> attach');
        console.error('       npm start report <período> email all');
        console.error('       npm start report <período> email <destinatario>');
        process.exit(1);
      }

      let deliveryMode: 'attach' | 'email-all' | 'email-single';
      let singleRecipient: string | undefined;

      if (subcommand === 'attach') {
        deliveryMode = 'attach';
      } else if (subcommand === 'email') {
        const emailTarget = args[3];
        if (!emailTarget) {
          console.error('✗ Error: Debe especificar "all" o un destinatario después de "email".\n');
          console.error('  Uso: npm start report <período> email all');
          console.error('       npm start report <período> email <destinatario>');
          process.exit(1);
        }
        if (emailTarget === 'all') {
          deliveryMode = 'email-all';
        } else {
          deliveryMode = 'email-single';
          singleRecipient = emailTarget;
        }
      } else {
        console.error(`✗ Error: Subcomando desconocido: "${subcommand}"\n`);
        console.error('  Subcomandos válidos: attach, email all, email <destinatario>');
        process.exit(1);
      }

      const result = await automation.generateAndSendReport({
        period,
        deliveryMode,
        singleRecipient: singleRecipient || null,
        saveToFile: true
      });
      if (result.stats) {
        console.log(`  Período:         ${result.stats.period}`);
        console.log(`  Cuotas emitidas: $${result.stats.totalIncome.toFixed(2)}`);
        console.log(`  Pagos recibidos: $${result.stats.totalPayments.toFixed(2)}`);
        console.log(`  CxC inicio:      $${result.stats.arAtPeriodStart.toFixed(2)}`);
        console.log(`  CxC final:       $${result.stats.totalUnpaidBalance.toFixed(2)}`);
      }
    } else {
      console.error(`✗ Error: Comando desconocido: "${command}"\n`);
      printUsage();
      process.exit(1);
    }
  } catch (error) {
    console.error('\n✗ Error:', (error as Error).message);
    process.exit(1);
  }
}

function printUsage(): void {
  console.log('Uso:');
  console.log('  npm start sync [full]                                  - Sincronizar todos los datos desde Invoice Ninja');
  console.log('  npm start sync incremental                             - Sincronizar solo cambios desde la última sincronización');
  console.log('  npm start test                                         - Probar conexiones');
  console.log('  npm start test-email <email>                           - Enviar email de prueba');
  console.log('  npm start test-inform [período]                        - Previsualizar reporte (sin email, usa caché)');
  console.log('  npm start report <período> attach                      - Generar PDF y subir a Invoice Ninja (sin email)');
  console.log('  npm start report <período> email all                   - Generar PDF, subir a IN, enviar a todos los contactos y resumen a EMAIL_SUMMARIZE_TO');
  console.log('  npm start report <período> email <destinatario>        - Generar PDF, subir a IN, enviar SOLO a <destinatario> y resumen a EMAIL_SUMMARIZE_TO');
  console.log('');
  console.log('  Períodos: last-month, current-month, current-year, last-year');
  console.log('');
  console.log('  El subcomando "attach":');
  console.log('    1. Genera el PDF del informe');
  console.log('    2. Sube el PDF a Invoice Ninja como documento público de empresa');
  console.log('');
  console.log('  Los subcomandos "email all" / "email <destinatario>":');
  console.log('    1. Genera el PDF del informe');
  console.log('    2. Sube el PDF a Invoice Ninja como documento público de empresa');
  console.log('    3. Envía el informe a cada contacto (email all) o solo al destinatario especificado');
  console.log('    4. Envía un correo resumen al operador (EMAIL_SUMMARIZE_TO) con tabla de envíos y el PDF adjunto');
  console.log('');
  console.log('  Flujo recomendado:');
  console.log('    1. npm start sync                        ← poblar/actualizar el caché');
  console.log('    2. npm start test-inform last-month      ← verificar resultado');
  console.log('    3. npm start report last-month attach    ← generar y subir a Invoice Ninja');
  console.log('    4. npm start report last-month email all ← enviar informe a todos los contactos');
}


// Run main function if this is the entry point
import { pathToFileURL } from 'url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export default HOAInformAutomation;
