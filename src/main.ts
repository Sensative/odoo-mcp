#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { ConfigError, loadConfig, type Config } from './config.ts';
import { createOdooClient } from './odoo-client.ts';
import { createServer, SERVER_VERSION, USER_AGENT } from './server.ts';

// stdout carries the MCP protocol; everything meant for people goes to stderr.
function say(message: string): void {
  console.error(`odoo-mcp: ${message}`);
}

function readConfig(): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    say(error.message);
    process.exit(1);
  }
}

const config = readConfig();
const odoo = createOdooClient(config, { userAgent: USER_AGENT });

serveStdio(() => createServer({ config, odoo }), { onerror: (error) => say(error.message) });

say(`${SERVER_VERSION} serving ${config.baseUrl} on stdio, ${config.readOnly ? 'read-only' : 'read-write'}`);
if (config.apiKey === undefined) say('ODOO_API_KEY is not set, so every call to Odoo will be refused until it is');
