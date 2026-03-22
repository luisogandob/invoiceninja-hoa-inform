import puppeteer, { type Browser } from 'puppeteer';
import { format } from 'date-fns';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
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
    const html = this.buildHtml(data);
    const browser = await this.getBrowser();

    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      // Wait for Chart.js to finish rendering all canvases
      await page.waitForFunction('window.chartsReady === true', { timeout: CHART_RENDER_TIMEOUT_MS });

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

    const fmt = (n: number) =>
      n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // JSON-serialised data for bar charts (safe string escaping via JSON.stringify)
    const paymentsLabels = JSON.stringify(paymentsByGroup.map(p => p.groupName));
    const paymentsValues = JSON.stringify(paymentsByGroup.map(p => p.total));
    const arLabels       = JSON.stringify(arByGroup.map(a => a.groupName));
    const arValues       = JSON.stringify(arByGroup.map(a => a.balance));

    // Warn early (server-side) when the scheme string looks invalid so users
    // notice the issue in the logs rather than silently getting the fallback.
    const [schemeGroup, schemeKey] = this.colorScheme.split('.');
    if (!schemeGroup || !schemeKey) {
      console.warn(
        `[HoaReportGenerator] CHART_COLOR_SCHEME "${this.colorScheme}" is not in the expected ` +
        `"group.SchemeName" format (e.g. "brewer.Paired12"). Using fallback palette.`
      );
    }

    // Resolve the palette server-side and embed it as JSON in the page.
    const colorData = getColorData();
    const resolvedPalette =
      (schemeGroup && schemeKey && colorData[schemeGroup]?.[schemeKey]) ||
      (console.warn(
        `[HoaReportGenerator] CHART_COLOR_SCHEME "${this.colorScheme}" not found in colorschemes data. Using fallback palette.`
      ),
      ['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#2980b9']);
    const paletteJson = JSON.stringify(resolvedPalette);

    /** Render a single KPI card as a colored HTML div. */
    const kpiCard = (lines: string[], value: string, colorIndex: number): string => {
      const bg = resolvedPalette[colorIndex % resolvedPalette.length];
      const linesHtml = lines
        .map(l => `<div class="kpi-label">${this.esc(l)}</div>`)
        .join('');
      return `
    <div class="kpi-stat" style="background:${bg};">
      ${linesHtml}
      <div class="kpi-value">${this.esc(value)}</div>
    </div>`;
    };

    // KPI card definitions: [label lines, formatted value, palette index]
    const kpiCards: Array<[string[], string, number]> = [
      [['Cuotas Emitidas', 'en el Período'],       `$${fmt(totalInvoicedInPeriod)}`,  0],
      [['Pagos Recibidos', 'en el Período'],        `$${fmt(totalPaymentsInPeriod)}`,  1],
      [['Cuentas x Cobrar', 'Inicio del Período'],  `$${fmt(arAtPeriodStart)}`,        2],
      [['Cuentas x Cobrar', 'Final del Período'],   `$${fmt(arAtPeriodEnd)}`,          3],
      [['Gastos', 'del Período'],                   `$${fmt(totalExpensesInPeriod)}`,  4],
    ];

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
    .report-header h1 { font-size: 26px; color: #2c3e50; margin-bottom: 8px; }
    .report-header .meta { font-size: 13px; color: #7f8c8d; margin-top: 4px; }

    /* ── KPI grid ── */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      margin-bottom: 16px;
    }
    .kpi-single { display: flex; justify-content: center; margin-bottom: 40px; }
    .kpi-single .kpi-stat { width: calc(50% - 8px); }

    /* ── KPI stat card ── */
    .kpi-stat {
      border-radius: 10px;
      padding: 22px 20px 18px;
      text-align: center;
      color: #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,.15);
    }
    .kpi-label {
      font-size: 11px;
      font-weight: bold;
      letter-spacing: .5px;
      text-transform: uppercase;
      opacity: .88;
      line-height: 1.4;
    }
    .kpi-value {
      font-size: 28px;
      font-weight: bold;
      margin-top: 10px;
      letter-spacing: -.5px;
    }

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
    .chart-section canvas { display: block; margin: 0 auto; }

    /* ── No data ── */
    .no-data { color: #95a5a6; font-size: 13px; text-align: center; padding: 24px 0; }
  </style>
</head>
<body>

  <!-- ── Header ── -->
  <div class="report-header">
    <h1>${this.esc(title)}</h1>
    <div class="meta">Período: ${this.esc(periodStart)} — ${this.esc(periodEnd)}</div>
    <div class="meta">Elaborado el: ${format(generatedAt, 'dd/MM/yyyy HH:mm')}</div>
  </div>

  <!-- ── KPI big numbers (2×2 grid) ── -->
  <div class="kpi-grid">
    ${kpiCard(...kpiCards[0])}
    ${kpiCard(...kpiCards[1])}
    ${kpiCard(...kpiCards[2])}
    ${kpiCard(...kpiCards[3])}
  </div>

  <!-- ── KPI: Gastos (centered) ── -->
  <div class="kpi-single">
    ${kpiCard(...kpiCards[4])}
  </div>

  <!-- ── Bar Chart: Payments by Client Group ── -->
  <div class="chart-section">
    <div class="section-title">Pagos Recibidos en el Período por Grupo de Clientes</div>
    ${paymentsByGroup.length > 0
      ? '<canvas id="chart-payments" width="680" height="300"></canvas>'
      : '<p class="no-data">Sin datos para este período.</p>'}
  </div>

  <!-- ── Bar Chart: AR by Client Group ── -->
  <div class="chart-section">
    <div class="section-title">Cuentas x Cobrar al Final del Período por Grupo de Clientes</div>
    ${arByGroup.length > 0
      ? '<canvas id="chart-ar" width="680" height="300"></canvas>'
      : '<p class="no-data">Sin datos para este período.</p>'}
  </div>

  <!-- ── Chart.js (inlined) ── -->
  <script>${getChartJs()}</script>
  <script>
  (function () {
    'use strict';

    /* ── Color palette resolved server-side from chartjs-plugin-colorschemes ── */
    var palette = ${paletteJson};

    function getColor(i) { return palette[i % palette.length]; }

    /* ── Bar chart helper ── */
    function buildBarChart(canvasId, labels, values) {
      var el = document.getElementById(canvasId);
      if (!el) return;
      new Chart(el, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            data: values,
            backgroundColor: values.map(function (_, i) { return getColor(i); }),
            borderWidth: 0
          }]
        },
        options: {
          responsive: false,
          animation:  false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: function (item) {
                  return '$' + item.parsed.y.toLocaleString('en-US', {
                    minimumFractionDigits: 2, maximumFractionDigits: 2
                  });
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                callback: function (v) {
                  return '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
                }
              }
            },
            x: {
              ticks: { autoSkip: false, maxRotation: 35, minRotation: 0 }
            }
          }
        }
      });
    }

    buildBarChart('chart-payments', ${paymentsLabels}, ${paymentsValues});
    buildBarChart('chart-ar',       ${arLabels},       ${arValues});

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
