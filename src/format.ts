export interface Page {
  readonly offset: number;
  readonly limit: number;
}

type Brackets = readonly [open: string, close: string];

const ARRAY: Brackets = ['[', ']'];
const OBJECT: Brackets = ['{', '}'];

// Room kept free for the envelope around the entries: key, counters and the truncation note.
const ENVELOPE_RESERVE = 400;

function countFitting(lines: readonly string[], budget: number): number {
  let used = 0;
  let count = 0;
  for (const line of lines) {
    used += line.length + 2;
    if (used > budget) break;
    count += 1;
  }
  return count;
}

function envelope(key: string, [open, close]: Brackets, lines: readonly string[], counters: Readonly<Record<string, unknown>>): string {
  const body = lines.length === 0 ? `${open}${close}` : `${open}\n${lines.join(',\n')}\n${close}`;
  return `{${JSON.stringify(key)}:${body},${JSON.stringify(counters).slice(1)}`;
}

function pageNote(key: string, included: number, fetched: number, maxChars: number): string {
  if (included === 0) {
    return `The first of the fetched ${key} alone exceeds the ${maxChars}-character response cap. Ask for fewer fields.`;
  }
  return (
    `Only ${included} of the ${fetched} fetched ${key} fit the ${maxChars}-character response cap. ` +
    'Ask for fewer fields, or continue from next_offset.'
  );
}

// `rows` may hold one row more than `page.limit`: callers fetch limit + 1 so
// that "are there more?" is answered without a second, separately committed query.
export function renderPage(key: string, rows: readonly unknown[], page: Page, maxChars: number): string {
  const lines = rows.slice(0, page.limit).map((row) => JSON.stringify(row));
  const included = countFitting(lines, maxChars - ENVELOPE_RESERVE);
  const cutShort = included < lines.length;
  const hasMore = cutShort || rows.length > page.limit;
  return envelope(key, ARRAY, lines.slice(0, included), {
    returned: included,
    offset: page.offset,
    has_more: hasMore,
    ...(hasMore ? { next_offset: page.offset + included } : {}),
    ...(cutShort ? { truncated: pageNote(key, included, lines.length, maxChars) } : {}),
  });
}

function renderWhole(key: string, brackets: Brackets, lines: readonly string[], maxChars: number, howToNarrow: string): string {
  const included = countFitting(lines, maxChars - ENVELOPE_RESERVE);
  const note = `Only ${included} of ${lines.length} ${key} fit the ${maxChars}-character response cap. ${howToNarrow}`;
  return envelope(key, brackets, lines.slice(0, included), {
    returned: included,
    total: lines.length,
    ...(included < lines.length ? { truncated: note } : {}),
  });
}

export function renderList(key: string, items: readonly unknown[], maxChars: number, howToNarrow: string): string {
  return renderWhole(key, ARRAY, items.map((item) => JSON.stringify(item)), maxChars, howToNarrow);
}

export function renderMap(key: string, entries: Readonly<Record<string, unknown>>, maxChars: number, howToNarrow: string): string {
  const lines = Object.entries(entries).map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`);
  return renderWhole(key, OBJECT, lines, maxChars, howToNarrow);
}

export function renderJson(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value) ?? 'null';
  if (text.length <= maxChars) return text;
  return (
    `${text.slice(0, maxChars - ENVELOPE_RESERVE)}\n` +
    `… [truncated: the result is ${text.length} characters and the cap is ${maxChars} (ODOO_MAX_RESPONSE_CHARS). ` +
    'The call itself completed; ask for less data to see all of it.]'
  );
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntity(entity: string, body: string): string {
  if (body.startsWith('#')) {
    const codePoint = /^#x/i.test(body) ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return Number.isNaN(codePoint) || codePoint > 0x10ffff ? entity : String.fromCodePoint(codePoint);
  }
  return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function flowText(html: string): string {
  const structured = html
    .replace(/\s+/g, ' ')
    .replace(/<\/(?:p|div|h[1-6]|blockquote|table|dl)>/gi, '\n\n')
    .replace(/<br\s*\/?>|<\/(?:li|ul|ol|dt|dd|tr)>/gi, '\n');
  return stripTags(structured)
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/^[ \t]+|[ \t]+$/g, '');
}

// Odoo's /doc endpoints deliver docstrings rendered to HTML by docutils.
export function htmlToText(html: string): string {
  const preformatted = /(<pre\b[^>]*>[\s\S]*?<\/pre>)/i;
  return html
    .split(preformatted)
    .map((part, index) => (index % 2 === 1 ? `\n\n${stripTags(part)}\n\n` : flowText(part)))
    .join('')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
