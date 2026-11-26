import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import type { Config } from '../src/config.ts';
import { createOdooClient } from '../src/odoo-client.ts';
import { createServer } from '../src/server.ts';
import { FAKE_API_KEY, startFakeOdoo, type FakeOdoo, type FakeOdooOptions } from './fake-odoo.ts';

export interface ToolOutcome {
  readonly text: string;
  readonly isError: boolean;
}

export interface Harness {
  readonly client: Client;
  readonly fake: FakeOdoo;
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolOutcome>;
  close(): Promise<void>;
}

export function testConfig(baseUrl: string, overrides: Partial<Config> = {}): Config {
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

export async function callToolText(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error(`${name} did not answer with a text block`);
  return { text: block.text, isError: result.isError === true };
}

// Drives the real server factory through a real MCP client, in process:
// createMcpHandler serves the 2026-07-28 protocol the same way a deployment would.
export async function startHarness(fakeOptions: FakeOdooOptions = {}, overrides: Partial<Config> = {}): Promise<Harness> {
  const fake = await startFakeOdoo(fakeOptions);
  const config = testConfig(fake.url, overrides);
  const odoo = createOdooClient(config);
  const handler = createMcpHandler(() => createServer({ config, odoo }));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'test-harness', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);

  return {
    client,
    fake,
    callTool: (name, args) => callToolText(client, name, args),
    async close() {
      await client.close();
      await handler.close();
      await fake.close();
    },
  };
}
