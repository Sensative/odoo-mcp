export const DEFAULT_ODOO_URL = 'https://sensative.implefy.cloud';

const DEFAULT_TIMEOUT_MS = 30_000;
// Hosts cap what one tool answer may hold (Claude Code: 25 000 tokens); 40 000 characters of JSON stays well below.
const DEFAULT_MAX_RESPONSE_CHARS = 40_000;
const MIN_MAX_RESPONSE_CHARS = 1000;

export interface Config {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly database: string | undefined;
  readonly readOnly: boolean;
  readonly timeoutMs: number;
  readonly maxResponseChars: number;
}

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const ON_WORDS = new Set(['1', 'true', 'yes', 'on']);
const OFF_WORDS = new Set(['', '0', 'false', 'no', 'off']);

// MCP hosts hand over "${NAME}" untouched when the variable a config file refers to is not set.
const UNEXPANDED_REFERENCE = /^\$\{[^}]*\}$/;

function readText(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' || UNEXPANDED_REFERENCE.test(value) ? undefined : value;
}

function readFlag(env: Env, name: string): boolean {
  const word = (env[name] ?? '').trim().toLowerCase();
  if (ON_WORDS.has(word)) return true;
  if (OFF_WORDS.has(word)) return false;
  throw new ConfigError(`${name} must be one of 1/true/yes/on or 0/false/no/off, got "${env[name]}"`);
}

function readInteger(env: Env, name: string, fallback: number, minimum: number): number {
  const text = readText(env, name);
  if (text === undefined) return fallback;
  if (!/^\d+$/.test(text) || Number(text) < minimum) {
    throw new ConfigError(`${name} must be a whole number of at least ${minimum}, got "${text}"`);
  }
  return Number(text);
}

function parseUrl(text: string): URL {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    return new URL(withScheme);
  } catch {
    throw new ConfigError(`ODOO_URL is not a valid URL: "${text}"`);
  }
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

// People paste the address from the browser, which ends in the web client's
// own route (/odoo/action-123, /web/login); the API lives beside it, not below.
const WEB_CLIENT_SEGMENTS = new Set(['odoo', 'web']);

function pathBeforeWebClient(pathname: string): string {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  const webClientAt = segments.findIndex((segment) => WEB_CLIENT_SEGMENTS.has(segment));
  const kept = webClientAt === -1 ? segments : segments.slice(0, webClientAt);
  return kept.map((segment) => `/${segment}`).join('');
}

function normalizeBaseUrl(text: string, allowInsecureHttp: boolean): string {
  const url = parseUrl(text);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`ODOO_URL must be an http(s) address, got "${text}"`);
  }
  if (url.protocol === 'http:' && !allowInsecureHttp && !isLoopback(url.hostname)) {
    throw new ConfigError(
      `ODOO_URL "${text}" would send the API key unencrypted. Use https, ` +
        'or set ODOO_ALLOW_INSECURE_HTTP=1 if the network between this server and Odoo is trusted.',
    );
  }
  return `${url.origin}${pathBeforeWebClient(url.pathname)}`;
}

export function loadConfig(env: Env): Config {
  return {
    baseUrl: normalizeBaseUrl(readText(env, 'ODOO_URL') ?? DEFAULT_ODOO_URL, readFlag(env, 'ODOO_ALLOW_INSECURE_HTTP')),
    apiKey: readText(env, 'ODOO_API_KEY'),
    database: readText(env, 'ODOO_DB'),
    readOnly: readFlag(env, 'ODOO_READONLY'),
    timeoutMs: readInteger(env, 'ODOO_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1),
    maxResponseChars: readInteger(env, 'ODOO_MAX_RESPONSE_CHARS', DEFAULT_MAX_RESPONSE_CHARS, MIN_MAX_RESPONSE_CHARS),
  };
}
