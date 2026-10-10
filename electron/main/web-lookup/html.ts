/** Plain text from untrusted HTML, without running or loading anything. */

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', reg: '®', times: '×' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED[entity.toLowerCase()] ?? match;
  });
}

/** Inline HTML (a search snippet) as one line of text. */
export function inlineText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

const DROP = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'canvas', 'form', 'nav', 'header', 'footer', 'aside', 'button', 'select'];
const BLOCK = /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|table|thead|tbody|section|article|main|blockquote|pre|dd|dt|dl|figcaption|hr)\b[^>]*>/gi;

function region(html: string, tag: string): string | undefined {
  const start = html.search(new RegExp(`<${tag}\\b`, 'i'));
  if (start < 0) return undefined;
  const end = html.toLowerCase().lastIndexOf(`</${tag}>`);
  return end > start ? html.slice(start, end) : undefined;
}

/** The page title, from <title>. */
export function htmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? inlineText(match[1]).slice(0, 300) : '';
}

/** The page's own summary (description or og:description), for pages whose content is drawn by scripts. */
export function htmlDescription(html: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\b(?:name|property)\s*=\s*["'](?:description|og:description)["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    const text = content ? inlineText(content[1] ?? content[2] ?? '') : '';
    if (text) return text;
  }
  return '';
}

/**
 * The readable text of a page: scripts, styles, navigation, forms and edit links removed; the
 * <main> or <article> region when there is one; block elements on their own lines.
 */
export function htmlToText(html: string): string {
  let body = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of DROP) body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  // MediaWiki: edit links and reference markers carry no content.
  body = body.replace(/<span class="mw-editsection"[\s\S]*?<\/span>\s*<\/span>/gi, '').replace(/<sup[^>]*class="[^"]*reference[^"]*"[\s\S]*?<\/sup>/gi, '');
  body = region(body, 'main') ?? region(body, 'article') ?? region(body, 'body') ?? body;
  const text = decodeEntities(body.replace(BLOCK, '\n').replace(/<[^>]*>/g, ''));
  return text.split('\n').map(line => line.replace(/[ \t 　]+/g, ' ').trim()).filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n');
}
