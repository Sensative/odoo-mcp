// Builds the desktop extension people install in Claude Desktop without touching a terminal:
// the server and all its dependencies as one JavaScript file, the manifest Claude Desktop reads,
// packed as dist/<name>-<version>.mcpb. Run with `npm run bundle`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { build } from 'esbuild';

import manifestTemplate from '../mcpb/manifest.json' with { type: 'json' };
import packageJson from '../package.json' with { type: 'json' };
import { loadConfig } from '../src/config.ts';
import { createOdooClient } from '../src/odoo-client.ts';
import { createServer } from '../src/server.ts';

// Fetched when bundling rather than kept as a dev dependency: its own dependencies fail `npm audit`.
const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';
// Claude Desktop runs the extension on the Node.js it ships with, which is older than the one used for development.
const OLDEST_NODE = 'node20';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const staging = join(dist, 'mcpb');
const entryPoint = join(staging, manifestTemplate.server.entry_point);
const bundlePath = join(dist, `${manifestTemplate.name}-${packageJson.version}.mcpb`);

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  execFileSync(command, args, { cwd: root, env, stdio: 'inherit' });
}

function mcpb(...args: readonly string[]): void {
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', MCPB_CLI, ...args]);
}

function packageRootOf(inputPath: string): string | undefined {
  const marker = 'node_modules/';
  const at = inputPath.lastIndexOf(marker);
  if (at === -1) return undefined;
  const [first = '', second = ''] = inputPath.slice(at + marker.length).split('/');
  return inputPath.slice(0, at + marker.length) + (first.startsWith('@') ? `${first}/${second}` : first);
}

function licenseOf(packageRoot: string): string {
  const directory = join(root, packageRoot);
  const file = readdirSync(directory).find((name) => /^licen[sc]e/i.test(name));
  const text = file === undefined ? 'No licence file in the package.' : readFileSync(join(directory, file), 'utf8').trim();
  return `${packageRoot.slice(packageRoot.lastIndexOf('node_modules/') + 'node_modules/'.length)}\n\n${text}`;
}

async function bundleServer(): Promise<readonly string[]> {
  const result = await build({
    entryPoints: [join(root, 'src/main.ts')],
    outfile: entryPoint,
    bundle: true,
    platform: 'node',
    target: OLDEST_NODE,
    format: 'cjs',
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
  });
  const packageRoots = Object.keys(result.metafile.inputs).map(packageRootOf);
  return [...new Set(packageRoots.filter((packageRoot) => packageRoot !== undefined))].sort();
}

async function listTools(): Promise<Array<{ name: string; description: string }>> {
  const config = loadConfig({});
  const server = createServer({ config, odoo: createOdooClient(config) });
  const client = new Client({ name: 'odoo-mcp-bundle', version: packageJson.version });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.map((tool) => ({ name: tool.name, description: tool.title ?? tool.name }));
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const bundledPackages = await bundleServer();
writeFileSync(join(staging, 'THIRD_PARTY_LICENSES.txt'), `${bundledPackages.map(licenseOf).join('\n\n----------\n\n')}\n`);
writeJson(join(staging, 'manifest.json'), { ...manifestTemplate, version: packageJson.version, tools: await listTools() });
// Without it Node would look further up the installation folder to decide how to load server/index.js.
writeJson(join(staging, 'package.json'), { name: manifestTemplate.name, version: packageJson.version, private: true, type: 'commonjs' });

mcpb('validate', join(staging, 'manifest.json'));
mcpb('pack', staging, bundlePath);
if (!existsSync(bundlePath)) throw new Error(`mcpb did not write ${bundlePath}`);

// The same end-to-end checks as the sources get, now against the file that ships.
run(process.execPath, ['--test', 'test/stdio.test.ts'], { ...process.env, ODOO_MCP_ENTRY: entryPoint });

console.log(`\nDesktop extension: ${bundlePath}`);
