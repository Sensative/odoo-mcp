// Self-check: run server.ts over stdio against a local fake Odoo. `npm test`
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import assert from "node:assert/strict";

const seen: any[] = [];
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c)).on("end", () => {
    seen.push({ url: req.url, auth: req.headers.authorization, db: req.headers["x-odoo-database"], body: JSON.parse(body) });
    if (req.url!.includes("boom")) { res.writeHead(422).end(JSON.stringify({ message: "bad thing", debug: "SECRET TRACE" })); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([{ id: 7, name: "Sensative AB" }]));
  });
}).listen(0);
await new Promise((r) => fake.once("listening", r));
const port = (fake.address() as any).port;

async function connect(env: Record<string, string>) {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StdioClientTransport({
    command: process.execPath, args: ["server.ts"],
    env: { ...(process.env as any), ODOO_URL: `http://127.0.0.1:${port}/`, ODOO_API_KEY: "k123", ODOO_DB: "db1", ...env },
  }));
  return c;
}

const c = await connect({});
assert.deepEqual((await c.listTools()).tools.map((t) => t.name).sort(), ["call", "fields_get", "search_count", "search_read"]);

let r: any = await c.callTool({ name: "search_read", arguments: { model: "res.partner", fields: ["name"], limit: 1 } });
assert.equal(r.isError, undefined);
assert.match(r.content[0].text, /Sensative AB/);
assert.deepEqual(seen.at(-1), {
  url: "/json/2/res.partner/search_read", auth: "bearer k123", db: "db1",
  body: { domain: [], fields: ["name"], limit: 1, offset: 0 },
});

await c.callTool({ name: "call", arguments: { model: "sale.order", method: "action_confirm", ids: [1, 2] } });
assert.deepEqual(seen.at(-1).body, { ids: [1, 2] });

r = await c.callTool({ name: "call", arguments: { model: "x", method: "boom" } });
assert.equal(r.isError, true);
assert.equal(r.content[0].text, "Odoo 422: bad thing"); // traceback not leaked
await c.close();

const ro = await connect({ ODOO_READONLY: "1" });
assert.ok(!(await ro.listTools()).tools.some((t) => t.name === "call"));
await ro.close();

fake.close();
console.log("ok");
