import { McpServer } from '@modelcontextprotocol/server';

import packageJson from '../package.json' with { type: 'json' };
import type { Config } from './config.ts';
import type { OdooClient } from './odoo-client.ts';
import { listMethods, listModels, serverInfo } from './tools/discovery-tools.ts';
import { fieldsGet, formattedReadGroup, nameSearch, read, searchCount, searchRead } from './tools/read-tools.ts';
import type { ToolRegistration } from './tools/tool-kit.ts';
import { call, create, unlink, write } from './tools/write-tools.ts';

export const SERVER_NAME = 'odoo';
export const SERVER_VERSION = packageJson.version;
export const USER_AGENT = `odoo-mcp/${SERVER_VERSION}`;

const READING_TOOLS: readonly ToolRegistration[] = [
  serverInfo,
  listModels,
  fieldsGet,
  listMethods,
  searchRead,
  searchCount,
  read,
  nameSearch,
  formattedReadGroup,
];

const WRITING_TOOLS: readonly ToolRegistration[] = [create, write, unlink, call];

function instructions(config: Config): string {
  const writing = config.readOnly
    ? 'This server runs read-only: the tools that create, change or delete records are switched off.'
    : 'create, write, unlink and call change data. Every call commits on its own, so there is no rollback across calls.';
  return [
    `Odoo at ${config.baseUrl}, reached through its JSON-2 API as the user who owns the API key, with that user's access rights.`,
    'Find your way with list_models, then fields_get, then search_read, search_count or formatted_read_group. list_methods shows what `call` can run.',
    'Domains use prefix notation: [["state","=","sale"],["partner_id.name","ilike","acme"]]; [] matches everything.',
    'Always name the fields you want. Results come in pages: while has_more is true, repeat the call with offset set to next_offset.',
    'Pass `context` to set the language, the companies or to include archived records: {"lang":"sv_SE","allowed_company_ids":[1],"active_test":false}.',
    writing,
  ].join('\n');
}

export interface ServerDeps {
  readonly config: Config;
  readonly odoo: OdooClient;
}

export function createServer({ config, odoo }: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: 'Odoo', version: SERVER_VERSION },
    { instructions: instructions(config) },
  );
  const tools = config.readOnly ? READING_TOOLS : [...READING_TOOLS, ...WRITING_TOOLS];
  for (const register of tools) register(server, { config, odoo, serverName: SERVER_NAME, serverVersion: SERVER_VERSION });
  return server;
}
