import fs from 'fs';
import path from 'path';
import type { CompanyInfo } from './hoaReportData.js';
import { fetchLogoAsDataUri } from './logoUtils.js';

/**
 * Data required to render the report email body.
 */
export interface ReportEmailData {
  /** Company / HOA branding info */
  companyInfo?: CompanyInfo;
  /** Report title (e.g. "Informe HOA") */
  reportTitle: string;
  /** Human-readable period string (e.g. "marzo 2026") */
  periodString: string;
}

/**
 * Escape a string for safe use inside HTML text nodes or attribute values.
 */
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Load the email template HTML from EMAIL_TEMPLATE_PATH (default: ./email-template.html).
 *
 * Falls back to a minimal built-in template when the file is missing and no
 * explicit path was configured.
 */
function loadTemplateSource(): string {
  const envPath = process.env.EMAIL_TEMPLATE_PATH;
  const templatePath = envPath || './email-template.html';
  const resolved = path.resolve(templatePath);
  const cwd = path.resolve('.');

  if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
    console.warn(`[emailTemplate] EMAIL_TEMPLATE_PATH outside working directory. Ignoring: "${templatePath}"`);
    return builtInTemplate();
  }

  if (!fs.existsSync(resolved)) {
    if (envPath) {
      console.warn(`[emailTemplate] EMAIL_TEMPLATE_PATH file not found: "${templatePath}". Using built-in template.`);
    }
    return builtInTemplate();
  }

  try {
    return fs.readFileSync(resolved, 'utf-8');
  } catch (err) {
    console.warn(`[emailTemplate] Could not read template file "${templatePath}":`, (err as Error).message);
    return builtInTemplate();
  }
}

/**
 * Minimal built-in template used when the external file is unavailable.
 * Supports the same {{TOKEN}} placeholders.
 */
function builtInTemplate(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{{REPORT_TITLE}}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#1e3a5f;padding:28px 32px;text-align:center;">
              {{LOGO_HTML}}
              {{COMPANY_NAME_HTML}}
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h2 style="margin:0 0 10px 0;font-size:20px;color:#111827;">{{REPORT_TITLE}}</h2>
              <p style="margin:0 0 20px 0;font-size:15px;color:#374151;">Período: <strong>{{PERIOD_STRING}}</strong></p>
              <p style="margin:0 0 12px 0;font-size:14px;color:#374151;line-height:1.7;">Estimado/a residente,</p>
              <p style="margin:0 0 12px 0;font-size:14px;color:#374151;line-height:1.7;">Le informamos que el informe financiero de la comunidad correspondiente al período <strong>{{PERIOD_STRING}}</strong> ya está disponible.</p>
              <p style="margin:0 0 24px 0;font-size:14px;color:#374151;line-height:1.7;">Encontrará el informe completo en formato PDF adjunto a este correo. Le invitamos a revisarlo y no dude en contactarnos ante cualquier consulta.</p>
              {{CONTACT_BLOCK}}
            </td>
          </tr>
          <tr>
            <td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0;font-size:11px;color:#9ca3af;">{{COMPANY_NAME}}</p>
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
 * Build the HTML body of the financial-report email.
 *
 * The template is loaded from EMAIL_TEMPLATE_PATH (defaults to
 * ./email-template.html).  The following {{TOKEN}} placeholders are replaced:
 *
 *   {{REPORT_TITLE}}      — HTML-escaped report title
 *   {{PERIOD_STRING}}     — HTML-escaped period string
 *   {{COMPANY_NAME}}      — HTML-escaped company name (or empty string)
 *   {{COMPANY_NAME_HTML}} — <h1> tag with company name, or empty string
 *   {{LOGO_HTML}}         — <img> tag with base64 logo URI, or empty string
 *   {{CONTACT_BLOCK}}     — <table> with address/phone/email/website/RNC rows,
 *                           or empty string when no contact info is available
 */
export async function buildReportEmailHtml(data: ReportEmailData): Promise<string> {
  const { companyInfo, reportTitle, periodString } = data;

  // Fetch logo as a data URI if available
  let logoDataUri: string | undefined;
  if (companyInfo?.logoUrl) {
    logoDataUri = await fetchLogoAsDataUri(companyInfo.logoUrl);
  }

  const companyName = companyInfo?.name ? escHtml(companyInfo.name) : '';

  const logoHtml = logoDataUri
    ? `<img src="${logoDataUri}" alt="${companyName}" style="max-height:80px;max-width:220px;margin-bottom:${companyName ? '12px' : '0'};display:block;margin-left:auto;margin-right:auto;">`
    : '';

  const companyNameHtml = companyName
    ? `<h1 style="margin:0;color:#ffffff;font-family:Arial,sans-serif;font-size:22px;font-weight:700;letter-spacing:0.5px;">${companyName}</h1>`
    : '';

  // Company contact info rows
  const contactRows: string[] = [];
  if (companyInfo?.address) {
    contactRows.push(`<tr><td style="color:#6b7280;padding:3px 0;font-size:13px;">📍 Dirección</td><td style="padding:3px 0 3px 16px;font-size:13px;">${escHtml(companyInfo.address)}</td></tr>`);
  }
  if (companyInfo?.phone) {
    contactRows.push(`<tr><td style="color:#6b7280;padding:3px 0;font-size:13px;">📞 Teléfono</td><td style="padding:3px 0 3px 16px;font-size:13px;">${escHtml(companyInfo.phone)}</td></tr>`);
  }
  if (companyInfo?.email) {
    contactRows.push(`<tr><td style="color:#6b7280;padding:3px 0;font-size:13px;">✉️ Email</td><td style="padding:3px 0 3px 16px;font-size:13px;"><a href="mailto:${escHtml(companyInfo.email)}" style="color:#1e3a5f;text-decoration:none;">${escHtml(companyInfo.email)}</a></td></tr>`);
  }
  if (companyInfo?.website) {
    contactRows.push(`<tr><td style="color:#6b7280;padding:3px 0;font-size:13px;">🌐 Web</td><td style="padding:3px 0 3px 16px;font-size:13px;"><a href="${escHtml(companyInfo.website)}" style="color:#1e3a5f;text-decoration:none;">${escHtml(companyInfo.website)}</a></td></tr>`);
  }
  if (companyInfo?.rnc) {
    contactRows.push(`<tr><td style="color:#6b7280;padding:3px 0;font-size:13px;">🪪 RNC</td><td style="padding:3px 0 3px 16px;font-size:13px;">${escHtml(companyInfo.rnc)}</td></tr>`);
  }

  const contactBlock = contactRows.length > 0
    ? `<table style="border-collapse:collapse;margin-top:16px;">${contactRows.join('')}</table>`
    : '';

  const tokens: Record<string, string> = {
    REPORT_TITLE:      escHtml(reportTitle),
    PERIOD_STRING:     escHtml(periodString),
    COMPANY_NAME:      companyName,
    COMPANY_NAME_HTML: companyNameHtml,
    LOGO_HTML:         logoHtml,
    CONTACT_BLOCK:     contactBlock,
  };

  const source = loadTemplateSource();
  return source.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => tokens[key] ?? '');
}
