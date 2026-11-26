import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { Stream } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client, type ClientOptions } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { FAKE_API_KEY, startFakeOdoo, type FakeOdoo } from './fake-odoo.ts';
import { callToolText } from './harness.ts';

// `npm run bundle` points this at the bundled server, to put the file that ships through the same checks.
const ENTRY = process.env.ODOO_MCP_ENTRY ?? fileURLToPath(new URL('../src/main.ts', import.meta.url));

function collect(stream: Stream | null): () => string {
  let text = '';
  stream?.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return () => text;
}

describe('the server process on stdio', () => {
  let fake: FakeOdoo;

  before(async () => {
    fake = await startFakeOdoo({ methods: { 'res.partner/search_read': () => [{ id: 7, name: 'Sensative AB' }] } });
  });

  after(async () => {
    await fake.close();
  });

  async function launch(env: Record<string, string>, options: ClientOptions = {}) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { ...getDefaultEnvironment(), ODOO_URL: fake.url, ODOO_API_KEY: FAKE_API_KEY, ...env },
      stderr: 'pipe',
    });
    const stderr = collect(transport.stderr);
    const client = new Client({ name: 'stdio-test', version: '1.0.0' }, options);
    await client.connect(transport);
    return { client, stderr };
  }

  it('serves a client that opens with the 2025 handshake', async () => {
    const { client, stderr } = await launch({ ODOO_DB: 'prod' });

    const outcome = await callToolText(client, 'search_read', { model: 'res.partner', fields: ['name'], limit: 1 });

    assert.equal(client.getProtocolEra(), 'legacy');
    assert.equal(outcome.text, '{"records":[\n{"id":7,"name":"Sensative AB"}\n],"returned":1,"offset":0,"has_more":false}');
    const request = fake.lastRequest();
    assert.equal(request.path, '/json/2/res.partner/search_read');
    assert.equal(request.headers.authorization, `bearer ${FAKE_API_KEY}`);
    assert.equal(request.headers['x-odoo-database'], 'prod');
    assert.match(request.headers['user-agent'] ?? '', /^odoo-mcp\/2\.\d+\.\d+$/);
    await client.close();
    assert.match(stderr(), new RegExp(`odoo-mcp: 2\\.\\d+\\.\\d+ serving ${fake.url} on stdio, read-write`));
  });

  it('serves a client that negotiates the 2026-07-28 protocol', async () => {
    const { client } = await launch({ ODOO_READONLY: '1' }, { versionNegotiation: { mode: 'auto' } });

    const { tools } = await client.listTools();
    const outcome = await callToolText(client, 'search_read', { model: 'res.partner' });

    assert.equal(client.getProtocolEra(), 'modern');
    assert.ok(!tools.some((tool) => tool.name === 'call'), 'read-only mode still offers call');
    assert.equal(outcome.isError, false);
    await client.close();
  });

  it('starts without an API key, warns on stderr and tells the model what is missing', async () => {
    const { client, stderr } = await launch({ ODOO_API_KEY: '' });

    const outcome = await callToolText(client, 'search_read', { model: 'res.partner' });

    assert.equal(outcome.isError, true);
    assert.match(outcome.text, /ODOO_API_KEY is not set/);
    await client.close();
    assert.match(stderr(), /ODOO_API_KEY is not set/);
  });

  it('refuses to start on a setting it cannot read, and keeps stdout clean', () => {
    const child = spawnSync(process.execPath, [ENTRY], {
      env: { ...getDefaultEnvironment(), ODOO_READONLY: 'maybe' },
      input: '',
      encoding: 'utf8',
    });

    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /odoo-mcp: ODOO_READONLY must be one of/);
  });
});
