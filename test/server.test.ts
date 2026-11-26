import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { createOdooClient } from '../src/odoo-client.ts';
import { createServer } from '../src/server.ts';
import { startFakeOdoo } from './fake-odoo.ts';
import { callToolText, startHarness, testConfig, type Harness } from './harness.ts';

const READING_TOOLS = [
  'fields_get',
  'formatted_read_group',
  'list_methods',
  'list_models',
  'name_search',
  'read',
  'search_count',
  'search_read',
  'server_info',
];
const WRITING_TOOLS = ['call', 'create', 'unlink', 'write'];

describe('the server in read-write mode', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness();
  });

  after(async () => {
    await harness.close();
  });

  it('speaks the 2026-07-28 protocol', () => {
    assert.equal(harness.client.getProtocolEra(), 'modern');
  });

  it('introduces itself as the Odoo server of this package version', () => {
    const version = harness.client.getServerVersion();

    assert.equal(version?.name, 'odoo');
    assert.equal(version?.title, 'Odoo');
    assert.match(version?.version ?? '', /^2\.\d+\.\d+$/);
  });

  it('tells the model where it is connected and how to find its way', () => {
    const instructions = harness.client.getInstructions() ?? '';

    assert.ok(instructions.includes(harness.fake.url));
    assert.match(instructions, /list_models/);
    assert.match(instructions, /next_offset/);
    assert.match(instructions, /commits on its own/);
    assert.doesNotMatch(instructions, /read-only/);
  });

  it('offers every reading and writing tool', async () => {
    const { tools } = await harness.client.listTools();

    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...READING_TOOLS, ...WRITING_TOOLS].sort());
  });

  it('describes every tool and every argument to the model', async () => {
    const { tools } = await harness.client.listTools();

    for (const tool of tools) {
      assert.ok((tool.title ?? '').length > 0, `${tool.name} has no title`);
      assert.ok((tool.description ?? '').length > 20, `${tool.name} has no description`);
      for (const [argument, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        const { description } = schema as { description?: string };
        assert.ok((description ?? '').length > 0, `${tool.name}.${argument} has no description`);
      }
    }
  });

  it('marks which tools only read, which overwrite and which delete', async () => {
    const { tools } = await harness.client.listTools();
    const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));

    for (const name of READING_TOOLS) {
      assert.equal(annotations[name]?.readOnlyHint, true, `${name} should be marked read-only`);
    }
    for (const name of WRITING_TOOLS) {
      assert.equal(annotations[name]?.readOnlyHint, false, `${name} should not be marked read-only`);
    }
    assert.equal(annotations.create?.destructiveHint, false);
    assert.equal(annotations.write?.destructiveHint, true);
    assert.equal(annotations.unlink?.destructiveHint, true);
    assert.equal(annotations.call?.destructiveHint, true);
    assert.equal(annotations.call?.openWorldHint, true);
  });
});

describe('the server in read-only mode', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness({ methods: { 'res.partner/create': () => [1] } }, { readOnly: true });
  });

  after(async () => {
    await harness.close();
  });

  it('offers the reading tools only', async () => {
    const { tools } = await harness.client.listTools();

    assert.deepEqual(tools.map((tool) => tool.name).sort(), READING_TOOLS);
  });

  it('says so in its instructions', () => {
    assert.match(harness.client.getInstructions() ?? '', /read-only/);
  });

  for (const name of WRITING_TOOLS) {
    it(`cannot be made to ${name}`, async () => {
      const attempt = harness.callTool(name, { model: 'res.partner', method: 'create', ids: [1], vals: {}, vals_list: [{}] });

      const refused = await attempt.then(
        (outcome) => outcome.isError,
        () => true,
      );

      assert.equal(refused, true);
      assert.equal(harness.fake.requests.length, 0);
    });
  }
});

describe('a client that still speaks the 2025 protocol', () => {
  it('is served by the same factory', async () => {
    const fake = await startFakeOdoo({ methods: { 'res.partner/search_count': () => 42 } });
    const config = testConfig(fake.url);
    const server = createServer({ config, odoo: createOdooClient(config) });
    const client = new Client({ name: 'legacy-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const outcome = await callToolText(client, 'search_count', { model: 'res.partner' });

    assert.equal(client.getProtocolEra(), 'legacy');
    assert.deepEqual(outcome, { text: '{"count":42}', isError: false });
    await client.close();
    await server.close();
    await fake.close();
  });
});
