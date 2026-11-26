import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_API_KEY = 'test-api-key';
export const TRACEBACK_MARKER = 'SECRET_TRACEBACK /var/odoo/src/odoo/http.py';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: unknown;
}

export class FakeOdooFault extends Error {
  readonly status: number;
  readonly odooName: string;

  constructor(status: number, odooName: string, message: string) {
    super(message);
    this.status = status;
    this.odooName = odooName;
  }
}

export type FakeMethod = (body: Record<string, unknown>) => unknown;

export interface FakeDoc {
  readonly etag?: string;
  readonly body: unknown;
}
export type RawRoute = (request: IncomingMessage, response: ServerResponse) => void;

export interface FakeOdooOptions {
  readonly methods?: Readonly<Record<string, FakeMethod>>;
  readonly docs?: Readonly<Record<string, FakeDoc | FakeOdooFault>>;
  readonly rawRoutes?: Readonly<Record<string, RawRoute>>;
}

export interface FakeOdoo {
  readonly url: string;
  readonly requests: RecordedRequest[];
  lastRequest(): RecordedRequest;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

function sendFault(response: ServerResponse, fault: FakeOdooFault): void {
  sendJson(response, fault.status, {
    name: fault.odooName,
    message: fault.message,
    arguments: [fault.message, fault.status],
    context: {},
    debug: `Traceback (most recent call last):\n  File "${TRACEBACK_MARKER}", line 2409, in _serve_db\n`,
  });
}

function authenticate(request: IncomingMessage): void {
  const token = /^bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1];
  if (token === undefined) {
    throw new FakeOdooFault(
      401,
      'werkzeug.exceptions.Unauthorized',
      'User not authenticated, use an API Key with a Bearer Authorization header.',
    );
  }
  if (token !== FAKE_API_KEY) throw new FakeOdooFault(401, 'werkzeug.exceptions.Unauthorized', 'Invalid apikey');
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export async function startFakeOdoo(options: FakeOdooOptions = {}): Promise<FakeOdoo> {
  const methods = options.methods ?? {};
  const docs = options.docs ?? {};
  const rawRoutes = options.rawRoutes ?? {};
  const knownModels = new Set(Object.keys(methods).map((key) => key.split('/')[0]));
  const requests: RecordedRequest[] = [];

  function callMethod(request: IncomingMessage, path: string, body: unknown): unknown {
    authenticate(request);
    const [model = '', method = ''] = path.slice('/json/2/'.length).split('/').map(decodeURIComponent);
    if (!knownModels.has(model)) {
      throw new FakeOdooFault(404, 'werkzeug.exceptions.NotFound', `the model '${model}' does not exist`);
    }
    const handler = methods[`${model}/${method}`];
    if (handler === undefined) {
      throw new FakeOdooFault(404, 'werkzeug.exceptions.NotFound', `The method '${model}.${method}' does not exist`);
    }
    return handler(asRecord(body));
  }

  function serveDoc(request: IncomingMessage, response: ServerResponse, path: string): void {
    authenticate(request);
    const model = decodeURIComponent(path.slice('/doc-bearer/'.length, -'.json'.length));
    const doc = docs[model];
    if (doc === undefined) throw new FakeOdooFault(404, 'werkzeug.exceptions.NotFound', 'Not Found');
    if (doc instanceof FakeOdooFault) throw doc;
    if (doc.etag !== undefined && request.headers['if-none-match'] === doc.etag) {
      response.writeHead(304).end();
      return;
    }
    sendJson(response, 200, doc.body, doc.etag === undefined ? {} : { ETag: doc.etag });
  }

  function route(request: IncomingMessage, response: ServerResponse, path: string, body: unknown): void {
    const raw = rawRoutes[path];
    if (raw !== undefined) return raw(request, response);
    if (path === '/web/version') return sendJson(response, 200, { version_info: [19, 0, 0, 'final', 0, 'e'], version: '19.0+e' });
    if (path.startsWith('/doc-bearer/')) return serveDoc(request, response, path);
    if (path.startsWith('/json/2/') && request.method === 'POST') return sendJson(response, 200, callMethod(request, path, body));
    throw new FakeOdooFault(404, 'werkzeug.exceptions.NotFound', 'Did you mean POST /json/2/<model>/<method>?');
  }

  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://fake').pathname;
      const body = await readBody(request);
      requests.push({ method: request.method ?? '', path, headers: request.headers, body });
      try {
        route(request, response, path, body);
      } catch (error) {
        if (!(error instanceof FakeOdooFault)) throw error;
        sendFault(response, error);
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    lastRequest() {
      const last = requests.at(-1);
      if (last === undefined) throw new Error('the fake Odoo has not received any request');
      return last;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
