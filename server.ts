#!/usr/bin/env node
// MCP server for Odoo 19+ using the JSON-2 API (/json/2/<model>/<method>).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const BASE = (process.env.ODOO_URL ?? "https://shop.sensative.com").replace(/\/+$/, "");
const KEY = process.env.ODOO_API_KEY;
const DB = process.env.ODOO_DB; // only needed when the server hosts several databases
const READONLY = process.env.ODOO_READONLY === "1";

export async function odoo(model: string, method: string, body: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (KEY) headers.Authorization = `bearer ${KEY}`;
  if (DB) headers["X-Odoo-Database"] = DB;
  const res = await fetch(`${BASE}/json/2/${encodeURIComponent(model)}/${encodeURIComponent(method)}`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  // ponytail: Odoo error bodies carry a server `debug` traceback; only `message` is surfaced
  if (!res.ok) throw new Error(`Odoo ${res.status}: ${data?.message ?? text.slice(0, 500)}`);
  return data;
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] });
const wrap = <A,>(fn: (a: A) => Promise<unknown>) => async (a: A) => { try { return ok(await fn(a)); } catch (e) { return fail(e); } };

const model = z.string().describe("e.g. res.partner, sale.order, product.product, account.move, stock.picking");
const domain = z.array(z.any()).default([]).describe('Odoo domain, e.g. [["state","=","sale"],["amount_total",">",1000]]');

export const server = new McpServer({ name: "odoo", version: "2.0.0" });

server.registerTool("search_read", {
  description: "Search records of an Odoo model and return the given fields. Tip: model 'ir.model' lists all installed models.",
  inputSchema: {
    model,
    domain,
    fields: z.array(z.string()).optional().describe("Fields to return; omit for all (can be large)"),
    limit: z.number().int().positive().max(500).default(50),
    offset: z.number().int().min(0).default(0),
    order: z.string().optional().describe('e.g. "date_order desc"'),
  },
  annotations: { readOnlyHint: true },
}, wrap(({ model, ...body }) => odoo(model, "search_read", body)));

server.registerTool("search_count", {
  description: "Count records of an Odoo model matching a domain.",
  inputSchema: { model, domain },
  annotations: { readOnlyHint: true },
}, wrap(({ model, domain }) => odoo(model, "search_count", { domain })));

server.registerTool("fields_get", {
  description: "Describe the fields of an Odoo model (label, type, relation, required, selection). Use before search_read/create/write.",
  inputSchema: { model },
  annotations: { readOnlyHint: true },
}, wrap(({ model }) => odoo(model, "fields_get", { attributes: ["string", "type", "required", "readonly", "relation", "selection", "help"] })));

if (!READONLY) {
  server.registerTool("call", {
    description:
      "Call any public method on an Odoo model via JSON-2. Examples: create {params:{vals_list:[{...}]}}, " +
      "write {ids, params:{vals:{...}}}, unlink {ids}, action_confirm {ids}, read_group {params:{domain, groupby, aggregates}}. " +
      "`ids` targets records; params are the method's named arguments, plus optional `context`.",
    inputSchema: {
      model,
      method: z.string(),
      ids: z.array(z.number().int()).optional(),
      params: z.record(z.string(), z.any()).default({}),
    },
    annotations: { destructiveHint: true },
  }, wrap(({ model, method, ids, params }) => odoo(model, method, ids ? { ids, ...params } : params)));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!KEY) console.error("odoo-mcp: ODOO_API_KEY not set, every call will fail with 401");
  await server.connect(new StdioServerTransport());
}
