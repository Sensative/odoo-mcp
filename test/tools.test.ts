import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { FakeOdooFault, TRACEBACK_MARKER, type FakeOdooOptions } from './fake-odoo.ts';
import { startHarness, type Harness } from './harness.ts';

const PARTNERS = [
  { id: 1, name: 'Sensative AB', is_company: true },
  { id: 2, name: 'Implefy AB', is_company: true },
  { id: 3, name: 'Ada Lovelace', is_company: false },
];
const GROUPS = [
  { state: 'sale', 'amount_total:sum': 1200, __extra_domain: [['state', '=', 'sale']] },
  { state: 'draft', 'amount_total:sum': 300, __extra_domain: [['state', '=', 'draft']] },
];
const PARTNER_FIELDS = { name: { string: 'Name', type: 'char' }, email: { string: 'Email', type: 'char' } };
const DEFAULT_ATTRIBUTES = ['string', 'type', 'required', 'readonly', 'relation', 'selection', 'help'];

const SALE_ORDER_DOC = {
  model: 'sale.order',
  name: 'Sales Order',
  doc: null,
  fields: {},
  methods: {
    action_confirm: {
      signature: '()',
      parameters: {},
      doc: '<p>Confirm the given quotation(s).</p>',
      return: { annotation: 'bool', doc: '<p>True</p>' },
      raise: { UserError: '<p>if the order is not a draft</p>' },
      model: 'sale.order',
      module: 'sale',
    },
    action_cancel: { signature: '()', parameters: {}, model: 'sale.order', module: 'sale' },
    search_read: {
      signature: '(domain=None, fields=None, offset=0, limit=None, order=None, read_kwargs)',
      parameters: {
        domain: { default: null, annotation: 'DomainType | None', doc: '<p>A search <em>domain</em>.</p>' },
        read_kwargs: { kind: 'VAR_KEYWORD' },
      },
      api: ['model', 'readonly'],
      model: 'core',
      module: 'core',
    },
  },
};

function page(body: Record<string, unknown>, rows: readonly unknown[]): unknown[] {
  const offset = Number(body.offset ?? 0);
  return rows.slice(offset, offset + Number(body.limit ?? rows.length));
}

const FAKE: FakeOdooOptions = {
  methods: {
    'res.partner/search_read': (body) => page(body, PARTNERS),
    'res.partner/search_count': () => 3,
    'res.partner/read': (body) => PARTNERS.filter((partner) => (body.ids as number[]).includes(partner.id)),
    'res.partner/name_search': () => [[1, 'Sensative AB']],
    'res.partner/fields_get': () => PARTNER_FIELDS,
    'res.partner/create': () => [10, 11],
    'res.partner/write': () => true,
    'res.partner/unlink': () => true,
    'res.partner/copy': () => [12],
    'res.users/context_get': () => ({ lang: 'en_US', tz: 'Europe/Stockholm', uid: 2 }),
    'sale.order/formatted_read_group': (body) => page(body, GROUPS),
    'sale.order/action_confirm': () => true,
    'sale.order/search_read': () => 'not a list',
    'stock.picking/search_read': () => null,
    'sale.order/fields_get': () => ['not', 'an', 'object'],
    'ir.model/search_read': () => [{ id: 80, model: 'res.partner', name: 'Contact', transient: false }],
    'account.move/unlink': () => {
      throw new FakeOdooFault(422, 'odoo.exceptions.UserError', 'You cannot delete a posted journal entry.');
    },
    'big.model/search_read': () => Array.from({ length: 30 }, (_, index) => ({ id: index + 1, note: 'n'.repeat(100) })),
    'big.model/export': () => 'e'.repeat(5000),
  },
  docs: {
    'sale.order': { etag: 'registry-1', body: SALE_ORDER_DOC },
    'odd.model': { body: { methods: 'not a map' } },
    'hr.payslip': new FakeOdooFault(403, 'odoo.exceptions.AccessError', 'This page is only accessible to Technical Documentation users.'),
  },
};

