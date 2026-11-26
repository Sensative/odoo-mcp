import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { Config } from '../src/config.ts';
import { createOdooClient, OdooError } from '../src/odoo-client.ts';
import { FAKE_API_KEY, FakeOdooFault, startFakeOdoo, TRACEBACK_MARKER, type FakeOdoo } from './fake-odoo.ts';

const PARTNERS = [{ id: 7, name: 'Sensative AB' }];
const PARTNER_DOC = { model: 'res.partner', methods: { name_search: { signature: "(name='')" } } };

function configFor(baseUrl: string, overrides: Partial<Config> = {}): Config {
  return {
    baseUrl,
    apiKey: FAKE_API_KEY,
    database: undefined,
    readOnly: false,
    timeoutMs: 5000,
    maxResponseChars: 100_000,
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<OdooError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof OdooError, `expected an OdooError, got ${String(error)}`);
    return error;
  }
  return assert.fail('expected the call to reject');
}

describe('OdooClient', () => {
  let fake: FakeOdoo;

  before(async () => {
    fake = await startFakeOdoo({
      methods: {
        'res.partner/search_read': () => PARTNERS,
        'res.partner/unlink': () => {
          throw new FakeOdooFault(403, 'odoo.exceptions.AccessError', 'You are not allowed to delete Contact records.');
        },
        'res.partner/search': () => {
          throw new FakeOdooFault(422, 'werkzeug.exceptions.UnprocessableEntity', "missing a required argument: 'domain'");
        },
        'res.partner/write': () => {
          throw new FakeOdooFault(422, 'odoo.exceptions.ValidationError', 'The email address is not valid.');
        },
      },
      docs: { 'res.partner': { etag: 'abc123', body: PARTNER_DOC }, 'res.users': { body: { model: 'res.users', methods: {} } } },
      rawRoutes: {
        '/json/2/res.partner/redirected': (_request, response) => {
          response.writeHead(303, { Location: '/web/login?redirect=%2Fodoo' }).end();
        },
        '/json/2/res.partner/html': (_request, response) => {
          response.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><title>Login</title></html>');
        },
        '/json/2/res.partner/bad_gateway': (_request, response) => {
          response.writeHead(502, { 'Content-Type': 'text/html' });
          response.end('<html>\n<head><title>502 Bad Gateway</title></head>\n<body><center>nginx</center></body></html>');
        },
        '/json/2/res.partner/plain_failure': (_request, response) => {
          response.writeHead(500, { 'Content-Type': 'text/plain' }).end('  upstream   exploded\n badly ');
        },
        '/json/2/res.partner/nameless_failure': (_request, response) => {
          response.writeHead(500, { 'Content-Type': 'application/json' }).end('{"message": "Something broke"}');
        },
        '/json/2/res.partner/odd_failure': (_request, response) => {
          response.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error": "x"}');
        },
        '/json/2/res.partner/lost_redirect': (_request, response) => {
          response.writeHead(302).end();
        },
        '/json/2/res.partner/hangs': () => {},
      },
    });
  });

  after(async () => {
    await fake.close();
  });

  it('posts named arguments to /json/2/<model>/<method> as the API key user', async () => {
    const odoo = createOdooClient(configFor(fake.url, { database: 'prod' }), { userAgent: 'odoo-mcp/test' });

    const result = await odoo.call('res.partner', 'search_read', { domain: [['is_company', '=', true]], limit: 1 });

    assert.deepEqual(result, PARTNERS);
    const request = fake.lastRequest();
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/json/2/res.partner/search_read');
    assert.deepEqual(request.body, { domain: [['is_company', '=', true]], limit: 1 });
    assert.equal(request.headers.authorization, `bearer ${FAKE_API_KEY}`);
    assert.equal(request.headers['x-odoo-database'], 'prod');
    assert.equal(request.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(request.headers['user-agent'], 'odoo-mcp/test');
    assert.equal(request.headers.cookie, undefined);
  });

  it('sends an empty object and no database header by default', async () => {
    const odoo = createOdooClient(configFor(fake.url));

    await odoo.call('res.partner', 'search_read');

    assert.deepEqual(fake.lastRequest().body, {});
    assert.equal(fake.lastRequest().headers['x-odoo-database'], undefined);
  });

  it('keeps model and method names inside their own path segment', async () => {
    const odoo = createOdooClient(configFor(fake.url));

    const error = await rejection(odoo.call('../../web/session', 'destroy?x=1'));

    assert.equal(fake.lastRequest().path, '/json/2/..%2F..%2Fweb%2Fsession/destroy%3Fx%3D1');
    assert.equal(error.status, 404);
  });

  it('refuses to call Odoo without an API key and says how to get one', async () => {
    const odoo = createOdooClient(configFor(fake.url, { apiKey: undefined }));
    const before = fake.requests.length;

    const error = await rejection(odoo.call('res.partner', 'search_read'));

    assert.equal(fake.requests.length, before);
    assert.equal(error.status, undefined);
    assert.match(error.message, /ODOO_API_KEY/);
    assert.match(error.message, /My Preferences → Security → Add API Key/);
  });

  it('reports a rejected API key with the way to fix it, and never the traceback', async () => {
    const odoo = createOdooClient(configFor(fake.url, { apiKey: 'wrong' }));

    const error = await rejection(odoo.call('res.partner', 'search_read'));

    assert.equal(error.status, 401);
    assert.equal(error.odooName, 'werkzeug.exceptions.Unauthorized');
    assert.match(error.message, /^Odoo 401 Unauthorized: Invalid apikey/);
    assert.match(error.message, /ODOO_API_KEY/);
    assert.match(error.message, /My Preferences → Security → Add API Key/);
    assert.ok(!error.message.includes(TRACEBACK_MARKER));
    assert.ok(!error.message.includes('Traceback'));
  });

  it('passes Odoo access errors through in Odoo’s own words', async () => {
    const odoo = createOdooClient(configFor(fake.url));

    const error = await rejection(odoo.call('res.partner', 'unlink', { ids: [7] }));

    assert.equal(error.status, 403);
    assert.equal(error.message, 'Odoo 403 AccessError: You are not allowed to delete Contact records.');
  });

  it('names the missing model', async () => {
    const odoo = createOdooClient(configFor(fake.url));

    const error = await rejection(odoo.call('res.parner', 'search_read'));

    assert.equal(error.message, "Odoo 404 NotFound: the model 'res.parner' does not exist");
  });

  it('explains named arguments when Odoo cannot bind them', async () => {
    const odoo = createOdooClient(configFor(fake.url));

    const error = await rejection(odoo.call('res.partner', 'search'));

    assert.equal(error.status, 422);
    assert.match(error.message, /^Odoo 422 UnprocessableEntity: missing a required argument: 'domain'/);
    assert.match(error.message, /named arguments/);
    assert.match(error.message, /list_methods/);
  });

  it('leaves business validation errors free of argument advice', async () => {
    const odoo = createOdooClient(configFor(fake.url));

    const error = await rejection(odoo.call('res.partner', 'write', { ids: [7], vals: { email: 'x' } }));

    assert.equal(error.message, 'Odoo 422 ValidationError: The email address is not valid.');
  });

  it('does not follow redirects, so the key never leaves the configured address', async () => {
    const odoo = createOdooClient(configFor(fake.url));

    const error = await rejection(odoo.call('res.partner', 'redirected'));

    assert.equal(fake.lastRequest().path, '/json/2/res.partner/redirected');
    assert.equal(error.status, 303);
    assert.match(error.message, /redirect/);
    assert.match(error.message, /\/web\/login/);
    assert.match(error.message, /ODOO_URL/);
  });

  it('rejects a successful answer that is not JSON', async () => {
    const odoo = createOdooClient(configFor(fake.url));

    const error = await rejection(odoo.call('res.partner', 'html'));

    assert.equal(error.status, 200);
    assert.match(error.message, /not JSON/);
    assert.match(error.message, /ODOO_URL/);
  });

  it('summarises a proxy error page by its title', async () => {
    const odoo = createOdooClient(configFor(fake.url));

    const error = await rejection(odoo.call('res.partner', 'bad_gateway'));

    assert.equal(error.message, 'Odoo 502: 502 Bad Gateway');
  });

  it('summarises a plain-text failure on one line', async () => {
    const odoo = createOdooClient(configFor(fake.url));

    const error = await rejection(odoo.call('res.partner', 'plain_failure'));

    assert.equal(error.message, 'Odoo 500: upstream exploded badly');
  });

  it('reports an error that carries no exception name', async () => {
    const odoo = createOdooClient(configFor(fake.url));

    const error = await rejection(odoo.call('res.partner', 'nameless_failure'));

    assert.equal(error.message, 'Odoo 500: Something broke');
    assert.equal(error.odooName, undefined);
  });

  it('shows an error body it does not recognise as it came', async () => {
    const odoo = createOdooClient(configFor(fake.url));

    const error = await rejection(odoo.call('res.partner', 'odd_failure'));

    assert.equal(error.message, 'Odoo 500: {"error": "x"}');
  });

  it('reports a redirect even when it names no target', async () => {
    const odoo = createOdooClient(configFor(fake.url));

    const error = await rejection(odoo.call('res.partner', 'lost_redirect'));

    assert.equal(error.status, 302);
    assert.match(error.message, /redirect to an unnamed address/);
  });

  it('names the network error code when the error has no message', async () => {
    const reset: typeof fetch = () =>
      Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error(''), { code: 'ECONNRESET' }) }));
    const odoo = createOdooClient(configFor('https://odoo.example'), { fetch: reset });

    const error = await rejection(odoo.call('res.partner', 'read'));

    assert.equal(error.message, 'Cannot reach Odoo at https://odoo.example: ECONNRESET');
  });

  it('copes with a failure that is not an Error', async () => {
    const hangUp: typeof fetch = () => Promise.reject('socket hang up');
    const odoo = createOdooClient(configFor('https://odoo.example'), { fetch: hangUp });

    const error = await rejection(odoo.call('res.partner', 'read'));

    assert.equal(error.message, 'Cannot reach Odoo at https://odoo.example: socket hang up');
  });

  it('gives up after the configured timeout', async () => {
    const odoo = createOdooClient(configFor(fake.url, { timeoutMs: 40 }));

    const error = await rejection(odoo.call('res.partner', 'hangs'));

    assert.equal(error.status, undefined);
    assert.match(error.message, /did not answer within 40 ms/);
  });

  it('lets the caller cancel a request in flight', async () => {
    const odoo = createOdooClient(configFor(fake.url));
    const controller = new AbortController();

    const pending = odoo.call('res.partner', 'hangs', {}, controller.signal);
    controller.abort(new Error('the user clicked Stop'));

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(!(error instanceof OdooError));
      return true;
    });
  });

  it('says so when Odoo cannot be reached at all', async () => {
    const closed = await startFakeOdoo();
    await closed.close();
    const odoo = createOdooClient(configFor(closed.url));

    const error = await rejection(odoo.call('res.partner', 'search_read'));

    assert.equal(error.status, undefined);
    assert.match(error.message, new RegExp(`^Cannot reach Odoo at ${closed.url}: `));
    assert.match(error.message, /ECONNREFUSED/);
  });

  it('reads the server version without credentials', async () => {
    const odoo = createOdooClient(configFor(fake.url, { apiKey: undefined }));

    const version = await odoo.version();

    assert.deepEqual(version, { version_info: [19, 0, 0, 'final', 0, 'e'], version: '19.0+e' });
    assert.equal(fake.lastRequest().method, 'GET');
    assert.equal(fake.lastRequest().path, '/web/version');
    assert.equal(fake.lastRequest().headers.authorization, undefined);
  });

  it('fetches a model’s documentation with the API key', async () => {
    const odoo = createOdooClient(configFor(fake.url));

    const doc = await odoo.modelDoc('res.partner');

    assert.deepEqual(doc, PARTNER_DOC);
    assert.equal(fake.lastRequest().method, 'GET');
    assert.equal(fake.lastRequest().path, '/doc-bearer/res.partner.json');
    assert.equal(fake.lastRequest().headers.authorization, `bearer ${FAKE_API_KEY}`);
    assert.equal(fake.lastRequest().headers['if-none-match'], undefined);
  });

  it('revalidates cached documentation instead of downloading it again', async () => {
    const odoo = createOdooClient(configFor(fake.url));
    await odoo.modelDoc('res.partner');

    const again = await odoo.modelDoc('res.partner');

    assert.equal(fake.lastRequest().headers['if-none-match'], 'abc123');
    assert.deepEqual(again, PARTNER_DOC);
  });

  it('does not cache documentation that came without a validator', async () => {
    const odoo = createOdooClient(configFor(fake.url));
    await odoo.modelDoc('res.users');

    await odoo.modelDoc('res.users');

    assert.equal(fake.lastRequest().headers['if-none-match'], undefined);
  });

  it('reports documentation errors like any other Odoo error', async () => {
    const odoo = createOdooClient(configFor(fake.url));

    const error = await rejection(odoo.modelDoc('no.such.model'));

    assert.equal(error.message, 'Odoo 404 NotFound: Not Found');
  });
});
