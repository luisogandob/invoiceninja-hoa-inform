import axios from 'axios';
import { existsSync, readFileSync } from 'fs';

const ALLOWED_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp'
]);

const ALLOWED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']);

const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp'
};

/**
 * Fetch a logo from a URL, local file path, or data URI and return it as a
 * base64-encoded `data:` URI suitable for embedding in HTML.
 *
 * Returns `undefined` if the logo cannot be loaded or has a disallowed type.
 */
export async function fetchLogoAsDataUri(url: string): Promise<string | undefined> {
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
        console.warn(`[logoUtils] Rejected logo path with disallowed extension: "${url}"`);
        return undefined;
      }
      const buf = readFileSync(url);
      const mime = MIME_MAP[ext] ?? 'image/png';
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
        console.warn(`[logoUtils] Rejected logo URL with disallowed content-type "${mime}": "${url}"`);
        return undefined;
      }
      const base64 = Buffer.from(response.data).toString('base64');
      return `data:${mime};base64,${base64}`;
    }
  } catch (err) {
    console.warn(`[logoUtils] Could not load logo from "${url}":`, (err as Error).message);
  }
  return undefined;
}