describe('tools', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness(FAKE);
  });

  after(async () => {
    await harness.close();
  });

  async function parsed(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const outcome = await harness.callTool(name, args);
    assert.equal(outcome.isError, false, outcome.text);
    return JSON.parse(outcome.text) as Record<string, unknown>;
  }

  async function refusedBeforeOdoo(name: string, args: Record<string, unknown>): Promise<string> {
    const requestsBefore = harness.fake.requests.length;
    const outcome = await harness.callTool(name, args);
    assert.equal(outcome.isError, true, outcome.text);
    assert.equal(harness.fake.requests.length, requestsBefore, 'the invalid call still reached Odoo');
    return outcome.text;
  }

  describe('search_read', () => {
    it('fetches one row beyond the page to know whether more exist', async () => {
      const result = await parsed('search_read', {
        model: 'res.partner',
        domain: [['is_company', '=', true]],
        fields: ['name'],
        limit: 2,
        order: 'name',
      });

      const request = harness.fake.lastRequest();
      assert.equal(request.path, '/json/2/res.partner/search_read');
      assert.deepEqual(request.body, {
        domain: [['is_company', '=', true]],
        fields: ['name'],
        order: 'name',
        offset: 0,
        limit: 3,
        context: { bin_size: true },
      });
      assert.deepEqual(result, { records: PARTNERS.slice(0, 2), returned: 2, offset: 0, has_more: true, next_offset: 2 });
    });

    it('continues from next_offset until nothing is left', async () => {
      const result = await parsed('search_read', { model: 'res.partner', limit: 2, offset: 2 });

      assert.deepEqual(result, { records: PARTNERS.slice(2), returned: 1, offset: 2, has_more: false });
    });

    it('matches everything, fifty at a time, when only the model is given', async () => {
      await parsed('search_read', { model: 'res.partner' });

      assert.deepEqual(harness.fake.lastRequest().body, { domain: [], offset: 0, limit: 51, context: { bin_size: true } });
    });

    it('lets the caller’s context win over the defaults', async () => {
      await parsed('search_read', { model: 'res.partner', context: { lang: 'sv_SE', bin_size: false } });

      assert.deepEqual((harness.fake.lastRequest().body as { context: unknown }).context, { bin_size: false, lang: 'sv_SE' });
    });

    it('rejects a page size beyond the maximum before calling Odoo', async () => {
      const message = await refusedBeforeOdoo('search_read', { model: 'res.partner', limit: 501 });

      assert.match(message, /limit/);
    });

    it('rejects something that is not a model name before calling Odoo', async () => {
      const message = await refusedBeforeOdoo('search_read', { model: 'res partner/../x' });

      assert.match(message, /Model names look like "res.partner"/);
    });

    it('hands Odoo’s own error to the model, without the traceback', async () => {
      const outcome = await harness.callTool('search_read', { model: 'no.such.model' });

      assert.deepEqual(outcome, { text: "Odoo 404 NotFound: the model 'no.such.model' does not exist", isError: true });
      assert.ok(!outcome.text.includes(TRACEBACK_MARKER));
    });

    it('fails clearly when Odoo answers with something other than records', async () => {
      const outcome = await harness.callTool('search_read', { model: 'sale.order' });

      assert.deepEqual(outcome, { text: 'Expected a list from sale.order.search_read, but Odoo returned a string.', isError: true });
    });
  });

  describe('search_read on an empty answer', () => {
    it('fails clearly when Odoo answers with nothing', async () => {
      const outcome = await harness.callTool('search_read', { model: 'stock.picking' });

      assert.deepEqual(outcome, { text: 'Expected a list from stock.picking.search_read, but Odoo returned null.', isError: true });
    });
  });

  describe('search_count', () => {
    it('counts the records matching a domain', async () => {
      const outcome = await harness.callTool('search_count', { model: 'res.partner', domain: [['is_company', '=', true]] });

      assert.deepEqual(outcome, { text: '{"count":3}', isError: false });
      assert.equal(harness.fake.lastRequest().path, '/json/2/res.partner/search_count');
      assert.deepEqual(harness.fake.lastRequest().body, { domain: [['is_company', '=', true]] });
    });
  });

  describe('read', () => {
    it('reads the chosen fields of the given ids', async () => {
      const result = await parsed('read', { model: 'res.partner', ids: [1, 3], fields: ['name'] });

      assert.equal(harness.fake.lastRequest().path, '/json/2/res.partner/read');
      assert.deepEqual(harness.fake.lastRequest().body, { ids: [1, 3], fields: ['name'], context: { bin_size: true } });
      assert.deepEqual(result, { records: [PARTNERS[0], PARTNERS[2]], returned: 2, total: 2 });
    });

    it('needs at least one id', async () => {
      await refusedBeforeOdoo('read', { model: 'res.partner', ids: [] });
    });
  });

  describe('name_search', () => {
    it('resolves a name to id and display name pairs', async () => {
      const outcome = await harness.callTool('name_search', { model: 'res.partner', name: 'sens' });

      assert.deepEqual(outcome, { text: '[[1,"Sensative AB"]]', isError: false });
      assert.equal(harness.fake.lastRequest().path, '/json/2/res.partner/name_search');
      assert.deepEqual(harness.fake.lastRequest().body, { name: 'sens', domain: [], operator: 'ilike', limit: 20 });
    });
  });

  describe('formatted_read_group', () => {
    it('groups and aggregates, one page of groups at a time', async () => {
      const result = await parsed('formatted_read_group', {
        model: 'sale.order',
        domain: [['date_order', '>=', '2026-01-01']],
        groupby: ['state'],
        aggregates: ['amount_total:sum'],
        having: [['amount_total:sum', '>', 100]],
        order: 'amount_total:sum desc',
        limit: 1,
      });

      assert.equal(harness.fake.lastRequest().path, '/json/2/sale.order/formatted_read_group');
      assert.deepEqual(harness.fake.lastRequest().body, {
        domain: [['date_order', '>=', '2026-01-01']],
        groupby: ['state'],
        aggregates: ['amount_total:sum'],
        having: [['amount_total:sum', '>', 100]],
        order: 'amount_total:sum desc',
        offset: 0,
        limit: 2,
      });
      assert.deepEqual(result, { groups: [GROUPS[0]], returned: 1, offset: 0, has_more: true, next_offset: 1 });
    });

    it('counts all records when no grouping or aggregate is named', async () => {
      await parsed('formatted_read_group', { model: 'sale.order' });

      assert.deepEqual(harness.fake.lastRequest().body, { domain: [], groupby: [], aggregates: ['__count'], offset: 0, limit: 81 });
    });
  });

  describe('fields_get', () => {
    it('describes every field with the attributes a model needs to use them', async () => {
      const result = await parsed('fields_get', { model: 'res.partner' });

      assert.equal(harness.fake.lastRequest().path, '/json/2/res.partner/fields_get');
      assert.deepEqual(harness.fake.lastRequest().body, { attributes: DEFAULT_ATTRIBUTES });
      assert.deepEqual(result, { fields: PARTNER_FIELDS, returned: 2, total: 2 });
    });

    it('describes only the named fields when asked', async () => {
      await parsed('fields_get', { model: 'res.partner', fields: ['email'], attributes: ['type'] });

      assert.deepEqual(harness.fake.lastRequest().body, { attributes: ['type'], allfields: ['email'] });
    });

    it('fails clearly when Odoo answers with something other than field descriptions', async () => {
      const outcome = await harness.callTool('fields_get', { model: 'sale.order' });

      assert.deepEqual(outcome, { text: 'Expected an object from sale.order.fields_get, but Odoo returned a list.', isError: true });
    });
  });

  describe('list_models', () => {
    it('lists the installed models in name order', async () => {
      const result = await parsed('list_models', {});

      assert.equal(harness.fake.lastRequest().path, '/json/2/ir.model/search_read');
      assert.deepEqual(harness.fake.lastRequest().body, {
        domain: [],
        fields: ['model', 'name', 'transient'],
        order: 'model',
        offset: 0,
        limit: 101,
      });
      assert.deepEqual(result, {
        models: [{ id: 80, model: 'res.partner', name: 'Contact', transient: false }],
        returned: 1,
        offset: 0,
        has_more: false,
      });
    });

    it('searches technical and human names alike', async () => {
      await parsed('list_models', { query: 'partner', limit: 5, offset: 10 });

      assert.deepEqual(harness.fake.lastRequest().body, {
        domain: ['|', ['model', 'ilike', 'partner'], ['name', 'ilike', 'partner']],
        fields: ['model', 'name', 'transient'],
        order: 'model',
        offset: 10,
        limit: 6,
      });
    });
  });

  describe('list_methods', () => {
    it('lists the callable methods with their signatures', async () => {
      const result = await parsed('list_methods', { model: 'sale.order' });

      assert.equal(harness.fake.lastRequest().method, 'GET');
      assert.equal(harness.fake.lastRequest().path, '/doc-bearer/sale.order.json');
      assert.deepEqual(result, {
        methods: [
          { name: 'action_confirm', signature: '()', module: 'sale' },
          { name: 'action_cancel', signature: '()', module: 'sale' },
          {
            name: 'search_read',
            signature: '(domain=None, fields=None, offset=0, limit=None, order=None, read_kwargs)',
            api: ['model', 'readonly'],
            module: 'core',
          },
        ],
        returned: 3,
        total: 3,
      });
    });

    it('narrows by a part of the name, whatever its case', async () => {
      const result = await parsed('list_methods', { model: 'sale.order', query: 'ACTION_' });

      assert.deepEqual((result.methods as Array<{ name: string }>).map((method) => method.name), ['action_confirm', 'action_cancel']);
    });

    it('narrows to exactly the named methods', async () => {
      const result = await parsed('list_methods', { model: 'sale.order', methods: ['search_read', 'no_such_method'] });

      assert.deepEqual((result.methods as Array<{ name: string }>).map((method) => method.name), ['search_read']);
    });

    it('adds plain-text documentation on request', async () => {
      const result = await parsed('list_methods', { model: 'sale.order', query: 'action_confirm', details: true });

      assert.deepEqual(result.methods, [
        {
          name: 'action_confirm',
          signature: '()',
          module: 'sale',
          doc: 'Confirm the given quotation(s).',
          returns: { annotation: 'bool', doc: 'True' },
          raises: { UserError: 'if the order is not a draft' },
        },
      ]);
    });

    it('documents each parameter: type, default, kind and meaning', async () => {
      const result = await parsed('list_methods', { model: 'sale.order', methods: ['search_read'], details: true });

      assert.deepEqual((result.methods as Array<{ parameters: unknown }>)[0]?.parameters, {
        domain: { default: null, annotation: 'DomainType | None', doc: 'A search domain.' },
        read_kwargs: { kind: 'VAR_KEYWORD' },
      });
    });

    it('revalidates documentation it already holds instead of downloading it again', async () => {
      await parsed('list_methods', { model: 'sale.order' });

      assert.equal(harness.fake.lastRequest().headers['if-none-match'], 'registry-1');
    });

    it('explains which access the documentation pages need', async () => {
      const outcome = await harness.callTool('list_methods', { model: 'hr.payslip' });

      assert.equal(outcome.isError, true);
      assert.match(outcome.text, /^Odoo 403 AccessError: This page is only accessible to Technical Documentation users\./);
      assert.match(outcome.text, /"Technical Documentation" group/);
    });

    it('passes other documentation errors through unchanged', async () => {
      const outcome = await harness.callTool('list_methods', { model: 'no.such.model' });

      assert.deepEqual(outcome, { text: 'Odoo 404 NotFound: Not Found', isError: true });
    });

    it('fails clearly on documentation it cannot read', async () => {
      const outcome = await harness.callTool('list_methods', { model: 'odd.model' });

      assert.deepEqual(outcome, { text: 'Odoo’s documentation of odd.model is not in the shape this server understands.', isError: true });
    });
  });

  describe('server_info', () => {
    it('reports the connection, the Odoo version and the user behind the key', async () => {
      const result = await parsed('server_info', {});

      assert.deepEqual(result, {
        server: { name: 'odoo', version: '2.0.0', read_only: false },
        odoo: { url: harness.fake.url, database: null, version: '19.0+e' },
        user: { lang: 'en_US', tz: 'Europe/Stockholm', uid: 2 },
      });
    });
  });

  describe('create', () => {
    it('creates one record per set of values and returns the new ids', async () => {
      const outcome = await harness.callTool('create', { model: 'res.partner', vals_list: [{ name: 'A' }, { name: 'B' }] });

      assert.deepEqual(outcome, { text: '{"ids":[10,11]}', isError: false });
      assert.equal(harness.fake.lastRequest().path, '/json/2/res.partner/create');
      assert.deepEqual(harness.fake.lastRequest().body, { vals_list: [{ name: 'A' }, { name: 'B' }] });
    });

    it('needs at least one set of values', async () => {
      await refusedBeforeOdoo('create', { model: 'res.partner', vals_list: [] });
    });
  });

  describe('write', () => {
    it('sets the values on the given records', async () => {
      const outcome = await harness.callTool('write', {
        model: 'res.partner',
        ids: [1, 2],
        vals: { email: 'info@sensative.com' },
        context: { lang: 'sv_SE' },
      });

      assert.deepEqual(outcome, { text: '{"ids":[1,2],"result":true}', isError: false });
      assert.equal(harness.fake.lastRequest().path, '/json/2/res.partner/write');
      assert.deepEqual(harness.fake.lastRequest().body, { ids: [1, 2], vals: { email: 'info@sensative.com' }, context: { lang: 'sv_SE' } });
    });
  });

  describe('unlink', () => {
    it('deletes the given records', async () => {
      const outcome = await harness.callTool('unlink', { model: 'res.partner', ids: [3] });

      assert.deepEqual(outcome, { text: '{"deleted_ids":[3],"result":true}', isError: false });
      assert.equal(harness.fake.lastRequest().path, '/json/2/res.partner/unlink');
      assert.deepEqual(harness.fake.lastRequest().body, { ids: [3] });
    });

    it('reports why Odoo refused', async () => {
      const outcome = await harness.callTool('unlink', { model: 'account.move', ids: [9] });

      assert.deepEqual(outcome, { text: 'Odoo 422 UserError: You cannot delete a posted journal entry.', isError: true });
    });
  });

  describe('call', () => {
    it('runs a business method on records', async () => {
      const outcome = await harness.callTool('call', { model: 'sale.order', method: 'action_confirm', ids: [5, 6] });

      assert.deepEqual(outcome, { text: 'true', isError: false });
      assert.equal(harness.fake.lastRequest().path, '/json/2/sale.order/action_confirm');
      assert.deepEqual(harness.fake.lastRequest().body, { ids: [5, 6] });
    });

    it('passes the method’s arguments by name, next to ids and context', async () => {
      const outcome = await harness.callTool('call', {
        model: 'res.partner',
        method: 'copy',
        ids: [1],
        kwargs: { default: { name: 'Copy' } },
        context: { lang: 'sv_SE' },
      });

      assert.deepEqual(outcome, { text: '[12]', isError: false });
      assert.deepEqual(harness.fake.lastRequest().body, { default: { name: 'Copy' }, ids: [1], context: { lang: 'sv_SE' } });
    });

    it('calls model-level methods without ids', async () => {
      await harness.callTool('call', { model: 'res.users', method: 'context_get' });

      assert.deepEqual(harness.fake.lastRequest().body, {});
    });

    it('rejects private methods before calling Odoo', async () => {
      const message = await refusedBeforeOdoo('call', { model: 'res.partner', method: '_compute_display_name' });

      assert.match(message, /Only public methods can be called/);
    });

    it('rejects ids or context smuggled into kwargs', async () => {
      const message = await refusedBeforeOdoo('call', { model: 'res.partner', method: 'copy', kwargs: { ids: [1] } });

      assert.match(message, /Pass ids and context in their own parameters/);
    });
  });
});

