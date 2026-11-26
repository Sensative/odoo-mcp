# odoo-mcp

MCP server for Odoo 19+, built on the MCP TypeScript SDK v2 and Odoo's JSON-2 API
(`POST /json/2/<model>/<method>`, Bearer API key). XML-RPC and JSON-RPC are deprecated in Odoo 19.

Default target: **https://sensative.implefy.cloud** (Odoo 19.0 Enterprise).

Every call runs as the user who owns the API key, with that user's access rights and record rules.

## Setup

You need Node.js 22.18 or later. It runs the TypeScript sources directly, so there is no build step.

1. Create an API key in Odoo: avatar → *My Profile* → *Account Security* → *New API Key*.
   Keys expire, so expect to renew it.
2. Get the code and its dependencies:

   ```bash
   git clone https://github.com/Sensative/odoo-mcp.git
   ```

   ```bash
   cd odoo-mcp && npm ci
   ```

3. Check the key against the live instance. This starts the server the way an MCP host does
   and asks Odoo who you are:

   ```bash
   ODOO_API_KEY=your-key npm run smoke
   ```

4. Register the server with your MCP host.

### Claude Code

```bash
claude mcp add --env ODOO_API_KEY=your-key --env ODOO_READONLY=1 --scope user --transport stdio odoo \
  -- node /path/to/odoo-mcp/src/main.ts
```

Or in a project's `.mcp.json`, with the key taken from the environment (in Claude Code on the web:
from the environment's secrets):

```json
{
  "mcpServers": {
    "odoo": {
      "command": "node",
      "args": ["/path/to/odoo-mcp/src/main.ts"],
      "env": {
        "ODOO_API_KEY": "${ODOO_API_KEY:-}",
        "ODOO_READONLY": "1"
      }
    }
  }
}
```

### VS Code, Cursor and other hosts

Any host that launches stdio servers takes the same command: `node /path/to/odoo-mcp/src/main.ts`,
with the settings below as environment variables.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `ODOO_API_KEY` | none | Bearer API key. Without it the server starts, and every tool answers with how to get one. |
| `ODOO_URL` | `https://sensative.implefy.cloud` | Root address of the Odoo instance. An address copied from the browser (`…/odoo/action-123`) is cut back to the root. |
| `ODOO_DB` | none | Sent as `X-Odoo-Database`; only needed when the host serves several databases. |
| `ODOO_READONLY` | off | `1` switches off `create`, `write`, `unlink` and `call`. |
| `ODOO_TIMEOUT_MS` | `30000` | How long to wait for Odoo before giving up on a call. |
| `ODOO_MAX_RESPONSE_CHARS` | `40000` | Cap on the size of one tool answer, to protect the model's context. |
| `ODOO_ALLOW_INSECURE_HTTP` | off | `1` allows `http://` to a host other than localhost. The API key then travels unencrypted. |

## Tools

| Tool | What it does |
|---|---|
| `server_info` | Which Odoo, which version, which user is behind the key. Start here when something fails. |
| `list_models` | Installed models with technical and human names. |
| `fields_get` | The fields of a model: label, type, relation, selection values. |
| `list_methods` | The public methods of a model with their signatures and, on request, documentation. |
| `search_read` | Records matching a domain, chosen fields, paged. |
| `search_count` | Number of records matching a domain. |
| `read` | Chosen fields of records by id. |
| `name_search` | Resolve a display name to ids. |
| `formatted_read_group` | Group and aggregate: totals per customer, counts per state, revenue per month. |
| `create` | Create records. |
| `write` | Update records. |
| `unlink` | Delete records. |
| `call` | Any public model method: `action_confirm`, `action_post`, `copy`, `message_post`, … |

The last four are not registered when `ODOO_READONLY=1`.

What the answers look like:

- Paged tools return `{"records": […], "returned": n, "offset": n, "has_more": true, "next_offset": n}`.
  Repeat the call with `offset` set to `next_offset` while `has_more` is true.
- Lists larger than `ODOO_MAX_RESPONSE_CHARS` are cut at a record boundary and say so in `truncated`;
  any other oversized answer is cut with a note that the call itself went through.
- `search_read` and `read` return binary fields as their size, not their content, unless the call's
  `context` sets `bin_size` to `false`.
- Odoo's errors are passed on with their status and message (`Odoo 403 AccessError: …`), never with the server traceback.

`list_methods` reads Odoo's `/doc` pages. They need the *Technical Documentation* group, which comes with
Settings administration; the other tools work without it.

## Safety

- Run with `ODOO_READONLY=1` unless the task needs to change data. Each call to Odoo commits on its own:
  there is no transaction across calls and no undo.
- Prefer a dedicated Odoo user with only the access the work needs over a personal administrator key.
- The key is only ever sent to `ODOO_URL`. Redirects are not followed, and plain `http://` is refused
  for anything but localhost.
- Text stored in Odoo reaches the model as it is. Treat it as data, not as instructions.

## Development

```bash
npm run check
```

runs the type check and the tests. The tests drive the real server through a real MCP client, in process
and as a child process over stdio, against a local stand-in for Odoo (`test/fake-odoo.ts`) that answers
like the JSON-2 controller does, tracebacks included. No test talks to a real Odoo; `npm run smoke` does.

```
src/main.ts            entry point: settings from the environment, serves over stdio
src/server.ts          builds the MCP server and registers the tools
src/config.ts          reads and checks the settings
src/odoo-client.ts     JSON-2 calls, timeouts, error mapping
src/format.ts          paging envelopes and the response cap
src/tools/             one registration per tool
```

The server speaks the 2026-07-28 MCP revision and, through the same factory, the 2025 revisions that
older hosts still open with.
