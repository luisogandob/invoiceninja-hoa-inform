import puppeteer, { type Browser } from 'puppeteer';
import { format } from 'date-fns';
import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import axios from 'axios';
import type { HoaReportData } from './hoaReportData.js';

const _require = createRequire(import.meta.url);

/** Milliseconds to wait for Chart.js to finish rendering all canvases. */
const CHART_RENDER_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Inline bundle cache — read once, reuse for every PDF generated
// ---------------------------------------------------------------------------

let _chartJsBundle: string | null = null;

function getChartJs(): string {
  if (_chartJsBundle === null) {
    // Chart.js 4.x's "exports" field does not expose dist/chart.umd.min.js directly.
    // Resolve the package root by stripping from "/dist/" in the CJS main entry path.
    const cjsEntry = _require.resolve('chart.js');
    const pkgRoot = cjsEntry.replace(/[\\/]dist[\\/][^\\/]+$/, '');
    if (pkgRoot === cjsEntry) {
      throw new Error(
        `[HoaReportGenerator] Could not derive chart.js package root from "${cjsEntry}". ` +
        'Expected a path containing /dist/<filename>.'
      );
    }
    _chartJsBundle = readFileSync(`${pkgRoot}/dist/chart.umd.min.js`, 'utf-8');
  }
  return _chartJsBundle;
}

// ---------------------------------------------------------------------------
// Color-scheme data — extracted server-side from chartjs-plugin-colorschemes
// ---------------------------------------------------------------------------

let _colorData: Record<string, Record<string, string[]>> | null = null;

/**
 * Parse palette arrays from the chartjs-plugin-colorschemes source.
 * The plugin itself is not loaded in the browser (it's Chart.js 2-only);
 * only the raw color arrays are used as JSON.
 *
 * Each palette variable in the source looks like:
 *   \tPaired12 = ['#...', '#...', ...],
 * with a leading tab and values in single-quoted strings.
 */
function getColorData(): Record<string, Record<string, string[]>> {
  if (_colorData !== null) return _colorData;

  const src = readFileSync(
    _require.resolve('chartjs-plugin-colorschemes/dist/chartjs-plugin-colorschemes.js'),
    'utf-8'
  );

  // Collect all palette arrays from the variable declarations section
  const palettes: Record<string, string[]> = {};
  const paletteRe = /^\t(\w+)\s*=\s*(\[[^\]]+\])/gm;
  let m: RegExpExecArray | null;
  while ((m = paletteRe.exec(src)) !== null) {
    try {
      palettes[m[1]] = JSON.parse(m[2].replace(/'/g, '"'));
    } catch {
      // skip malformed entries
    }
  }

  // Group by frozen-object sections: brewer / office / tableau.
  // Pattern: "var groupName = /*#__PURE__*/ Object.freeze({ ... })"
  const groups: Record<string, Record<string, string[]>> = {};
  const groupRe = /var\s+(\w+)\s*=\s*(?:\/\*[^*]*\*\/\s*)?Object\.freeze\(\{([^}]+)\}\)/gs;
  let gm: RegExpExecArray | null;
  while ((gm = groupRe.exec(src)) !== null) {
    const groupName = gm[1];
    const block = gm[2];
    const names = (block.match(/\b(\w+):\s*\1\b/g) ?? []).map(s => s.split(':')[0].trim());
    if (names.length === 0) continue;
    groups[groupName] = {};
    for (const name of names) {
      if (palettes[name]) {
        groups[groupName][name] = palettes[name];
      }
    }
  }

  // Warn if the extraction produced no groups — likely a source format change in the plugin.
  if (Object.keys(groups).length === 0) {
    console.warn(
      '[HoaReportGenerator] Failed to extract any color groups from chartjs-plugin-colorschemes. ' +
      'Color scheme selection will use the fallback palette. ' +
      'This may indicate the plugin\'s source format has changed.'
    );
  }

  _colorData = groups;
  return _colorData;
}

/**
 * HOA Report PDF Generator (new report format).
 *
 * Uses Puppeteer to render an HTML page to PDF.  All charts (bar charts) and
 * KPI big-number displays are rendered with Chart.js.  The color palette is
 * driven by the `CHART_COLOR_SCHEME` env variable (default: `brewer.Paired12`).
 *
 * The browser instance is reused across multiple calls and must be released
 * by calling `close()` when no longer needed.
 */
class HoaReportGenerator {
  private browser: Browser | null = null;
  private readonly colorScheme: string;

  constructor() {
    this.colorScheme = process.env.CHART_COLOR_SCHEME ?? 'brewer.Paired12';
  }

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
    // Fetch / load the company logo as a base64 data URI before rendering
    let logoDataUri: string | undefined;
    if (data.companyInfo?.logoUrl) {
      logoDataUri = await this.fetchLogoAsDataUri(data.companyInfo.logoUrl);
    }

    const html = this.buildHtml(data, logoDataUri);
    const browser = await this.getBrowser();

    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      // Wait for Chart.js to finish rendering all canvases
      await page.waitForFunction('window.chartsReady === true', { timeout: CHART_RENDER_TIMEOUT_MS });

      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: `
          <div style="width:100%;text-align:center;font-size:10px;padding:10px;font-family:Arial,sans-serif;">
            <span class="pageNumber"></span> / <span class="totalPages"></span>
          </div>`,
        margin: {
          top: '0.5cm',
          bottom: '1cm',
          left: '0.5cm',
          right: '0.5cm'
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

  /**
   * Fetch a logo from a URL or local file path and return it as a base64 data URI
   * so the PDF renderer can embed it without additional network requests.
   * Returns undefined if the logo cannot be loaded (logs a warning).
   */
  private async fetchLogoAsDataUri(url: string): Promise<string | undefined> {
    /** Allowed image MIME types for the logo */
    const ALLOWED_IMAGE_MIMES = new Set([
      'image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp'
    ]);
    const ALLOWED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']);

    try {
      // Already a data URI — validate it is an image type
      if (url.startsWith('data:')) {
        const mime = url.slice(5, url.indexOf(';'));
        return ALLOWED_IMAGE_MIMES.has(mime) ? url : undefined;
      }

      // Local file path — restrict to allowed image extensions
      if (existsSync(url)) {
        const ext = url.toLowerCase().split('.').pop() ?? '';
        if (!ALLOWED_IMAGE_EXTS.has(ext)) {
          console.warn(`[HoaReportGenerator] Rejected logo path with disallowed extension: "${url}"`);
          return undefined;
        }
        const buf = readFileSync(url);
        const mimeMap: Record<string, string> = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp'
        };
        const mime = mimeMap[ext] ?? 'image/png';
        return `data:${mime};base64,${buf.toString('base64')}`;
      }

      // HTTP / HTTPS URL — cap response at 5 MB and validate content type
      if (url.startsWith('http://') || url.startsWith('https://')) {
        const response = await axios.get<ArrayBuffer>(url, {
          responseType: 'arraybuffer',
          timeout: 8_000,
          maxContentLength: 5 * 1024 * 1024
        });
        const ct = (response.headers['content-type'] as string | undefined) ?? '';
        const mime = ct.split(';')[0].trim();
        if (!ALLOWED_IMAGE_MIMES.has(mime)) {
          console.warn(`[HoaReportGenerator] Rejected logo URL with disallowed content-type "${mime}": "${url}"`);
          return undefined;
        }
        const base64 = Buffer.from(response.data).toString('base64');
        return `data:${mime};base64,${base64}`;
      }
    } catch (err) {
      console.warn(
        `[HoaReportGenerator] Could not load logo from "${url}":`,
        (err as Error).message
      );
    }
    return undefined;
  }