describe('tools under a small response cap', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness(FAKE, { maxResponseChars: 1500 });
  });

  after(async () => {
    await harness.close();
  });

  it('returns the records that fit and says how to get the rest', async () => {
    const outcome = await harness.callTool('search_read', { model: 'big.model' });
    const result = JSON.parse(outcome.text) as { records: unknown[]; returned: number; has_more: boolean; next_offset: number; truncated: string };

    assert.equal(outcome.isError, false);
    assert.ok(outcome.text.length <= 1500);
    assert.ok(result.returned > 0 && result.returned < 30);
    assert.equal(result.records.length, result.returned);
    assert.equal(result.has_more, true);
    assert.equal(result.next_offset, result.returned);
    assert.match(result.truncated, /fit the 1500-character response cap/);
  });

  it('cuts an oversized method result without calling the method a failure', async () => {
    const outcome = await harness.callTool('call', { model: 'big.model', method: 'export' });

    assert.equal(outcome.isError, false);
    assert.ok(outcome.text.length <= 1500);
    assert.match(outcome.text, /The call itself completed/);
  });
});

describe('tools with a rejected API key', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness(FAKE, { apiKey: 'expired-key' });
  });

  after(async () => {
    await harness.close();
  });

  it('server_info still shows the Odoo version and explains the key problem', async () => {
    const outcome = await harness.callTool('server_info');
    const result = JSON.parse(outcome.text) as { odoo: { version: string }; user?: unknown; user_error: string };

    assert.equal(outcome.isError, false);
    assert.equal(result.odoo.version, '19.0+e');
    assert.equal(result.user, undefined);
    assert.match(result.user_error, /^Odoo 401 Unauthorized: Invalid apikey/);
    assert.match(result.user_error, /ODOO_API_KEY/);
  });

  it('every other tool reports the rejected key', async () => {
    const outcome = await harness.callTool('search_count', { model: 'res.partner' });

    assert.equal(outcome.isError, true);
    assert.match(outcome.text, /^Odoo 401 Unauthorized: Invalid apikey/);
  });
});

