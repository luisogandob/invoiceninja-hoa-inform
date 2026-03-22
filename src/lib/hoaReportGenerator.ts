import puppeteer, { type Browser } from 'puppeteer';
import { format } from 'date-fns';
import type { HoaReportData, PaymentsByClient, ArByClient } from './hoaReportData.js';

/**
 * HOA Report PDF Generator.
 *
 * Sections:
 *  1. Header  — title, period dates, generation date
 *  2. Totals  — four big-number KPI cards
 *  3. Bar chart — Payments received in period, by client
 *  4. Bar chart — Accounts receivable at end of period, by client
 */
class HoaReportGenerator {
  private browser: Browser | null = null;

  async init(): Promise<void> {
    if (this.browser) return;
    this.browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  async generatePdf(data: HoaReportData): Promise<Buffer> {
    await this.init();

    const html = this.buildHtml(data);
    const page = await this.browser!.newPage();

    try {
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: `
          <div style="width:100%;text-align:center;font-size:10px;padding:10px;font-family:Arial,sans-serif;">
            <span class="pageNumber"></span> / <span class="totalPages"></span>
          </div>`,
        margin: { top: '1cm', bottom: '1.5cm', left: '1.2cm', right: '1.2cm' }
      });
      return Buffer.from(pdfBuffer);
    } catch (error) {
      console.error('Error generating HOA report PDF:', (error as Error).message);
      throw error;
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  // ---------------------------------------------------------------------------
  // HTML builder
  // ---------------------------------------------------------------------------

  buildHtml(data: HoaReportData): string {
    const {
      title,
      periodStart,
      periodEnd,
      generatedAt,
      totalInvoicedInPeriod,
      totalPaymentsInPeriod,
      arAtPeriodStart,
      arAtPeriodEnd,
      paymentsByClient,
      arByClient
    } = data;

    const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const paymentsChartSvg = this.buildBarChart(
      paymentsByClient.map(p => ({ label: p.clientName, value: p.total })),
      '#3498db'
    );

    const arChartSvg = this.buildBarChart(
      arByClient.map(a => ({ label: a.clientName, value: a.balance })),
      '#e67e22'
    );

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>${this.esc(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; color: #2c3e50; background: #fff; padding: 24px; }

    /* ── Header ── */
    .report-header {
      text-align: center;
      border-bottom: 3px solid #2c3e50;
      padding-bottom: 18px;
      margin-bottom: 32px;
    }
    .report-header h1 {
      font-size: 26px;
      color: #2c3e50;
      margin-bottom: 8px;
    }
    .report-header .meta { font-size: 13px; color: #7f8c8d; margin-top: 4px; }

    /* ── KPI cards ── */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      margin-bottom: 40px;
    }
    .kpi-card {
      border-radius: 8px;
      padding: 20px 24px;
      text-align: center;
    }
    .kpi-card .kpi-label {
      font-size: 12px;
      font-weight: bold;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 10px;
      opacity: 0.85;
    }
    .kpi-card .kpi-value {
      font-size: 30px;
      font-weight: bold;
    }
    .kpi-invoiced  { background: #eafaf1; color: #1e8449; }
    .kpi-payments  { background: #ebf5fb; color: #1a5276; }
    .kpi-ar-start  { background: #fef9e7; color: #7d6608; }
    .kpi-ar-end    { background: #fdf2e9; color: #a04000; }

    /* ── Section titles ── */
    .section-title {
      font-size: 16px;
      font-weight: bold;
      color: #2c3e50;
      margin-bottom: 16px;
      padding-bottom: 6px;
      border-bottom: 1px solid #d5d8dc;
    }

    /* ── Chart wrapper ── */
    .chart-section { margin-bottom: 40px; }
    .chart-section svg { width: 100%; height: auto; }
  </style>
</head>
<body>

  <!-- ── Header ── -->
  <div class="report-header">
    <h1>${this.esc(title)}</h1>
    <div class="meta">Período: ${this.esc(periodStart)} — ${this.esc(periodEnd)}</div>
    <div class="meta">Elaborado el: ${format(generatedAt, 'dd/MM/yyyy HH:mm')}</div>
  </div>

  <!-- ── KPI Totals ── -->
  <div class="kpi-grid">
    <div class="kpi-card kpi-invoiced">
      <div class="kpi-label">Cuotas Emitidas en el Período</div>
      <div class="kpi-value">$${fmt(totalInvoicedInPeriod)}</div>
    </div>
    <div class="kpi-card kpi-payments">
      <div class="kpi-label">Pagos Recibidos en el Período</div>
      <div class="kpi-value">$${fmt(totalPaymentsInPeriod)}</div>
    </div>
    <div class="kpi-card kpi-ar-start">
      <div class="kpi-label">Cuentas x Cobrar — Inicio del Período</div>
      <div class="kpi-value">$${fmt(arAtPeriodStart)}</div>
    </div>
    <div class="kpi-card kpi-ar-end">
      <div class="kpi-label">Cuentas x Cobrar — Final del Período</div>
      <div class="kpi-value">$${fmt(arAtPeriodEnd)}</div>
    </div>
  </div>

  <!-- ── Bar Chart: Payments by Client ── -->
  <div class="chart-section">
    <div class="section-title">Pagos Recibidos en el Período por Cliente</div>
    ${paymentsChartSvg}
  </div>

  <!-- ── Bar Chart: AR by Client ── -->
  <div class="chart-section">
    <div class="section-title">Cuentas x Cobrar al Final del Período por Cliente</div>
    ${arChartSvg}
  </div>

</body>
</html>`;
  }

  // ---------------------------------------------------------------------------
  // SVG bar-chart helper
  // ---------------------------------------------------------------------------

  private buildBarChart(
    items: Array<{ label: string; value: number }>,
    barColor: string
  ): string {
    if (items.length === 0) {
      return `<p style="color:#95a5a6;font-size:13px;text-align:center;padding:24px 0;">Sin datos para este período.</p>`;
    }

    const maxValue = Math.max(...items.map(i => i.value), 1);

    // Chart dimensions (viewBox units)
    const svgWidth = 700;
    const rowHeight = 36;
    const labelWidth = 200;
    const barAreaWidth = svgWidth - labelWidth - 120; // leave room for value text
    const paddingTop = 10;
    const paddingBottom = 10;
    const svgHeight = paddingTop + items.length * rowHeight + paddingBottom;

    const rows = items.map((item, i) => {
      const barWidth = Math.max(2, (item.value / maxValue) * barAreaWidth);
      const y = paddingTop + i * rowHeight;
      const barY = y + 6;
      const barH = rowHeight - 12;
      const textY = y + rowHeight / 2 + 5;
      const valueX = labelWidth + barWidth + 8;

      const labelText = this.truncate(item.label, 28);
      const valueText = `$${item.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      return `
      <text x="${labelWidth - 8}" y="${textY}" text-anchor="end" font-size="12" fill="#2c3e50">${this.esc(labelText)}</text>
      <rect x="${labelWidth}" y="${barY}" width="${barWidth}" height="${barH}" fill="${barColor}" rx="3" />
      <text x="${valueX}" y="${textY}" font-size="11" fill="#555">${this.esc(valueText)}</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${svgWidth} ${svgHeight}" xmlns="http://www.w3.org/2000/svg">
  <line x1="${labelWidth}" y1="${paddingTop}" x2="${labelWidth}" y2="${svgHeight - paddingBottom}" stroke="#d5d8dc" stroke-width="1"/>
  ${rows}
</svg>`;
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private esc(text: string): string {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private truncate(text: string, maxLen: number): string {
    return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
  }
}

export default HoaReportGenerator;