  /**
   * Convert a basic subset of Markdown to HTML.
   * Supports: h1/h2/h3, **bold**, *italic*, `code`, unordered and ordered lists,
   * blank-line paragraph breaks, and horizontal rules (---).
   *
   * Text content is HTML-escaped before applying inline formatting, so raw
   * HTML in the Markdown source is rendered as text rather than executed.
   */
  private static parseMarkdown(md: string): string {
    const lines = md.split('\n');
    const html: string[] = [];
    let inUl = false;
    let inOl = false;

    const closeUl = () => { if (inUl) { html.push('</ul>'); inUl = false; } };
    const closeOl = () => { if (inOl) { html.push('</ol>'); inOl = false; } };
    const closeLists = () => { closeUl(); closeOl(); };

    /** Escape HTML special characters to prevent injection */
    const esc = (t: string): string =>
      t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
       .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

    /** Apply inline Markdown formatting to already-escaped text */
    const inline = (text: string): string => {
      const escaped = esc(text);
      return escaped
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
    };

    for (const line of lines) {
      if (line.startsWith('### ')) {
        closeLists();
        html.push(`<h3>${inline(line.slice(4))}</h3>`);
      } else if (line.startsWith('## ')) {
        closeLists();
        html.push(`<h2>${inline(line.slice(3))}</h2>`);
      } else if (line.startsWith('# ')) {
        closeLists();
        html.push(`<h1>${inline(line.slice(2))}</h1>`);
      } else if (/^[-*] /.test(line)) {
        closeOl();
        if (!inUl) { html.push('<ul>'); inUl = true; }
        html.push(`<li>${inline(line.slice(2))}</li>`);
      } else if (/^\d+\. /.test(line)) {
        closeUl();
        if (!inOl) { html.push('<ol>'); inOl = true; }
        html.push(`<li>${inline(line.replace(/^\d+\. /, ''))}</li>`);
      } else if (/^-{3,}$/.test(line.trim()) || /^={3,}$/.test(line.trim())) {
        closeLists();
        html.push('<hr>');
      } else if (line.trim() === '') {
        closeLists();
        html.push('<p style="margin:0;line-height:0.6em">&nbsp;</p>');
      } else {
        closeLists();
        html.push(`<p>${inline(line)}</p>`);
      }
    }
    closeLists();
    return html.join('\n');
  }

