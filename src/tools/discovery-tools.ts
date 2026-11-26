import * as z from 'zod';

import { htmlToText, renderJson, renderList, renderPage } from '../format.ts';
import { OdooError, type OdooClient } from '../odoo-client.ts';
import { limit, model, offset } from './schemas.ts';
import { expectList, READS, textResult, type ToolRegistration } from './tool-kit.ts';

const DOC_ACCESS_HINT =
  'list_methods reads Odoo’s /doc pages, which need the "Technical Documentation" group ' +
  '(it comes with Settings administration) and read access to the model.';

const ParameterDoc = z.looseObject({
  kind: z.string().optional(),
  annotation: z.string().optional(),
  doc: z.string().optional(),
});

const MethodDoc = z.looseObject({
  signature: z.string().optional(),
  parameters: z.record(z.string(), ParameterDoc).optional(),
  return: z.looseObject({ annotation: z.string().optional(), doc: z.string().optional() }).optional(),
  raise: z.record(z.string(), z.string()).optional(),
  doc: z.string().nullish(),
  api: z.array(z.string()).optional(),
  module: z.string().optional(),
});

const ModelDoc = z.looseObject({ methods: z.record(z.string(), MethodDoc) });

const VersionReply = z.looseObject({ version: z.string() });

type MethodDoc = z.infer<typeof MethodDoc>;
type ParameterDoc = z.infer<typeof ParameterDoc>;

function plain(html: string | null | undefined): string | undefined {
  return html === null || html === undefined || html === '' ? undefined : htmlToText(html);
}

function mapValues<In, Out>(record: Readonly<Record<string, In>> | undefined, convert: (value: In) => Out): Record<string, Out> | undefined {
  if (record === undefined || Object.keys(record).length === 0) return undefined;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, convert(value)]));
}

function describeParameter(parameter: ParameterDoc): Record<string, unknown> {
  return { ...parameter, doc: plain(parameter.doc) };
}

function summarizeMethod(name: string, doc: MethodDoc): Record<string, unknown> {
  return { name, signature: doc.signature, api: doc.api, module: doc.module };
}

function describeMethod(name: string, doc: MethodDoc): Record<string, unknown> {
  return {
    ...summarizeMethod(name, doc),
    doc: plain(doc.doc),
    parameters: mapValues(doc.parameters, describeParameter),
    returns: doc.return === undefined ? undefined : { ...doc.return, doc: plain(doc.return.doc) },
    raises: mapValues(doc.raise, htmlToText),
  };
}

async function fetchMethods(odoo: OdooClient, model: string, signal: AbortSignal): Promise<Readonly<Record<string, MethodDoc>>> {
  try {
    const parsed = ModelDoc.safeParse(await odoo.modelDoc(model, signal));
    if (parsed.success) return parsed.data.methods;
  } catch (error) {
    if (error instanceof OdooError && error.status === 403) {
      throw new OdooError(`${error.message} ${DOC_ACCESS_HINT}`, { status: 403, odooName: error.odooName, cause: error });
    }
    throw error;
  }
  throw new OdooError(`Odoo’s documentation of ${model} is not in the shape this server understands.`);
}

function matcher(query: string | undefined, methods: readonly string[] | undefined): (name: string) => boolean {
  const needle = query?.toLowerCase();
  const wanted = methods === undefined ? undefined : new Set(methods);
  return (name) => (needle === undefined || name.toLowerCase().includes(needle)) && (wanted === undefined || wanted.has(name));
}

export const listMethods: ToolRegistration = (server, { odoo, config }) => {
  server.registerTool(
    'list_methods',
    {
      title: 'List the methods of a model',
      description:
        'List the public methods of a model with their signatures, so that `call` gets the argument names right. ' +
        'Narrow the list with query or methods; set details to also get docstrings, parameter and return documentation. ' +
        'In `api`, "model" marks methods called without ids and "readonly" marks methods that do not write.',
      inputSchema: z.object({
        model,
        query: z.string().optional().describe('Keep methods whose name contains this text, e.g. "action_"'),
        methods: z.array(z.string()).optional().describe('Keep exactly these methods'),
        details: z.boolean().default(false).describe('Include documentation of each method, its parameters and return value'),
      }),
      annotations: READS,
    },
    async ({ model, query, methods, details }, ctx) => {
      const documented = await fetchMethods(odoo, model, ctx.mcpReq.signal);
      const keep = matcher(query, methods);
      const describe = details ? describeMethod : summarizeMethod;
      const listed = Object.entries(documented)
        .filter(([name]) => keep(name))
        .map(([name, doc]) => describe(name, doc));
      return textResult(renderList('methods', listed, config.maxResponseChars, 'Narrow the list with `query` or `methods`.'));
    },
  );
};

export const listModels: ToolRegistration = (server, { odoo, config }) => {
  server.registerTool(
    'list_models',
    {
      title: 'List models',
      description:
        'List the models (tables) installed in this Odoo with their technical and human names. ' +
        'Start here when you do not know which model holds the data; `transient` marks wizards.',
      inputSchema: z.object({
        query: z.string().optional().describe('Keep models whose technical or human name contains this text, e.g. "invoice" or "stock."'),
        limit: limit(100, 500),
        offset,
      }),
      annotations: READS,
    },
    async ({ query, limit, offset }, ctx) => {
      const domain = query === undefined ? [] : ['|', ['model', 'ilike', query], ['name', 'ilike', query]];
      const body = { domain, fields: ['model', 'name', 'transient'], order: 'model', offset, limit: limit + 1 };
      const models = expectList(await odoo.call('ir.model', 'search_read', body, ctx.mcpReq.signal), 'ir.model.search_read');
      return textResult(renderPage('models', models, { offset, limit }, config.maxResponseChars));
    },
  );
};

async function settle(pending: Promise<unknown>, signal: AbortSignal): Promise<{ readonly value: unknown } | { readonly error: string }> {
  try {
    return { value: await pending };
  } catch (error) {
    if (signal.aborted) throw error;
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function versionOf(reply: unknown): unknown {
  const parsed = VersionReply.safeParse(reply);
  return parsed.success ? parsed.data.version : reply;
}

export const serverInfo: ToolRegistration = (server, { odoo, config, serverName, serverVersion }) => {
  server.registerTool(
    'server_info',
    {
      title: 'Show the Odoo connection',
      description:
        'Report which Odoo this server talks to, its version, the user behind the API key and whether writing is switched off. ' +
        'The first thing to call when something does not work: it tells a wrong address from a rejected key.',
      annotations: READS,
    },
    async (ctx) => {
      const { signal } = ctx.mcpReq;
      const [version, user] = await Promise.all([
        settle(odoo.version(signal), signal),
        settle(odoo.call('res.users', 'context_get', {}, signal), signal),
      ]);
      return textResult(
        renderJson(
          {
            server: { name: serverName, version: serverVersion, read_only: config.readOnly },
            odoo: {
              url: config.baseUrl,
              database: config.database ?? null,
              ...('value' in version ? { version: versionOf(version.value) } : { version_error: version.error }),
            },
            ...('value' in user ? { user: user.value } : { user_error: user.error }),
          },
          config.maxResponseChars,
        ),
      );
    },
  );
};
