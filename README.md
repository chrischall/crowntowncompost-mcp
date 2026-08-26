# crowntowncompost-mcp

MCP server for the **Crown Town Compost** customer portal — check your pickups, invoices, and
upcoming collection days, skip a service, report a missed pickup, and update your account, all in
natural language.

> Developed and maintained by AI (Claude Code). Use at your own discretion.

## What it talks to

`crowntowncompost.com` is a marketing site with no customer data. Everything lives at
**`portal.crowntowncompost.com`**, a Django app (a white-labeled **StopSuite** hauler platform).
This server authenticates server-side with **a session cookie you already hold**, or with **your own
portal username and password** — a normal form login that returns one — and reads the same pages and
JSON endpoints the website uses.
No browser extension, no bot-wall workaround, no third-party service in the middle.

## Install

```sh
npm install -g crowntowncompost-mcp
```

Then add it to your MCP host. Two configurations work — supply **either** a
session cookie you already hold (nothing else needed), **or** the login pair so
the server can mint one:

```json
{
  "mcpServers": {
    "crowntowncompost": {
      "command": "npx",
      "args": ["-y", "crowntowncompost-mcp"],
      "env": {
        "CROWNTOWN_USERNAME": "you@example.com",
        "CROWNTOWN_PASSWORD": "your-portal-password"
      }
    }
  }
}
```

To use a session cookie instead, set `CROWNTOWN_SESSION_COOKIE` to a `Cookie`
header value from a signed-in browser session (`sessionid=…; csrftoken=…`) and
leave the username and password unset. The portal login is then never run, and
no password is stored anywhere.

Setting both is also valid, and is the most robust configuration: the cookie is
used first, and when the portal eventually expires it the login quietly mints a
replacement. With a cookie alone, an expired session is reported as expired —
the server says so plainly rather than claiming nothing is configured.

Locally you can instead copy `.env.example` to `.env`. The server boots without credentials (so a
host's install-time probe succeeds); the configuration error surfaces on the first tool call.

## Tools

### Reads

| Tool | What it returns |
|---|---|
| `crowntown_healthcheck` | Whether credentials work, plus account status — distinguishes "no creds" from "bad creds" from "site error" |
| `crowntown_get_dashboard` | Account status, subscription (plan, price, renewal date), next service date, service addresses + pickup days, and your environmental impact |
| `crowntown_get_account` | Contact details and notification preferences |
| `crowntown_get_pickup_schedule` | Pickup day(s) and time window per address — the official set-out-by time plus an observed arrival window (earliest/latest/typical, consistent vs varies) derived from your collection history |
| `crowntown_list_service_history` | Past collection stops — date, outcome, time, weight, services. Paginated; filter by `success`/`missing`/`empty`/`inaccessible`/`unacceptable` |
| `crowntown_list_upcoming_services` | Upcoming collection days, each with the ids needed to skip it |
| `crowntown_list_invoices` | Billing history with amounts, status, and Stripe payment links |

### Writes (all confirm-gated)

| Tool | What it does |
|---|---|
| `crowntown_skip_service` | Skip or un-skip an upcoming collection day |
| `crowntown_update_account` | Update contact details / notification preferences |
| `crowntown_report_missed_pickup` | Report that a collection was missed |
| `crowntown_contact_support` | Send a message to customer support |

Every mutating tool takes `confirm`. Without `confirm: true` it makes **no network call** and returns
a dry-run preview of exactly what would be sent. Where a re-read can prove the change stuck (skips,
account updates) the tool re-reads and reports `verified`; where it can't (support messages, missed-pickup
reports) it says so rather than claiming success.

Payments are deliberately out of scope — `crowntown_list_invoices` returns the hosted invoice URL for
you to open in a browser.

## Without the MCP

The `skills/crowntown-portal` skill does the same things with `curl` in a shell — useful in scripts or
on a machine where this server isn't installed. It documents the Django CSRF handshake, both JSON
endpoints, and every write's field list.

## Development

```sh
npm install
npm run build
npm test
```

Tests mock the network — no credentials needed and nothing hits the live portal. `tests/server-boot.test.ts`
spawns the real built artifacts (the npm `bin` and the bundle, the latter without `node_modules`) and runs
the MCP handshake against them.

Endpoint shapes are documented in [`docs/CROWNTOWN-API.md`](docs/CROWNTOWN-API.md), including which
parts are live-verified and which are not.

## License

MIT
