import puppeteer, { type Browser } from 'puppeteer';
import { format } from 'date-fns';
import type { HoaReportData } from './hoaReportData.js';

/**
 * HOA Report PDF Generator (new report format).
 *
 * Uses Puppeteer directly to render the HTML template to PDF.
 * The browser instance is reused across multiple calls and must be
 * released by calling `close()` when no longer needed.
 *
 * Sections:
 *  1. Header  — title, period dates, generation date
 *  2. Totals  — four big-number KPI cards
 *  3. Bar chart — Payments received in period, by client
 *  4. Bar chart — Accounts receivable at end of period, by client
 */
class HoaReportGenerator {
  private browser: Browser | null = null;

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }
    return this.browser;
  }

  async generatePdf(data: HoaReportData): Promise<Buffer> {
    const html = this.buildHtml(data);
    const browser = await this.getBrowser();

    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });

      const pdf = await page.pdf({
        format: 'A4',
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: `
          <div style="width:100%;text-align:center;font-size:10px;padding:10px;font-family:Arial,sans-serif;">
            <span class="pageNumber"></span> / <span class="totalPages"></span>
          </div>`,
        margin: {
          top: '1cm',
          bottom: '1.5cm',
          left: '1.2cm',
          right: '1.2cm'
        }
      });

      return Buffer.from(pdf);
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
      totalExpensesInPeriod,
      arAtPeriodStart,
      arAtPeriodEnd,
      paymentsByGroup,
      arByGroup
    } = data;

    const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const paymentsChartSvg = this.buildVerticalBarChart(
      paymentsByGroup.map(p => ({ label: p.groupName, value: p.total })),
      '#3498db'
    );

    const arChartSvg = this.buildVerticalBarChart(
      arByGroup.map(a => ({ label: a.groupName, value: a.balance })),
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
    .kpi-expenses  { background: #fbeaea; color: #922b21; }

    /* ── Centered single-card row ── */
    .kpi-single {
      display: flex;
      justify-content: center;
      margin-bottom: 40px;
    }
    .kpi-single .kpi-card { width: 50%; }

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

  <!-- ── KPI: Total Expenses ── -->
  <div class="kpi-single">
    <div class="kpi-card kpi-expenses">
      <div class="kpi-label">Gastos del Período</div>
      <div class="kpi-value">$${fmt(totalExpensesInPeriod)}</div>
    </div>
  </div>

  <!-- ── Bar Chart: Payments by Client Group ── -->
  <div class="chart-section">
    <div class="section-title">Pagos Recibidos en el Período por Grupo de Clientes</div>
    ${paymentsChartSvg}
  </div>

  <!-- ── Bar Chart: AR by Client Group ── -->
  <div class="chart-section">
    <div class="section-title">Cuentas x Cobrar al Final del Período por Grupo de Clientes</div>
    ${arChartSvg}
  </div>

</body>
</html>`;
  }

  // ---------------------------------------------------------------------------
  // SVG vertical bar-chart helper
  // ---------------------------------------------------------------------------

  private buildVerticalBarChart(
    items: Array<{ label: string; value: number }>,
    barColor: string
  ): string {
    if (items.length === 0) {
      return `<p style="color:#95a5a6;font-size:13px;text-align:center;padding:24px 0;">Sin datos para este período.</p>`;
    }

    const maxValue = Math.max(...items.map(i => i.value), 1);

    // Chart dimensions (viewBox units)
    const svgWidth = 700;
    const leftPad = 10;
    const rightPad = 10;
    const topPad = 30;    // room for value labels above bars
    const chartH = 180;   // height of the bar drawing area
    const bottomPad = 60; // room for group name labels below bars

    const svgHeight = topPad + chartH + bottomPad;
    const barAreaWidth = svgWidth - leftPad - rightPad;
    const n = items.length;
    const slotWidth = barAreaWidth / n;
    const barWidth = Math.min(80, slotWidth * 0.65);
    const baselineY = topPad + chartH;

    // Horizontal grid lines (at 25%, 50%, 75%, 100% of max)
    const gridLines = [0.25, 0.5, 0.75, 1.0].map(frac => {
      const y = topPad + chartH * (1 - frac);
      const amt = maxValue * frac;
      const label = `$${amt.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      return `
    <line x1="${leftPad}" y1="${y}" x2="${svgWidth - rightPad}" y2="${y}" stroke="#ecf0f1" stroke-width="1"/>
    <text x="${leftPad}" y="${y - 3}" font-size="9" fill="#bdc3c7">${this.esc(label)}</text>`;
    }).join('');

    const bars = items.map((item, i) => {
      const barH = Math.max(2, (item.value / maxValue) * chartH);
      const barX = leftPad + i * slotWidth + (slotWidth - barWidth) / 2;
      const barY = baselineY - barH;
      const cx = barX + barWidth / 2;

      const valueText = `$${item.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const labelText = this.truncate(item.label, 16);

      // Rotate label -30° around its anchor point to avoid overlap
      return `
    <rect x="${barX}" y="${barY}" width="${barWidth}" height="${barH}" fill="${barColor}" rx="3"/>
    <text x="${cx}" y="${barY - 5}" text-anchor="middle" font-size="10" fill="#2c3e50">${this.esc(valueText)}</text>
    <text x="${cx}" y="${baselineY + 12}" text-anchor="middle" font-size="11" fill="#2c3e50"
          transform="rotate(-35,${cx},${baselineY + 12})">${this.esc(labelText)}</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${svgWidth} ${svgHeight}" xmlns="http://www.w3.org/2000/svg">
  ${gridLines}
  <line x1="${leftPad}" y1="${baselineY}" x2="${svgWidth - rightPad}" y2="${baselineY}" stroke="#d5d8dc" stroke-width="1.5"/>
  ${bars}
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
