// Live check: starts the server the way an MCP host does and asks the configured
// Odoo who it is. Run with `ODOO_API_KEY=… npm run smoke`.
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));
// The whole environment, not the SDK's safe subset: the ODOO_* settings and any proxy settings must reach the server.
const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));

const client = new Client({ name: 'odoo-mcp-smoke', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env }));

async function show(name: string, args: Record<string, unknown> = {}): Promise<boolean> {
  const result = await client.callTool({ name, arguments: args });
  const [block] = result.content;
  console.log(`\n# ${name} ${JSON.stringify(args)}\n${block?.type === 'text' ? block.text : JSON.stringify(result.content)}`);
  return result.isError !== true;
}

const { tools } = await client.listTools();
console.log(`protocol: ${client.getProtocolEra()}\ntools: ${tools.map((tool) => tool.name).join(', ')}`);

await show('server_info');
const canRead = await show('search_count', { model: 'res.partner' });
await show('list_models', { limit: 3 });

await client.close();
console.log(canRead ? '\nOK: the API key works.' : '\nFAILED: Odoo refused the call above.');
process.exitCode = canRead ? 0 : 1;