  // SVG icons (stroke-based, currentColor, heroicons style)
  private static readonly ICON_INVOICE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>`;
  private static readonly ICON_PAYMENT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><line x1="12" y1="6" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="18"/></svg>`;
  private static readonly ICON_EXPENSE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16l3-3 3 3 3-3 3 3V4a2 2 0 0 0-2-2z"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/></svg>`;
  private static readonly ICON_RECEIVABLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 15 9 15 6 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`;
  private static readonly ICON_PAYABLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`;
  private static readonly ICON_CASH = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/></svg>`;
  /** Cash inflow — arrow pointing up (green) */
  private static readonly ICON_CASH_IN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="16 12 12 8 8 12"/><line x1="12" y1="16" x2="12" y2="8"/></svg>`;
  /** Cash outflow — arrow pointing down (red) */
  private static readonly ICON_CASH_OUT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="8 12 12 16 16 12"/><line x1="12" y1="8" x2="12" y2="16"/></svg>`;

  buildHtml(data: HoaReportData, logoDataUri?: string): string {
    const {
      title,
      periodStart,
      periodEnd,
      generatedAt,
      totalInvoicedInPeriod,
      totalPaymentsInPeriod,
      totalExpensesInPeriod,
      totalExpensesPaidInPeriod,
      arAtPeriodStart,
      arAtPeriodEnd,
      apAtPeriodStart,
      apAtPeriodEnd,
      paymentsByGroup,
      arByGroup,
      arByUnit,
      arByGroupUnit,
      arByClient,
      expensesByCategory,
      expensesByVendor,
      apAgingBuckets,
      apByVendor,
      cashFlowEntries,
      cfDailyData,
      paymentHeatmap,
      perpetualResult,
      bankBalance,
      companyInfo,
      docsMarkdown
    } = data;

    // Validate that the logo data URI is safe to embed (must be an image type)
    const safeLogoDataUri = logoDataUri?.startsWith('data:image/') ? logoDataUri : undefined;

    const fmt = (n: number) =>
      n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // ── Summary metrics for Resumen Ejecutivo first row ──────────────────────
    /** Net result for the current period (payments received − expenses paid in period) */
    const periodResult = totalPaymentsInPeriod - totalExpensesPaidInPeriod;
    /** Collection rate: payments / invoiced × 100, or null when no invoices were issued */
    const cobranzaPct = totalInvoicedInPeriod > 0
      ? (totalPaymentsInPeriod / totalInvoicedInPeriod * 100).toFixed(1)
      : null;
    /** Outstanding AR that is older than 60 days (aged61_90 + aged90plus across all groups) */
    const arMorosidad = arByGroup.reduce((s, g) => s + g.aged90plus, 0);
    /** Formatted morosidad string "$$X (Y%)" or null when arAtPeriodEnd is 0 */
    const arMorosidadStr = arAtPeriodEnd > 0
      ? `$${fmt(arMorosidad)} (${(arMorosidad / arAtPeriodEnd * 100).toFixed(1)}%)`
      : null;

    // ── Stacked chart data (serialised server-side for safe embedding) ──────
    const paymentsLabels  = JSON.stringify(paymentsByGroup.map(p => p.groupName));
    const payments0_35    = JSON.stringify(paymentsByGroup.map(p => p.aged0_35));
    const payments36_95   = JSON.stringify(paymentsByGroup.map(p => p.aged36_95));
    const payments96plus  = JSON.stringify(paymentsByGroup.map(p => p.aged96plus));

    const arLabels   = JSON.stringify(arByGroup.map(a => a.groupName));
    const ar0_90     = JSON.stringify(arByGroup.map(a => a.aged0_30 + a.aged31_60 + a.aged61_90));
    const ar90plus   = JSON.stringify(arByGroup.map(a => a.aged90plus));
    const arMora     = JSON.stringify(arByGroup.map(a => a.mora));

    // AR stacked-by-unit chart: one column per group, stacked by Unidad Vivienda
    const arGroupLabels = JSON.stringify(arByGroupUnit.map(g => g.groupName));
    // Collect all unit names that appear in any group, sorted for a stable legend
    const arUnitNames = [...new Set(arByGroupUnit.flatMap(g => Object.keys(g.byUnit)))].sort();
    // Fixed palette for up to 8 units (1A–4B). Modulo wraps for any extras.
    const arUnitPalette = ['#3b82f6','#22c55e','#f59e0b','#ef4444','#a855f7','#06b6d4','#f97316','#ec4899'];
    const arUnitDatasets = JSON.stringify(
      arUnitNames.map((u, i) => ({
        label: u,
        data: arByGroupUnit.map(g => g.byUnit[u] ?? 0),
        backgroundColor: arUnitPalette[i % arUnitPalette.length],
        borderWidth: 0
      }))
    );

    // Daily bank-balance line chart data
    const cfDailyDates   = JSON.stringify(cfDailyData.dates);
    const cfDailyBalance = JSON.stringify(cfDailyData.balance);

    // ── KPI helpers ──────────────────────────────────────────────────────────

    /** Row-1 metric item: icon + label + big value + optional sub-line */
    const kpiMetric = (icon: string, lines: string[], value: string, colorCls: string, subHtml?: string): string => {
      const lbl = lines.map(l => this.esc(l)).join('<br>');
      return `
      <div class="kpi-item ${colorCls}">
        <div class="kpi-icon">${icon}</div>
        <div class="kpi-label">${lbl}</div>
        <div class="kpi-value">${this.esc(value)}</div>
        ${subHtml ? subHtml : ''}
      </div>`;
    };

    /** Row-2 balance item: icon + label + value + trend arrow + delta */
    const kpiBalance = (
      icon: string,
      lines: string[],
      valueEnd: number,
      valueStart: number,
      colorCls: string,
      available: boolean,
      subHtml?: string
    ): string => {
      const lbl   = lines.map(l => this.esc(l)).join('<br>');
      const delta = valueEnd - valueStart;
      const trendCls = delta > 0 ? 'kpi-trend--up' : delta < 0 ? 'kpi-trend--down' : 'kpi-trend--flat';
      const arrow    = delta > 0 ? '▲' : delta < 0 ? '▼' : '─';
      const trendHtml = available
        ? `<div class="kpi-trend ${trendCls}">${arrow} $${this.esc(fmt(Math.abs(delta)))} vs. inicio del período</div>`
        : `<div class="kpi-trend kpi-trend--flat">No trazado</div>`;
      const valueHtml = available
        ? `<div class="kpi-value">${this.esc(`$${fmt(valueEnd)}`)}</div>`
        : `<div class="kpi-value kpi-na">N/D</div>`;
      return `
      <div class="kpi-item ${colorCls}">
        <div class="kpi-icon">${icon}</div>
        <div class="kpi-label">${lbl}</div>
        ${valueHtml}
        ${trendHtml}
        ${subHtml ?? ''}
      </div>`;
    };

    // colour scheme is still resolved for future use (kept for consistency)
    const [schemeGroup, schemeKey] = this.colorScheme.split('.');
    if (!schemeGroup || !schemeKey) {
      console.warn(
        `[HoaReportGenerator] CHART_COLOR_SCHEME "${this.colorScheme}" is not in the expected ` +
        `"group.SchemeName" format (e.g. "brewer.Paired12"). Using fallback palette.`
      );
    }
    const colorData = getColorData();
    if (!colorData[schemeGroup]?.[schemeKey]) {
      console.warn(
        `[HoaReportGenerator] CHART_COLOR_SCHEME "${this.colorScheme}" not found in colorschemes data.`
      );
    }

    // ── Doughnut chart data for Análisis de Gastos page ─────────────────────
    // Palette is extracted server-side from the configured color scheme (or fallback)
    const doughnutPalette: string[] = colorData[schemeGroup]?.[schemeKey] ??
      ['#3b82f6','#22c55e','#f59e0b','#ef4444','#a855f7','#06b6d4','#f97316','#ec4899','#8b5cf6','#14b8a6','#f43f5e','#84cc16'];

    const expCatLabels  = JSON.stringify(expensesByCategory.map(e => e.categoryName));
    const expCatAmounts = JSON.stringify(expensesByCategory.map(e => e.amount));
    const expCatColors  = JSON.stringify(expensesByCategory.map((_, i) => doughnutPalette[i % doughnutPalette.length]));

    // ── Doughnut chart data for Análisis de CxC page (AR by group) ──────────
    const arGroupDoughnutLabels  = JSON.stringify(arByGroup.map(g => g.groupName));
    const arGroupDoughnutAmounts = JSON.stringify(arByGroup.map(g => g.balance));
    const arGroupDoughnutColors  = JSON.stringify(arByGroup.map((_, i) => doughnutPalette[i % doughnutPalette.length]));

    // ── AR by-group table HTML (Análisis de CxC — left column) ──────────────
    // No tfoot — the total is carried by the aging table immediately below.
    const arGroupTotal = arByGroup.reduce((s, g) => s + g.balance, 0);
    const arGroupTableHtml = arByGroup.length > 0
      ? `<table class="vendor-table" style="margin-top:16px">
          <thead>
            <tr>
              <th>Grupo</th>
              <th class="amount-col">Monto</th>
            </tr>
          </thead>
          <tbody>
            ${arByGroup.map(g =>
              `<tr><td>${this.esc(g.groupName)}</td><td class="amount-col">$${fmt(g.balance)}</td></tr>`
            ).join('\n            ')}
          </tbody>
        </table>`
      : '<p class="no-data">Sin cuentas por cobrar al cierre del período.</p>';

    // ── AR aging-by-emission table (below group table, left column) ──────────
    const aging0_30   = arByGroup.reduce((s, g) => s + g.aged0_30,   0);
    const aging31_60  = arByGroup.reduce((s, g) => s + g.aged31_60,  0);
    const aging61_90  = arByGroup.reduce((s, g) => s + g.aged61_90,  0);
    const aging90plus = arByGroup.reduce((s, g) => s + g.aged90plus, 0);
    const arAgingTableHtml = arByGroup.length > 0
      ? `<table class="vendor-table" style="margin-top:12px">
          <thead>
            <tr>
              <th>Antigüedad de Emisión</th>
              <th class="amount-col">Monto</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>1 – 30 Días</td><td class="amount-col">$${fmt(aging0_30)}</td></tr>
            <tr><td>31 – 60 Días</td><td class="amount-col">$${fmt(aging31_60)}</td></tr>
            <tr><td>61 – 90 Días</td><td class="amount-col">$${fmt(aging61_90)}</td></tr>
            <tr><td>+90 Días</td><td class="amount-col">$${fmt(aging90plus)}</td></tr>
          </tbody>
          <tfoot>
            <tr>
              <td class="total-label">Total</td>
              <td class="amount-col">$${fmt(arGroupTotal)}</td>
            </tr>
          </tfoot>
        </table>`
      : '';

    // ── AR by-client table HTML (Análisis de CxC — right column) ────────────
    const arClientTotal   = arByClient.reduce((s, c) => s + c.balance, 0);
    const arClientTotalInvoices = arByClient.reduce((s, c) => s + c.invoiceCount, 0);
    const arClientTableHtml = arByClient.length > 0
      ? `<table class="vendor-table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Grupo</th>
              <th class="amount-col"># Facturas</th>
              <th class="amount-col">Monto</th>
            </tr>
          </thead>
          <tbody>
            ${arByClient.map(c =>
              `<tr>
                <td>${this.esc(c.clientName)}</td>
                <td>${this.esc(c.groupName)}</td>
                <td class="amount-col">${c.invoiceCount}</td>
                <td class="amount-col">$${fmt(c.balance)}</td>
              </tr>`
            ).join('\n            ')}
          </tbody>
          <tfoot>
            <tr>
              <td class="total-label" colspan="2">Total</td>
              <td class="amount-col">${arClientTotalInvoices}</td>
              <td class="amount-col">$${fmt(arClientTotal)}</td>
            </tr>
          </tfoot>
        </table>`
      : '<p class="no-data">Sin cuentas por cobrar al cierre del período.</p>';

    // ── AP aging table HTML (Análisis de CxP — left column) ─────────────────
    const apTotal = apAgingBuckets.aged0_30 + apAgingBuckets.aged31_60 +
                    apAgingBuckets.aged61_90 + apAgingBuckets.aged90plus;
    const apHasData = apTotal > 0;
    const apAgingTableHtml = apHasData
      ? `<table class="vendor-table" style="margin-top:12px">
          <thead>
            <tr>
              <th>Antigüedad de Emisión</th>
              <th class="amount-col">Monto</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>1 – 30 Días</td><td class="amount-col">$${fmt(apAgingBuckets.aged0_30)}</td></tr>
            <tr><td>31 – 60 Días</td><td class="amount-col">$${fmt(apAgingBuckets.aged31_60)}</td></tr>
            <tr><td>61 – 90 Días</td><td class="amount-col">$${fmt(apAgingBuckets.aged61_90)}</td></tr>
            <tr><td>+90 Días</td><td class="amount-col">$${fmt(apAgingBuckets.aged90plus)}</td></tr>
          </tbody>
          <tfoot>
            <tr>
              <td class="total-label">Total</td>
              <td class="amount-col">$${fmt(apTotal)}</td>
            </tr>
          </tfoot>
        </table>`
      : '<p class="no-data">Sin cuentas por pagar al cierre del período.</p>';

    // ── AP by-vendor table HTML (Análisis de CxP — right column) ────────────
    const apVendorTotal         = apByVendor.reduce((s, v) => s + v.balance, 0);
    const apVendorTotalExpenses = apByVendor.reduce((s, v) => s + v.expenseCount, 0);
    const apVendorTableHtml = apByVendor.length > 0
      ? `<table class="vendor-table">
          <thead>
            <tr>
              <th>Suplidor</th>
              <th class="amount-col"># Gastos</th>
              <th class="amount-col">Monto</th>
            </tr>
          </thead>
          <tbody>
            ${apByVendor.map(v =>
              `<tr>
                <td>${this.esc(v.vendorName)}</td>
                <td class="amount-col">${v.expenseCount}</td>
                <td class="amount-col">$${fmt(v.balance)}</td>
              </tr>`
            ).join('\n            ')}
          </tbody>
          <tfoot>
            <tr>
              <td class="total-label">Total</td>
              <td class="amount-col">${apVendorTotalExpenses}</td>
              <td class="amount-col">$${fmt(apVendorTotal)}</td>
            </tr>
          </tfoot>
        </table>`
      : '<p class="no-data">Sin cuentas por pagar al cierre del período.</p>';

    // ── AP donut chart data (serialised server-side) ─────────────────────────
    const apDoughnutLabels  = JSON.stringify(['1 – 30 Días', '31 – 60 Días', '61 – 90 Días', '+90 Días']);
    const apDoughnutAmounts = JSON.stringify([
      apAgingBuckets.aged0_30, apAgingBuckets.aged31_60,
      apAgingBuckets.aged61_90, apAgingBuckets.aged90plus
    ]);
    const apDoughnutColors  = JSON.stringify(['#22c55e', '#f59e0b', '#f97316', '#ef4444']);

    // ── Payment heatmap HTML (Comportamiento Histórico de Pagos) ────────────
    const hmColKeys = paymentHeatmap.columnKeys;
    const statusClass: Record<string, string> = {
      paid_0_35: 'hm-c-paid-0-35',
      paid_36_60: 'hm-c-paid-36-60',
      paid_61_90: 'hm-c-paid-61-90',
      paid_90plus: 'hm-c-paid-90plus',
      pending: 'hm-c-pending',
      none: 'hm-c-none',
    };

    // Group header row (merged cells per group)
    const hmGroupHeaderCells = paymentHeatmap.groups.map(g =>
      `<th class="hm-group-hdr hm-group-first" colspan="${g.units.length}">${this.esc(g.groupName)}</th>`
    ).join('');

    // Unit header row
    const hmUnitHeaderCells = hmColKeys.map((ck, idx) => {
      const unitLabel = ck.split('|')[1] ?? ck;
      // Mark the first column of each group with a divider class
      const isGroupFirst = idx === 0 || ck.split('|')[0] !== hmColKeys[idx - 1].split('|')[0];
      const extra = isGroupFirst ? ' hm-group-first' : '';
      return `<th class="hm-unit-hdr${extra}">${this.esc(unitLabel)}</th>`;
    }).join('');

    // Data rows
    const hmDataRows = paymentHeatmap.rows.map(row => {
      const dataCells = hmColKeys.map((ck, idx) => {
        const isGroupFirst = idx === 0 || ck.split('|')[0] !== hmColKeys[idx - 1].split('|')[0];
        const extra = isGroupFirst ? ' hm-group-first' : '';
        return `<td class="hm-cell ${statusClass[row.cells[ck] ?? 'none']}${extra}"></td>`;
      }).join('');
      return `<tr><td class="hm-month-col">${this.esc(row.monthLabel)}</td>${dataCells}</tr>`;
    }).join('\n        ');

    const heatmapHtml = hmColKeys.length > 0
      ? `<table class="heatmap-table">
        <thead>
          <tr>
            <th class="hm-month-col"></th>
            ${hmGroupHeaderCells}
          </tr>
          <tr>
            <th class="hm-month-col"></th>
            ${hmUnitHeaderCells}
          </tr>
        </thead>
        <tbody>
        ${hmDataRows}
        </tbody>
      </table>
      <div class="hm-legend">
        <div class="hm-legend-item"><div class="hm-legend-swatch hm-c-paid-0-35"></div>Pagado ≤35 días</div>
        <div class="hm-legend-item"><div class="hm-legend-swatch hm-c-paid-36-60"></div>Pagado 36–60 días</div>
        <div class="hm-legend-item"><div class="hm-legend-swatch hm-c-paid-61-90"></div>Pagado 61–90 días</div>
        <div class="hm-legend-item"><div class="hm-legend-swatch hm-c-paid-90plus"></div>Pagado +90 días</div>
        <div class="hm-legend-item"><div class="hm-legend-swatch hm-c-pending"></div>Facturas pendientes</div>
        <div class="hm-legend-item"><div class="hm-legend-swatch hm-c-none"></div>Sin facturas</div>
      </div>`
      : '<p class="no-data">Sin datos históricos disponibles.</p>';

    // ── Category table HTML (built server-side) ──────────────────────────────
    const categoryTotal = expensesByCategory.reduce((s, c) => s + c.amount, 0);
    const categoryTableHtml = expensesByCategory.length > 0
      ? `<table class="vendor-table" style="margin-top:16px">
          <thead>
            <tr>
              <th>Categoría</th>
              <th class="amount-col">Monto</th>
            </tr>
          </thead>
          <tbody>
            ${expensesByCategory.map(c =>
              `<tr><td>${this.esc(c.categoryName)}</td><td class="amount-col">$${fmt(c.amount)}</td></tr>`
            ).join('\n            ')}
          </tbody>
          <tfoot>
            <tr>
              <td class="total-label">Total</td>
              <td class="amount-col">$${fmt(categoryTotal)}</td>
            </tr>
          </tfoot>
        </table>`
      : '';

    // ── Vendor table HTML (built server-side) ────────────────────────────────
    const vendorTotal = expensesByVendor.reduce((s, v) => s + v.amount, 0);
    const vendorTableHtml = expensesByVendor.length > 0
      ? `<table class="vendor-table">
          <thead>
            <tr>
              <th>Suplidor</th>
              <th class="amount-col">Monto</th>
            </tr>
          </thead>
          <tbody>
            ${expensesByVendor.map(v =>
              `<tr><td>${this.esc(v.vendorName)}</td><td class="amount-col">$${fmt(v.amount)}</td></tr>`
            ).join('\n            ')}
          </tbody>
          <tfoot>
            <tr>
              <td class="total-label">Total</td>
              <td class="amount-col">$${fmt(vendorTotal)}</td>
            </tr>
          </tfoot>
        </table>`
      : `<p class="no-data">Sin gastos en el período.</p>`;

    // ── Cash flow table HTML (built server-side) ─────────────────────────────
    const cfTotalIn  = cashFlowEntries
      .filter(e => e.type === 'payment')
      .reduce((s, e) => s + e.amount, 0);
    const cfTotalOut = cashFlowEntries
      .filter(e => e.type === 'expense')
      .reduce((s, e) => s + e.amount, 0);
    const cfResult   = cfTotalIn - cfTotalOut;
    const cfResultSign = cfResult >= 0 ? '+' : '−';

    /** Format a YYYY-MM-DD date string as a single dd/mm/yyyy line */
    const fmtDate1 = (dateStr: string): string => {
      if (!dateStr) return '';
      const parts = dateStr.split('-');
      if (parts.length < 3) return dateStr;
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    };

    const cfRowsHtml = cashFlowEntries.length > 0
      ? cashFlowEntries.map(entry => {
          const isIn = entry.type === 'payment';
          const icon = isIn
            ? `<span class="cf-icon cf-icon--in">${HoaReportGenerator.ICON_CASH_IN}</span>`
            : `<span class="cf-icon cf-icon--out">${HoaReportGenerator.ICON_CASH_OUT}</span>`;
          const amountStr = isIn
            ? `<span class="cf-amount cf-amount--in">+$${fmt(entry.amount)}</span>`
            : `<span class="cf-amount cf-amount--out">−$${fmt(entry.amount)}</span>`;
          const subLineHtml = entry.subLine
            ? `<div class="cf-subline">${this.esc(entry.subLine)}</div>`
            : '';
          const subLine2Html = entry.subLine2
            ? `<div class="cf-subline">${this.esc(entry.subLine2)}</div>`
            : '';
          const numberSecondLine = entry.number
            ? `<div class="cf-num-secondary">${this.esc(entry.number)}</div>`
            : '';
          return `<tr>
            <td class="cf-icon-cell">${icon}</td>
            <td class="cf-date-cell">${this.esc(fmtDate1(entry.date))}${numberSecondLine}</td>
            <td>${this.esc(entry.name)}${subLineHtml}${subLine2Html}</td>
            <td class="cf-amount-cell">${amountStr}</td>
          </tr>`;
        }).join('\n          ')
      : `<tr><td colspan="4" class="no-data">Sin movimientos en el período.</td></tr>`;

    const cashFlowHtml = `
    <table class="cf-table">
      <thead>
        <tr>
          <th></th>
          <th>Fecha / Número</th>
          <th>Descripción</th>
          <th class="cf-amount-cell">Monto</th>
        </tr>
      </thead>
      <tbody>
        ${cfRowsHtml}
        <tr class="cf-totals-row">
          <td colspan="3" class="cf-total-label">Total de Pagos Recibidos</td>
          <td class="cf-amount-cell cf-total-in">+$${fmt(cfTotalIn)}</td>
        </tr>
        <tr class="cf-totals-row">
          <td colspan="3" class="cf-total-label">Total de Pagos Realizados</td>
          <td class="cf-amount-cell cf-total-out">−$${fmt(cfTotalOut)}</td>
        </tr>
        <tr class="cf-totals-row cf-result-total-row">
          <td colspan="3" class="cf-total-label">Resultado del Período</td>
          <td class="cf-amount-cell ${cfResult >= 0 ? 'cf-total-in' : 'cf-total-out'}">${cfResultSign}$${fmt(Math.abs(cfResult))}</td>
        </tr>
      </tbody>
    </table>
    <div class="chart-section" style="margin-top: 28px;">
      <div class="section-title">Balance Diario en Banco según Registros</div>
      <canvas id="chart-cf-daily" width="680" height="250"></canvas>
    </div>
    <div class="cf-bank-balance-row">
      <div>
        <div class="cf-bank-balance-label">Balance en Banco</div>
        <div class="cf-bank-balance-sub">Pendiente de Conciliar al ${this.esc(fmtDate1(periodEnd))}</div>
      </div>
      <div class="cf-bank-balance-amount ${bankBalance >= 0 ? 'cf-total-in' : 'cf-total-out'}">${bankBalance >= 0 ? '+' : '−'}$${fmt(Math.abs(bankBalance))}</div>
    </div>`;

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>${this.esc(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; color: #1f2937; background: #fff; padding: 8px; }

    /* ── Header ── */
    .report-header {
      text-align: center;
      border-bottom: 3px solid #1e2d3d;
      padding-bottom: 18px;
      margin-bottom: 28px;
    }
    .report-header h1 { font-size: 24px; color: #1e2d3d; margin-bottom: 6px; font-weight: 700; }
    .report-header .meta { font-size: 12px; color: #6b7280; margin-top: 3px; }

    /* ── KPI section ── */
    .kpi-row1 {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      margin-bottom: 14px;
    }
    .kpi-row2 {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 14px;
      margin-bottom: 36px;
    }
    .kpi-item {
      padding: 14px 16px;
      border: 1px solid #e5e7eb;
      border-top: 3px solid #e5e7eb;
    }
    /* accent colors */
    .kpi-blue   { border-top-color: #1d4ed8; }
    .kpi-green  { border-top-color: #16a34a; }
    .kpi-amber  { border-top-color: #b45309; }
    .kpi-sky    { border-top-color: #0284c7; }
    .kpi-violet { border-top-color: #7c3aed; }
    /* icon colors */
    .kpi-icon { display: block; width: 24px; height: 24px; margin-bottom: 8px; }
    .kpi-blue .kpi-icon   { color: #1d4ed8; }
    .kpi-green .kpi-icon  { color: #16a34a; }
    .kpi-amber .kpi-icon  { color: #b45309; }
    .kpi-sky .kpi-icon    { color: #0284c7; }
    .kpi-violet .kpi-icon { color: #7c3aed; }
    /* text */
    .kpi-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 1.1px;
      text-transform: uppercase;
      color: #6b7280;
      line-height: 1.5;
      margin-bottom: 6px;
    }
    .kpi-value {
      font-size: 24px;
      font-weight: 700;
      color: #111827;
      letter-spacing: -0.5px;
    }
    .kpi-na { font-size: 18px; color: #9ca3af; font-style: italic; }
    /* trend */
    .kpi-trend { margin-top: 6px; font-size: 11px; font-weight: 600; }
    .kpi-trend--up   { color: #dc2626; }   /* ▲ red  — more owed = bad */
    .kpi-trend--down { color: #16a34a; }   /* ▼ green — less owed = good */
    .kpi-trend--flat { color: #9ca3af; }
    /* sub-line shown inside a metric card (e.g. paid expenses below total expenses) */
    .kpi-sub {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-top: 8px;
      font-size: 11px;
      font-weight: 600;
      color: #6b7280;
    }
    .kpi-sub svg { width: 14px; height: 14px; flex-shrink: 0; }

    /* ── Period-result cards (kpi-row0) side-by-side in Resumen Ejecutivo ── */
    .kpi-row0 {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 14px;
      margin-bottom: 14px;
    }
    /* Resultado del Período total row inside CF table */
    .cf-result-total-row td {
      font-size: 13px;
      border-top: 2px solid #374151 !important;
    }
    /* Bank balance row below the CF daily chart */
    .cf-bank-balance-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 12px;
      padding: 10px 16px;
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
    }
    .cf-bank-balance-label {
      font-size: 13px;
      font-weight: 700;
      color: #1f2937;
    }
    .cf-bank-balance-sub {
      font-size: 11px;
      color: #6b7280;
      margin-top: 2px;
    }
    .cf-bank-balance-amount {
      font-size: 18px;
      font-weight: 800;
    }

    /* ── Section titles ── */
    .section-title {
      font-size: 15px;
      font-weight: 700;
      color: #1e2d3d;
      margin-bottom: 14px;
      padding-bottom: 6px;
      border-bottom: 2px solid #1e2d3d;
    }

    /* ── Chart wrapper ── */
    .chart-section { margin-bottom: 16px; }
    .chart-section canvas { display: block; margin: 0 auto; }

    /* ── No data ── */
    .no-data { color: #9ca3af; font-size: 13px; text-align: center; padding: 24px 0; }

    /* ── Análisis de Gastos page ── */
    .expense-analysis-cols {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 28px;
      align-items: start;
    }
    .expense-analysis-cols canvas { display: block; margin: 0 auto; }

    /* Vendor summary table */
    .vendor-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .vendor-table th,
    .vendor-table td {
      padding: 7px 10px;
      border-bottom: 1px solid #e5e7eb;
      text-align: left;
    }
    .vendor-table th {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: #6b7280;
      background: #f9fafb;
    }
    .vendor-table tfoot td {
      font-weight: 700;
      border-top: 2px solid #1e2d3d;
      border-bottom: none;
    }
    .vendor-table .amount-col { text-align: right; }
    .total-label { font-size: 12px; }

    /* ── Flujo de Efectivo page ── */
    .cf-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .cf-table th,
    .cf-table td {
      padding: 6px 8px;
      border-bottom: 1px solid #e5e7eb;
      vertical-align: top;
    }
    .cf-table th {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: #6b7280;
      background: #f9fafb;
      white-space: nowrap;
    }
    .cf-icon-cell { width: 26px; text-align: center; padding-top: 7px; }
    .cf-icon { display: inline-block; width: 18px; height: 18px; }
    .cf-icon--in  { color: #16a34a; }
    .cf-icon--out { color: #dc2626; }
    .cf-date-cell { white-space: nowrap; font-size: 11px; }
    .cf-num-secondary { font-size: 10px; color: #6b7280; margin-top: 1px; }
    .cf-subline   { font-size: 10px; color: #6b7280; margin-top: 2px; }
    .cf-amount-cell { text-align: right; white-space: nowrap; font-size: 12px; }
    .cf-amount { font-weight: 600; }
    .cf-amount--in  { color: #16a34a; }
    .cf-amount--out { color: #dc2626; }
    .cf-totals-row td {
      font-weight: 700;
      border-bottom: none;
      background: #f9fafb;
    }
    .cf-totals-row:first-of-type td { border-top: 2px solid #1e2d3d; }
    .cf-total-label { font-size: 12px; }
    .cf-total-in  { color: #16a34a; }
    .cf-total-out { color: #dc2626; }
    /* ── Period result card ── */
    .cf-result-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 12px;
      padding: 8px 16px;
      border-radius: 8px;
      color: #fff;
    }
    .cf-result-card--pos { background: #16a34a; }
    .cf-result-card--neg { background: #dc2626; }
    .cf-result-card__left {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .cf-result-card__label {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      opacity: 0.9;
    }
    .cf-result-card__sub {
      font-size: 11px;
      font-weight: 400;
      opacity: 0.8;
      text-transform: none;
      letter-spacing: 0;
    }
    .cf-result-card__amount {
      font-size: 18px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }

    /* ── Comportamiento Histórico de Pagos — landscape heatmap ── */
    @page heatmap-ls { size: A4 landscape; margin: 0.5cm 0.5cm 1cm; }
    .page-heatmap { page: heatmap-ls; }

    .heatmap-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 10px;
    }
    .heatmap-table th,
    .heatmap-table td {
      border: 1px solid #e5e7eb;
      text-align: center;
      vertical-align: middle;
      overflow: hidden;
      white-space: nowrap;
    }
    /* Month-label first column */
    .hm-month-col { width: 52px; text-align: left !important; padding: 0 4px; font-size: 9px; font-weight: 600; color: #374151; background: #f9fafb; }
    /* Group header row */
    .hm-group-hdr { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #1e2d3d; background: #e0e7ef; padding: 4px 2px; }
    /* Unit header row */
    .hm-unit-hdr { font-size: 8px; font-weight: 600; color: #6b7280; background: #f3f4f6; padding: 4px 2px; writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; height: 40px; vertical-align: bottom; }
    /* Group divider — left border on the first column of every client group */
    .hm-group-first { border-left: 2px solid #ffffff !important; }
    /* Data cells */
    .hm-cell { height: 16px; padding: 0; }
    .hm-c-paid-0-35   { background: #22c55e; }   /* green            ≤35 d */
    .hm-c-paid-36-60  { background: #86efac; }   /* light green    36-60 d */
    .hm-c-paid-61-90  { background: #bef264; }   /* yellow-green   61-90 d */
    .hm-c-paid-90plus { background: #fde047; }   /* yellow          >90 d  */
    .hm-c-pending     { background: #fdba74; }   /* light orange — pending */
    .hm-c-none        { background: #f3f4f6; }   /* light grey  — no invs  */
    /* Heatmap legend */
    .hm-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 10px;
      font-size: 9px;
      color: #374151;
    }
    .hm-legend-item { display: flex; align-items: center; gap: 4px; }
    .hm-legend-swatch { width: 14px; height: 14px; border-radius: 2px; border: 1px solid #d1d5db; flex-shrink: 0; }

    /* ── Cover page ── */
    @page cover-pg { size: A4 portrait; margin: 0; }
    .page-cover {
      page: cover-pg;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      min-height: 267mm;
      padding: 40px 48px;
      background: #f8fafc;
    }
    .cover-logo {
      margin-bottom: 36px;
    }
    .cover-logo img {
      max-width: 200px;
      max-height: 120px;
      object-fit: contain;
    }
    .cover-logo-placeholder {
      width: 120px;
      height: 120px;
      border-radius: 50%;
      background: #e0e7ef;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto;
    }
    .cover-company-name {
      font-size: 26px;
      font-weight: 800;
      color: #1e2d3d;
      margin-bottom: 8px;
      letter-spacing: -0.3px;
    }
    .cover-company-detail {
      font-size: 13px;
      color: #6b7280;
      margin-bottom: 4px;
    }
    .cover-divider {
      width: 80px;
      height: 3px;
      background: #1e2d3d;
      margin: 28px auto;
      border-radius: 2px;
    }
    .cover-report-title {
      font-size: 20px;
      font-weight: 700;
      color: #1e2d3d;
      margin-bottom: 10px;
    }
    .cover-period {
      font-size: 13px;
      color: #6b7280;
      margin-bottom: 4px;
    }
    .cover-generated {
      font-size: 11px;
      color: #9ca3af;
      margin-top: 6px;
    }

    /* ── Table of contents (Índice) ── */
    .page-toc { page-break-before: always; padding-top: 4px; }
    .toc-list {
      list-style: none;
      margin-top: 18px;
    }
    .toc-list li {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 9px 0;
      border-bottom: 1px dotted #d1d5db;
      font-size: 13px;
    }
    .toc-list li:last-child { border-bottom: none; }
    .toc-num {
      min-width: 26px;
      font-weight: 700;
      color: #1e2d3d;
    }
    .toc-title { flex: 1; color: #1f2937; }
    .toc-list a {
      color: inherit;
      text-decoration: none;
    }
    .toc-list a:hover { text-decoration: underline; }

    /* ── Documentation page ── */
    .page-docs { page-break-before: always; padding-top: 4px; }
    .docs-content { font-size: 12px; line-height: 1.7; color: #1f2937; }
    .docs-content h1 {
      font-size: 18px; font-weight: 700; color: #1e2d3d;
      margin: 0 0 10px; padding-bottom: 6px; border-bottom: 2px solid #1e2d3d;
    }
    .docs-content h2 {
      font-size: 14px; font-weight: 700; color: #1e2d3d;
      margin: 18px 0 6px; padding-bottom: 4px; border-bottom: 1px solid #e5e7eb;
    }
    .docs-content h3 {
      font-size: 12px; font-weight: 700; color: #374151; margin: 14px 0 4px;
    }
    .docs-content p { margin: 0 0 6px; }
    .docs-content ul, .docs-content ol {
      margin: 0 0 8px; padding-left: 22px;
    }
    .docs-content li { margin-bottom: 3px; }
    .docs-content strong { font-weight: 700; }
    .docs-content em { font-style: italic; }
    .docs-content code {
      font-family: monospace; font-size: 11px;
      background: #f3f4f6; padding: 1px 4px; border-radius: 3px;
    }
    .docs-content hr {
      border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;
    }

    /* ── Closing page ── */
    .page-closing {
      page-break-before: always;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 60px 48px;
      min-height: 160mm;
      background: #f8fafc;
    }
    .closing-logo img {
      max-width: 120px;
      max-height: 72px;
      object-fit: contain;
      margin-bottom: 24px;
      opacity: 0.7;
    }
    .closing-company-name {
      font-size: 18px; font-weight: 700; color: #1e2d3d; margin-bottom: 6px;
    }
    .closing-detail {
      font-size: 12px; color: #6b7280; margin-bottom: 3px;
    }
    .closing-divider {
      width: 60px; height: 2px; background: #1e2d3d;
      margin: 20px auto; border-radius: 2px;
    }
    .closing-thanks {
      font-size: 14px; font-weight: 600; color: #1e2d3d; margin-bottom: 6px;
    }
    .closing-generated {
      font-size: 10px; color: #9ca3af; margin-top: 8px;
    }
  </style>
</head>
<body>

  <!-- ══ Página 0: Portada ══ -->
  <div class="page-cover">
    <div class="cover-logo">
      ${safeLogoDataUri
        ? `<img src="${safeLogoDataUri}" alt="${this.esc(companyInfo?.name ?? 'Logo')}">`
        : `<div class="cover-logo-placeholder"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#9ca3af" stroke-width="1.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div>`
      }
    </div>
    ${companyInfo?.name ? `<div class="cover-company-name">${this.esc(companyInfo.name)}</div>` : ''}
    ${companyInfo?.rnc     ? `<div class="cover-company-detail">RNC: ${this.esc(companyInfo.rnc)}</div>` : ''}
    ${companyInfo?.website ? `<div class="cover-company-detail">${this.esc(companyInfo.website)}</div>` : ''}
    ${companyInfo?.email   ? `<div class="cover-company-detail">${this.esc(companyInfo.email)}</div>` : ''}
    ${companyInfo?.address ? `<div class="cover-company-detail">${this.esc(companyInfo.address)}</div>` : ''}
    <div class="cover-divider"></div>
    <div class="cover-report-title">${this.esc(title)}</div>
    <div class="cover-period">Período: ${this.esc(periodStart)} — ${this.esc(periodEnd)}</div>
    <div class="cover-generated">Elaborado el: ${format(generatedAt, 'dd/MM/yyyy HH:mm')}</div>
  </div>

  <!-- ══ Página 1: Índice ══ -->
  <div class="page-toc">
    <div class="report-header">
      <h1>Índice</h1>
    </div>
    <ul class="toc-list">
      <li><span class="toc-num">1.</span><span class="toc-title"><a href="#sec-resumen">Resumen Ejecutivo</a></span></li>
      <li><span class="toc-num">2.</span><span class="toc-title"><a href="#sec-heatmap">Comportamiento Histórico de Pagos</a></span></li>
      <li><span class="toc-num">3.</span><span class="toc-title"><a href="#sec-gastos">Análisis de Gastos</a></span></li>
      <li><span class="toc-num">4.</span><span class="toc-title"><a href="#sec-cxc">Análisis de Cuentas x Cobrar</a></span></li>
      <li><span class="toc-num">5.</span><span class="toc-title"><a href="#sec-cxp">Análisis de Cuentas x Pagar</a></span></li>
      <li><span class="toc-num">6.</span><span class="toc-title"><a href="#sec-flujo">Flujo de Efectivo</a></span></li>
      ${docsMarkdown ? `<li><span class="toc-num">7.</span><span class="toc-title"><a href="#sec-docs">Documentación del Informe</a></span></li>` : ''}
    </ul>
  </div>

  <!-- ══ Página 2: Resumen Ejecutivo ══ -->
  <div id="sec-resumen" style="page-break-before: always; padding-top: 4px;">

  <!-- ── Header ── -->
  <div class="report-header">
    <h1>${this.esc(title)}</h1>
    <div class="meta">Período: ${this.esc(periodStart)} — ${this.esc(periodEnd)}</div>
    <div class="meta">Elaborado el: ${format(generatedAt, 'dd/MM/yyyy HH:mm')}</div>
  </div>

  <!-- ── Row 0: Resultado del Período + Balance en Banco ── -->
  <div class="kpi-row0">
    <div class="cf-result-card ${periodResult >= 0 ? 'cf-result-card--pos' : 'cf-result-card--neg'}">
      <div class="cf-result-card__label">Resultado del Período</div>
      <div class="cf-result-card__amount">${periodResult >= 0 ? '+' : '−'}$${this.esc(fmt(Math.abs(periodResult)))}</div>
    </div>
    <div class="cf-result-card ${bankBalance >= 0 ? 'cf-result-card--pos' : 'cf-result-card--neg'}">
      <div class="cf-result-card__left">
        <div class="cf-result-card__label">Balance en Banco</div>
        <div class="cf-result-card__sub">Pendiente de Conciliar al ${this.esc(fmtDate1(periodEnd))}</div>
      </div>
      <div class="cf-result-card__amount">${bankBalance >= 0 ? '+' : '−'}$${this.esc(fmt(Math.abs(bankBalance)))}</div>
    </div>
  </div>

  <!-- ── Row 1: Operational KPIs ── -->
  <div class="kpi-row1">
    ${kpiMetric(HoaReportGenerator.ICON_INVOICE,    ['Cargos Emitidos', 'en el Período'],    `$${fmt(totalInvoicedInPeriod)}`,  'kpi-blue')}
    ${kpiMetric(HoaReportGenerator.ICON_PAYMENT,    ['Pagos Recibidos', 'en el Período'],    `$${fmt(totalPaymentsInPeriod)}`,  'kpi-green',
      cobranzaPct !== null ? `<div class="kpi-sub">${HoaReportGenerator.ICON_CASH} % Cobranza: ${this.esc(cobranzaPct)}%</div>` : undefined)}
    ${kpiMetric(HoaReportGenerator.ICON_EXPENSE,    ['Gastos', 'del Período'],               `$${fmt(totalExpensesInPeriod)}`,  'kpi-amber',
      `<div class="kpi-sub">${HoaReportGenerator.ICON_CASH} $${fmt(totalExpensesPaidInPeriod)} pagado en el período.</div>`)}
  </div>

  <!-- ── Row 2: Balance KPIs with trend ── -->
  <div class="kpi-row2">
    ${kpiBalance(HoaReportGenerator.ICON_RECEIVABLE, ['Total Cuentas', 'por Cobrar'], arAtPeriodEnd, arAtPeriodStart, 'kpi-sky', true,
      arMorosidadStr !== null ? `<div class="kpi-sub">${HoaReportGenerator.ICON_RECEIVABLE} Morosidad +90d: ${this.esc(arMorosidadStr)}</div>` : undefined)}
    ${/* apAtPeriodEnd/Start are 0 (AP not yet integrated); check makes the widget
         show real data automatically once the Bills module is added and populates them */''}
    ${kpiBalance(HoaReportGenerator.ICON_PAYABLE,    ['Total Cuentas', 'por Pagar'],  apAtPeriodEnd,   apAtPeriodStart, 'kpi-violet', apAtPeriodEnd > 0 || apAtPeriodStart > 0)}
  </div>

  <!-- ── Bar Chart: Payments by Client Group (stacked by aging) ── -->
  <div class="chart-section">
    <div class="section-title">Pagos Recibidos en el Período por Grupo de Clientes</div>
    ${paymentsByGroup.length > 0
      ? '<canvas id="chart-payments" width="680" height="220"></canvas>'
      : '<p class="no-data">Sin datos para este período.</p>'}
  </div>

  <!-- ── Bar Chart: AR by Unidad Vivienda (stacked by aging) ── -->
  <div class="chart-section">
    <div class="section-title">Cuentas por Cobrar al Final del Período por Unidad Vivienda</div>
    ${arByUnit.length > 0
      ? '<canvas id="chart-ar" width="680" height="220"></canvas>'
      : '<p class="no-data">Sin datos para este período.</p>'}
  </div>

  </div><!-- /#sec-resumen -->

  <!-- ══ Página 3: Comportamiento Histórico de Pagos (landscape) ══ -->
  <div id="sec-heatmap" class="page-heatmap" style="page-break-before: always; padding-top: 4px;">
    <div class="report-header">
      <h1>Comportamiento Histórico de Pagos</h1>
      <div class="meta">Período: ${this.esc(periodStart)} — ${this.esc(periodEnd)}</div>
    </div>
    ${heatmapHtml}
  </div>

  <!-- ══ Página 4: Análisis de Gastos ══ -->
  <div id="sec-gastos" style="page-break-before: always; padding-top: 4px;">
    <div class="report-header">
      <h1>Análisis de Gastos</h1>
      <div class="meta">Período: ${this.esc(periodStart)} — ${this.esc(periodEnd)}</div>
    </div>

    <div class="expense-analysis-cols">
      <!-- Left column: doughnut chart of expense categories -->
      <div>
        <div class="section-title">Categoría de Gastos en el Período</div>
        ${expensesByCategory.length > 0
          ? '<canvas id="chart-expense-cat" width="320" height="320"></canvas>'
          : '<p class="no-data">Sin gastos en el período.</p>'}
        ${categoryTableHtml}
      </div>
      <!-- Right column: vendor expense table -->
      <div>
        <div class="section-title">Gastos por Suplidor</div>
        ${vendorTableHtml}
      </div>
    </div>
  </div>

  <!-- ══ Página 5: Análisis de Cuentas x Cobrar ══ -->
  <div id="sec-cxc" style="page-break-before: always; padding-top: 4px;">
    <div class="report-header">
      <h1>Análisis de Cuentas x Cobrar</h1>
      <div class="meta">Al ${this.esc(periodEnd)}</div>
    </div>

    <div class="expense-analysis-cols">
      <!-- Left column: donut chart by group + group summary table + aging table -->
      <div>
        <div class="section-title">CxC por Grupo de Cliente</div>
        ${arByGroup.length > 0
          ? '<canvas id="chart-ar-donut" width="320" height="320"></canvas>'
          : '<p class="no-data">Sin cuentas por cobrar al cierre del período.</p>'}
        ${arGroupTableHtml}
        ${arByGroup.length > 0 ? '<div class="section-title" style="margin-top:16px">Saldo por Antigüedad de Emisión</div>' : ''}
        ${arAgingTableHtml}
      </div>
      <!-- Right column: per-client breakdown table -->
      <div>
        <div class="section-title">Desglose por Cliente</div>
        ${arClientTableHtml}
      </div>
    </div>
  </div>

  <!-- ══ Página 6: Análisis de Cuentas x Pagar ══ -->
  <div id="sec-cxp" style="page-break-before: always; padding-top: 4px;">
    <div class="report-header">
      <h1>Análisis de Cuentas x Pagar</h1>
      <div class="meta">Al ${this.esc(periodEnd)}</div>
    </div>

    <div class="expense-analysis-cols">
      <!-- Left column: donut chart by aging + aging breakdown table -->
      <div>
        <div class="section-title">CxP por Antigüedad de Emisión</div>
        ${apHasData
          ? '<canvas id="chart-ap-donut" width="320" height="320"></canvas>'
          : '<p class="no-data">Sin cuentas por pagar al cierre del período.</p>'}
        ${apHasData ? '<div class="section-title" style="margin-top:16px">Saldo por Antigüedad de Emisión</div>' : ''}
        ${apAgingTableHtml}
      </div>
      <!-- Right column: per-vendor breakdown table -->
      <div>
        <div class="section-title">Desglose por Suplidor</div>
        ${apVendorTableHtml}
      </div>
    </div>
  </div>

  <!-- ══ Página 7: Flujo de Efectivo ══ -->
  <div id="sec-flujo" style="page-break-before: always; padding-top: 4px;">
    <div class="report-header">
      <h1>Flujo de Efectivo</h1>
      <div class="meta">Período: ${this.esc(periodStart)} — ${this.esc(periodEnd)}</div>
    </div>
    ${cashFlowHtml}
  </div>

  ${docsMarkdown ? `
  <!-- ══ Página 8: Documentación del Informe ══ -->
  <div id="sec-docs" class="page-docs">
    <div class="report-header">
      <h1>Documentación del Informe</h1>
    </div>
    <div class="docs-content">
      ${HoaReportGenerator.parseMarkdown(docsMarkdown)}
    </div>
  </div>` : ''}

  <!-- ══ Página de Cierre ══ -->
  <div id="sec-cierre" class="page-closing">
    ${safeLogoDataUri ? `<div class="closing-logo"><img src="${safeLogoDataUri}" alt="${this.esc(companyInfo?.name ?? 'Logo')}"></div>` : ''}
    ${companyInfo?.name ? `<div class="closing-company-name">${this.esc(companyInfo.name)}</div>` : ''}
    ${companyInfo?.rnc     ? `<div class="closing-detail">RNC: ${this.esc(companyInfo.rnc)}</div>` : ''}
    ${companyInfo?.website ? `<div class="closing-detail">${this.esc(companyInfo.website)}</div>` : ''}
    ${companyInfo?.email   ? `<div class="closing-detail">${this.esc(companyInfo.email)}</div>` : ''}
    ${companyInfo?.address ? `<div class="closing-detail">${this.esc(companyInfo.address)}</div>` : ''}
    <div class="closing-divider"></div>
    <div class="closing-thanks">${this.esc(title)}</div>
    <div class="closing-detail">Período: ${this.esc(periodStart)} — ${this.esc(periodEnd)}</div>
    <div class="closing-generated">Generado el ${format(generatedAt, 'dd/MM/yyyy')}</div>
  </div>

  <!-- ── Chart.js (inlined) ── -->
  <script>${getChartJs()}</script>
  <script>
  (function () {
    'use strict';

    /* ── Payments stacked bar: green / light orange / dark orange ── */
    function buildPaymentsChart(canvasId, labels, d0_35, d36_95, d96plus) {
      var el = document.getElementById(canvasId);
      if (!el) return;
      new Chart(el, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [
            { label: '\\u2264 35 d\\u00edas',   data: d0_35,   backgroundColor: '#22c55e', borderWidth: 0 },
            { label: '36\\u201395 d\\u00edas',  data: d36_95,  backgroundColor: '#fb923c', borderWidth: 0 },
            { label: '\\u2265 96 d\\u00edas',   data: d96plus, backgroundColor: '#ea580c', borderWidth: 0 }
          ]
        },
        options: {
          responsive: false,
          animation:  false,
          plugins: {
            legend: { display: true, position: 'top', labels: { font: { size: 11 }, padding: 14 } },
            tooltip: {
              callbacks: {
                label: function (item) {
                  return item.dataset.label + ': $' + item.parsed.y.toLocaleString('en-US', {
                    minimumFractionDigits: 2, maximumFractionDigits: 2
                  });
                }
              }
            }
          },
          scales: {
            x: { stacked: true, ticks: { autoSkip: false, maxRotation: 35, minRotation: 0 } },
            y: {
              stacked: true, beginAtZero: true,
              ticks: { callback: function (v) { return '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }); } }
            }
          }
        }
      });
    }

    /* ── AR stacked bar: one column per group, stacked by Unidad Vivienda ── */
    function buildArChart(canvasId, labels, datasets) {
      var el = document.getElementById(canvasId);
      if (!el) return;
      new Chart(el, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: datasets
        },
        options: {
          responsive: false,
          animation:  false,
          plugins: {
            legend: { display: true, position: 'top', labels: { font: { size: 11 }, padding: 14 } },
            tooltip: {
              callbacks: {
                label: function (item) {
                  return item.dataset.label + ': $' + item.parsed.y.toLocaleString('en-US', {
                    minimumFractionDigits: 2, maximumFractionDigits: 2
                  });
                }
              }
            }
          },
          scales: {
            x: { stacked: true, ticks: { autoSkip: false, maxRotation: 35, minRotation: 0 } },
            y: {
              stacked: true, beginAtZero: true,
              ticks: { callback: function (v) { return '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }); } }
            }
          }
        }
      });
    }

    buildPaymentsChart('chart-payments', ${paymentsLabels}, ${payments0_35}, ${payments36_95}, ${payments96plus});
    buildArChart('chart-ar', ${arGroupLabels}, ${arUnitDatasets});

    /* ── Expense category doughnut ── */
    function buildExpenseCatDoughnut(canvasId, labels, amounts, colors) {
      var el = document.getElementById(canvasId);
      if (!el) return;
      new Chart(el, {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{
            data: amounts,
            backgroundColor: colors,
            borderColor: '#fff',
            borderWidth: 2
          }]
        },
        options: {
          responsive: false,
          animation:  false,
          plugins: {
            legend: {
              display: true,
              position: 'bottom',
              labels: { font: { size: 10 }, padding: 10, boxWidth: 12 }
            },
            tooltip: {
              callbacks: {
                label: function (item) {
                  return item.label + ': $' + item.parsed.toLocaleString('en-US', {
                    minimumFractionDigits: 2, maximumFractionDigits: 2
                  });
                }
              }
            }
          }
        }
      });
    }

    buildExpenseCatDoughnut('chart-expense-cat', ${expCatLabels}, ${expCatAmounts}, ${expCatColors});

    /* ── AR by-group doughnut (Análisis de CxC page) ── */
    buildExpenseCatDoughnut('chart-ar-donut', ${arGroupDoughnutLabels}, ${arGroupDoughnutAmounts}, ${arGroupDoughnutColors});

    /* ── AP by-aging doughnut (Análisis de CxP page) ── */
    buildExpenseCatDoughnut('chart-ap-donut', ${apDoughnutLabels}, ${apDoughnutAmounts}, ${apDoughnutColors});

    /* ── Daily bank-balance line chart (Flujo de Efectivo page) ── */
    function buildCfLineChart(canvasId, dates, balance) {
      var el = document.getElementById(canvasId);
      if (!el) return;
      new Chart(el, {
        type: 'line',
        data: {
          labels: dates,
          datasets: [
            {
              label: 'Balance en Banco',
              data: balance,
              borderColor: '#2563eb',
              backgroundColor: 'rgba(37,99,235,0.08)',
              borderWidth: 2,
              pointRadius: 0,
              fill: true,
              tension: 0.3
            }
          ]
        },
        options: {
          responsive: false,
          animation:  false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: function (item) {
                  return 'Balance: $' + item.parsed.y.toLocaleString('en-US', {
                    minimumFractionDigits: 2, maximumFractionDigits: 2
                  });
                }
              }
            }
          },
          scales: {
            x: {
              ticks: {
                autoSkip: false,
                maxRotation: 90,
                minRotation: 90,
                font: { size: 9 }
              }
            },
            y: {
              ticks: {
                callback: function (v) {
                  return '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
                }
              }
            }
          }
        }
      });
    }

    buildCfLineChart('chart-cf-daily', ${cfDailyDates}, ${cfDailyBalance});

    window.chartsReady = true;
  }());
  </script>

</body>
</html>`;
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
}

export default HoaReportGenerator;
