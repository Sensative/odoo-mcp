import * as z from 'zod';

import type { Config } from './config.ts';

export type JsonObject = Readonly<Record<string, unknown>>;

export class OdooError extends Error {
  override readonly name = 'OdooError';
  readonly status: number | undefined;
  readonly odooName: string | undefined;

  constructor(message: string, details: { status?: number; odooName?: string | undefined; cause?: unknown } = {}) {
    super(message, { cause: details.cause });
    this.status = details.status;
    this.odooName = details.odooName;
  }
}

export interface OdooClient {
  call(model: string, method: string, body?: JsonObject, signal?: AbortSignal): Promise<unknown>;
  version(signal?: AbortSignal): Promise<unknown>;
  modelDoc(model: string, signal?: AbortSignal): Promise<unknown>;
}

export interface OdooClientOptions {
  readonly fetch?: typeof fetch;
  readonly userAgent?: string;
}

const MISSING_KEY =
  'ODOO_API_KEY is not set. Create a key in Odoo (your avatar → My Profile → Account Security → New API Key) ' +
  'and hand it to this server in the ODOO_API_KEY environment variable.';
const KEY_HINT =
  'Check ODOO_API_KEY: keys are created in Odoo under My Profile → Account Security → New API Key, and they expire.';
const NAMED_ARGUMENTS_HINT =
  'The JSON-2 API only takes named arguments; list_methods shows the parameter names of a method.';
const ARGUMENT_BINDING_ERROR = 'werkzeug.exceptions.UnprocessableEntity';

const ErrorBody = z.object({ name: z.string().optional(), message: z.string() });

interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

type ParsedJson = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function parseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function lastSegment(dottedName: string | undefined): string {
  const segment = dottedName?.split('.').at(-1);
  return segment === undefined || segment === '' ? '' : ` ${segment}`;
}

function withHint(message: string, hint: string): string {
  if (hint === '') return message;
  return `${message}${/[.!?]$/.test(message) ? '' : '.'} ${hint}`;
}

function hintFor(status: number, odooName: string | undefined): string {
  if (status === 401) return KEY_HINT;
  if (odooName === ARGUMENT_BINDING_ERROR) return NAMED_ARGUMENTS_HINT;
  return '';
}

function summarize(text: string): string {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1];
  return (title ?? text).replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Odoo's error bodies also carry a `debug` traceback with server paths; only
// the exception name and message are ever taken out of them.
function failure(reply: Reply, parsed: ParsedJson): OdooError {
  const body = parsed.ok ? ErrorBody.safeParse(parsed.value) : undefined;
  if (body?.success !== true) {
    return new OdooError(`Odoo ${reply.status}: ${summarize(reply.text)}`, { status: reply.status });
  }
  const { name, message } = body.data;
  return new OdooError(`Odoo ${reply.status}${lastSegment(name)}: ${withHint(message, hintFor(reply.status, name))}`, {
    status: reply.status,
    odooName: name,
  });
}

function describeCause(error: unknown): string {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  if (!(cause instanceof Error)) return String(cause);
  const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : '';
  return cause.message || code || cause.name;
}

export function createOdooClient(config: Config, options: OdooClientOptions = {}): OdooClient {
  const fetchFn = options.fetch ?? fetch;
  const commonHeaders = { Accept: 'application/json', 'User-Agent': options.userAgent ?? 'odoo-mcp' };
  const docCache = new Map<string, { readonly etag: string; readonly doc: unknown }>();

  function authorizedHeaders(): Record<string, string> {
    if (config.apiKey === undefined) throw new OdooError(MISSING_KEY);
    return {
      ...commonHeaders,
      Authorization: `bearer ${config.apiKey}`,
      ...(config.database === undefined ? {} : { 'X-Odoo-Database': config.database }),
    };
  }

  async function exchange(path: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Reply> {
    const timeout = AbortSignal.timeout(config.timeoutMs);
    try {
      // redirect: 'manual' keeps the API key from following a redirect to another address.
      const response = await fetchFn(`${config.baseUrl}${path}`, {
        ...init,
        redirect: 'manual',
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
      return { status: response.status, headers: response.headers, text: await response.text() };
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (timeout.aborted) {
        throw new OdooError(`Odoo did not answer within ${config.timeoutMs} ms (${config.baseUrl}).`, { cause: error });
      }
      throw new OdooError(`Cannot reach Odoo at ${config.baseUrl}: ${describeCause(error)}`, { cause: error });
    }
  }

  function interpret(reply: Reply): unknown {
    if (reply.status >= 300 && reply.status < 400) {
      const target = reply.headers.get('location') ?? 'an unnamed address';
      throw new OdooError(
        `Odoo answered with a redirect to ${target}. ODOO_URL (${config.baseUrl}) must be the root address ` +
          'of the Odoo instance, the part before /odoo or /web.',
        { status: reply.status },
      );
    }
    const parsed = parseJson(reply.text);
    if (reply.status >= 400) throw failure(reply, parsed);
    if (!parsed.ok) {
      throw new OdooError(
        `Odoo answered HTTP ${reply.status} with something that is not JSON. Check that ODOO_URL ` +
          `(${config.baseUrl}) is the root address of an Odoo 19+ instance.`,
        { status: reply.status },
      );
    }
    return parsed.value;
  }

  return {
    async call(model, method, body = {}, signal) {
      const path = `/json/2/${encodeURIComponent(model)}/${encodeURIComponent(method)}`;
      const headers = { ...authorizedHeaders(), 'Content-Type': 'application/json; charset=utf-8' };
      return interpret(await exchange(path, { method: 'POST', headers, body: JSON.stringify(body) }, signal));
    },

    async version(signal) {
      return interpret(await exchange('/web/version', { method: 'GET', headers: commonHeaders }, signal));
    },

    async modelDoc(model, signal) {
      const cached = docCache.get(model);
      const headers = { ...authorizedHeaders(), ...(cached === undefined ? {} : { 'If-None-Match': cached.etag }) };
      const reply = await exchange(`/doc-bearer/${encodeURIComponent(model)}.json`, { method: 'GET', headers }, signal);
      if (reply.status === 304 && cached !== undefined) return cached.doc;
      const doc = interpret(reply);
      const etag = reply.headers.get('etag');
      if (etag !== null) docCache.set(model, { etag, doc });
      return doc;
    },
  };
}
