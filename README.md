# odoo-mcp

MCP server for Odoo 19+, built on the MCP TypeScript SDK v2 and Odoo's JSON-2 API
(`POST /json/2/<model>/<method>`, Bearer API key). XML-RPC and JSON-RPC are deprecated in Odoo 19.

Default target: **https://sensative.implefy.cloud** (Odoo 19.0 Enterprise).

Every call runs as the user who owns the API key, with that user's access rights and record rules.

## Create your API key

The server signs in to Odoo with a personal API key. The key belongs to your user: calls run with your
access rights and show up under your name in Odoo's logs.

1. Sign in at https://sensative.implefy.cloud/odoo as usual.
2. Click your avatar in the top right corner and choose **My Preferences**.
3. Open the **Security** tab and click **Add API Key** under *API Keys*.
4. Confirm with your password when Odoo asks. If you do not remember it, use *Reset Password* on the
   sign-in page first.
5. Describe the key (for example `Claude MCP`), choose how long it should be valid and click **Generate key**.
6. Copy the key straight away. Odoo shows it once and cannot show it again.

Good to know:

- **Lifetime.** Ordinary users get at most 90 days by default; Settings administrators can also choose
  *Persistent Key*. Once a key has expired the tools answer `Odoo 401 Unauthorized: Invalid apikey`;
  create a new key the same way.
- **Handling.** The key gives full access to your account. Keep it like a password, in a password manager
  or a secret store, and never put it in a chat, a ticket or a commit.
- **Withdrawing.** The same *API Keys* list has a trash button on every key. A deleted key stops working
  at once.

## Install and connect

You need Node.js 22.18 or later. It runs the TypeScript sources directly, so there is no build step.

1. Get the code and its dependencies:

   ```bash
   git clone https://github.com/Sensative/odoo-mcp.git
   ```

   ```bash
   cd odoo-mcp && npm ci
   ```

2. Check your key against the live instance. This starts the server the way an MCP host does and asks
   Odoo who you are:

   ```bash
   ODOO_API_KEY=your-key npm run smoke
   ```

   A working key ends the run with `OK: the API key works.` and shows your user under `server_info`.
   Without a working key the same output says what Odoo objected to.

3. Register the server with your MCP host, as below.

### Claude Code

```bash
claude mcp add --env ODOO_API_KEY=your-key --env ODOO_READONLY=1 --scope user --transport stdio odoo \
  -- node /path/to/odoo-mcp/src/main.ts
```

Or in a project's `.mcp.json`, which reads the key from the environment instead of holding it:

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

### Claude Code on the web

Add `ODOO_API_KEY` as an environment variable in the cloud environment's settings (the environment menu
in the session's title bar, then *Edit*) and start a new session; the `.mcp.json` above picks it up.
The session also needs this repository checked out with `npm ci` run, for example from the environment's
setup script, and `args` pointing at that checkout.

Everyone who uses that environment can read the variable, so give it a key for a user with no more access
than the work needs.

### VS Code, Cursor and other hosts

Any host that launches stdio servers takes the same command: `node /path/to/odoo-mcp/src/main.ts`,
with the settings below as environment variables.

## Why an API key and not an OAuth login?

Odoo's JSON-2 API accepts API keys only. Odoo can let people *sign in* through an OAuth provider, but it
does not issue OAuth tokens for its API, and this instance signs people in with e-mail and password.

MCP's own OAuth flow applies to servers reached over HTTP. A server that a host starts as a local process,
like this one, takes its credentials from the environment.

A "click Connect and sign in" experience can be built, but it is a different deployment:

- the server runs as a service on an address of its own, over HTTP;
- an identity provider, for example Microsoft Entra, signs people in and issues the tokens;
- the server still needs an Odoo API key for every person behind the scenes. One shared service key
  would work too, but then everybody acts as the same Odoo user.

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