describe('server_info against a server that is not quite Odoo', () => {
  it('shows a version answer it does not recognise as it came', async () => {
    const harness = await startHarness({
      rawRoutes: {
        '/web/version': (_request, response) => {
          response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"series": "19"}');
        },
      },
    });

    const result = JSON.parse((await harness.callTool('server_info')).text) as { odoo: { version: unknown } };

    assert.deepEqual(result.odoo.version, { series: '19' });
    await harness.close();
  });

  it('reports a wrong address and a missing key side by side', async () => {
    const harness = await startHarness(
      {
        rawRoutes: {
          '/web/version': (_request, response) => {
            response.writeHead(404, { 'Content-Type': 'text/html' }).end('<html><title>404 Not Found</title></html>');
          },
        },
      },
      { apiKey: undefined },
    );

    const outcome = await harness.callTool('server_info');
    const result = JSON.parse(outcome.text) as { odoo: { version_error: string }; user_error: string };

    assert.equal(outcome.isError, false);
    assert.equal(result.odoo.version_error, 'Odoo 404: 404 Not Found');
    assert.match(result.user_error, /ODOO_API_KEY is not set/);
    await harness.close();
  });
});

describe('cancelling a tool call', () => {
  it('drops the request to Odoo instead of letting it run on', async () => {
    let odooSawTheDrop = (): void => {};
    const dropped = new Promise<void>((resolve) => {
      odooSawTheDrop = resolve;
    });
    const harness = await startHarness({
      rawRoutes: {
        '/json/2/res.partner/search_count': (request) => {
          request.socket.once('close', odooSawTheDrop);
        },
      },
    });
    const controller = new AbortController();

    try {
      const pending = harness.client.callTool({ name: 'search_count', arguments: { model: 'res.partner' } }, { signal: controller.signal });
      while (harness.fake.requests.length === 0) await sleep(5);
      controller.abort(new Error('the user clicked Stop'));

      await assert.rejects(pending);
      const sawTheDrop = await Promise.race([dropped.then(() => true), sleep(3000, false, { ref: false })]);
      assert.equal(sawTheDrop, true, 'Odoo was still being waited on three seconds after the cancellation');
    } finally {
      await harness.close();
    }
  });
});
