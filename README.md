# odoo-mcp

MCP server (stdio) for Odoo 19+ using the JSON-2 API (`/json/2/<model>/<method>`).
Default target: https://shop.sensative.com (Odoo 19.0 Enterprise).

## Tools

| Tool | What |
|---|---|
| `search_read` | Search a model, return fields (`ir.model` lists all models) |
| `search_count` | Count records matching a domain |
| `fields_get` | Describe a model's fields |
| `call` | Any public model method: `create`, `write`, `unlink`, `action_confirm`, `read_group`, … (removed when `ODOO_READONLY=1`) |

All calls run as the user who owns the API key, with that user's access rights.

## Setup

1. In Odoo: avatar → *My Profile* → *Account Security* → *New API Key*.
2. `npm ci` (Node ≥ 22.18, runs TypeScript directly, no build step).
3. Add to Claude Code:

```sh
claude mcp add odoo -s user \
  -e ODOO_API_KEY=xxxx \
  -e ODOO_READONLY=1 \
  -- node /path/to/odoo-mcp/server.ts
```

| Env | Default | |
|---|---|---|
| `ODOO_API_KEY` | (required) | Bearer API key |
| `ODOO_URL` | `https://shop.sensative.com` | |
| `ODOO_DB` | none | Sent as `X-Odoo-Database`; only needed if the host serves several DBs |
| `ODOO_READONLY` | off | `1` hides the `call` tool |

## Test

`npm test` starts the server over stdio against a local fake Odoo.
