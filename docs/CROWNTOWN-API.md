# Crown Town Compost portal — reverse-engineered API

**Portal:** `https://portal.crowntowncompost.com` (Django + nginx/Ubuntu). White-labeled
**StopSuite** hauler platform (`portal.crowntowncompost.com` CNAMEs to `crowntown.stopsuite.com`).
Front-end stack: Metronic admin theme, jQuery, **htmx**, **FullCalendar**, litepicker, django-inplaceedit.

Archetype: **cookie-session / username+password** (like artsonia). Reachable server-side,
no bot wall. Login is a classic Django form POST that mints an HttpOnly `sessionid` cookie;
CSRF via `csrftoken` cookie + `csrfmiddlewaretoken` hidden field.

## Verification status (2026-07-31)

- **Reads — live-verified end-to-end through the built client** (`dist/client.js`), server-side,
  with no browser: the Django form login, the cookie session, both JSON endpoints (incl. the
  lowercase-vs-capitalized `query[status]` behaviour), and all four HTML parsers returned real
  account data. 61 stop records, 22 invoices, 9 upcoming skippable days.
- **CSRF-on-POST — live-verified.** The two datatable endpoints are POSTs and succeed through the
  same `X-CSRFToken` + `Origin` + `Referer` header path the write tools use.
- **Writes — `skip-service` is live-verified; the rest are captured but NOT executed.**
  - `POST /accounts/service-calendar/skip-service/` was exercised end-to-end against the live
    account on 2026-07-31 (skipped the Aug 7 2026 collection, `rid=2815 clid=3360`): it answered
    `200`, the calendar button flipped `skip` → `unskip` ("Resume Service"), and — independent
    confirmation from a different page — the dashboard's next-service date advanced from
    Aug. 7 to Aug. 14. So the body shape, the CSRF/Referer headers, and the re-read verification
    are all confirmed correct.
  - Every other write endpoint's field list below was read off the rendered form in a signed-in
    session but has **not** been submitted (they variously email staff, alter account settings, or
    cancel service). Those tools are confirm-gated and verify by re-reading where a re-read exists,
    but their bodies remain unexercised.

Shapes were captured through a signed-in browser session; values redacted, only shapes recorded.

---

## Auth

**Login page:** `GET /accounts/login/?next=/accounts/`
- Sets `csrftoken` cookie (SameSite=None, Secure, ~1yr).
- Form `POST /accounts/login/?next=/accounts/`, `application/x-www-form-urlencoded`:
  - `csrfmiddlewaretoken` (hidden field value; the cookie value also works as `X-CSRFToken` on AJAX)
  - `username` (username OR email)
  - `password`
- On success: 302 → `/accounts/` with `Set-Cookie: sessionid=...` (HttpOnly). Use `redirect: manual` to read it.
- On failure: 200 re-render of the login page with an error message (no sessionid).
- **Password reset** form also on the page: `POST /reset-password/` with `email`.
- **Logout:** `GET /accounts/logout/?next=/`

**Session expiry detection:** an authenticated GET that returns the login page (or 302 → `/accounts/login/`)
means the session expired → re-login + replay once.

**Django CSRF for POSTs:** send `X-CSRFToken: <csrftoken cookie>` and (for AJAX) `X-Requested-With: XMLHttpRequest`.
GETs are exempt. The `csrftoken` cookie is JS-readable (not HttpOnly).

---

## READ — JSON data endpoints (Metronic KTDatatable, server-side processing)

Both are **POST**, `application/x-www-form-urlencoded`, and return
`application/json` shaped `{ meta, qs, data: [...] }`.

### Request params (Metronic KTDatatable grammar — NOT DataTables draw/start/length)
- `pagination[page]` — 1-based page number
- `pagination[perpage]` — page size (default 20; honored, e.g. 3 → 3 rows)
- `sort[field]` — column field name; `sort[sort]` — `asc` | `desc`
- `query[<field>]` — per-column filter (e.g. `query[status]=missing`)
- `query[generalSearch]` — free-text search (Metronic default)

### Response `meta`
`{ page, pages, perpage, total, sort, rowIds: number[], field }`
`qs` is a string (the serialized query state).

### `POST /accounts/stops/api/` — service history / stops
Column fields (for `sort[field]` / `query[...]`): `RecordID, address, date, status, timestamp, services`.
Row shape:
```
{ RecordID:number, status:string, timestamp:string, address:string,
  weight:string, nickname:string, date:string, services:string }
```
- `status` display values: `Success, Missing, Empty, Inaccessible, Unacceptable`.
- **Filter values are lowercase:** `query[status]` ∈ `success | missing | empty | inaccessible | unacceptable` (empty = all).
  (Verified: `query[status]=missing` → total 13; `Missing` capitalized → total 0.)
- `date` is human ("Friday, Jul 24, 2026"); `timestamp` is the collection time ("9:34 a.m.").
- `services` e.g. "35 x1" (service code × count); `weight` in lbs (may be empty for missed).
- Account has 61 stop records total.

### `POST /accounts/billing-history/api/` — invoices
Row shape:
```
{ RecordID:number, number:string, date:string, amount:string, status:string,
  invoice_pdf:string, receipt_url:string, hosted_invoice_url:string,
  is_payable:boolean, invoice_id:number }
```
- Stripe-backed: `invoice_pdf` / `receipt_url` / `hosted_invoice_url` are Stripe URLs.
- `is_payable` flags an open/unpaid invoice.
- CSV export: `POST /accounts/billing-history/csv/` with `ids[]`, `qs`, `csrfmiddlewaretoken`.

---

## READ — server-rendered HTML pages (parse with node-html-parser)

### `GET /accounts/` — Dashboard
- **Subscription:** status (Active/…), price ("$44.00/month"), plan line ("Weekly Residential Service" + price),
  renews date ("August 1, 2026, 1:00 a.m."), next service date ("Aug. 7, 2026").
- **Service Address(es):** table — Address, Service Day(s) ("Friday"), Actions (per-row menu).
- **Environmental Impact** (CO2E): "N lbs diverted", "N seedlings planted", "N miles offset",
  "N gallons of gas". Has a litepicker "Filter by date" + Apply (recomputes for a range).

### `GET /accounts/update/` — Account details (GET renders current values)
Form `POST` to self:
`csrfmiddlewaretoken, first_name, last_name, phone, send_email_reminders (checkbox), service_notifications (checkbox)`

### `GET /accounts/service-calendar/` — Service calendar (FullCalendar, inline `events: [...]` array)
Upcoming service days rendered as calendar events; each skippable day has a button
`.submit-skip[data-rid][data-clid][data-action]` (action = skip/unskip toggle). Non-skippable days show "Not Skippable".

### Pickup time window — NOT exposed by the portal

Surveyed 2026-07-31: no portal surface (dashboard, service calendar, stops API, account form)
carries a promised arrival-time window — the dashboard's Service Address table is day-only
("Friday"). The only official time guidance is the marketing site's FAQ
(`crowntowncompost.com/faq`): *"Just make sure your bin is set out at the curb by 6am on your
pick-up day. We often start our routes early to beat the heat"* and *"Most customers set them out
the night before just to be safe!"* — a company-wide set-out policy, not a per-account setting. The stops API's `timestamp` field records the actual collection time of
every past stop, so `crowntown_get_pickup_schedule` derives an **observed** per-address window
(earliest/latest/median/IQR) from recent history instead. Formats seen live: `9:34 a.m.`,
`12:26 p.m.`, `2 p.m.`, `noon` (Django TIME_FORMAT).

### Other read pages
- `GET /accounts/shop/` — product shop (add-ons); JS-rendered cart, `Checkout`.
- `GET /accounts/service-history/` — HTML shell around the `stops/api` datatable (status filter select + date range).

---

## WRITE flows (all confirm-gate in the MCP)

Django forms POST to their own URL (empty `action` = self) with `csrfmiddlewaretoken`, unless noted.
**A 302/redirect is NOT proof of success — re-read to verify.**

| Tool | Endpoint | Method | Body fields |
|---|---|---|---|
| Report missed pickup | `/accounts/report-missed-pickup/` | POST (self) | `date`, `comment` |
| Update account details | `/accounts/update/` | POST (self) | `first_name, last_name, phone, send_email_reminders, service_notifications` |
| Contact support | `/accounts/support/` | POST (self) | `message, email, phone` |
| Request cancellation | `/accounts/cancellation-request/` | POST (self) | `cancel_location_<locId>` (hidden), `final_route_<locId>` (select), `cf_<n>` (custom-field select), `comments` |
| Skip / unskip service | `/accounts/service-calendar/skip-service/` | POST (AJAX) | `csrfmiddlewaretoken, rid, clid, action` (rid=route id, clid=client-location id from the calendar button's `data-rid`/`data-clid`; `action` toggles skip/unskip) |
| Export billing CSV | `/accounts/billing-history/csv/` | POST | `ids[], qs, csrfmiddlewaretoken` |

Notes:
- Cancellation-request field names are **per-location dynamic** (`final_route_3360`, `cancel_location_3360`, `cf_8`) — read the GET form first to discover them (read-modify-write).
- Skip service: to enumerate skippable days + their `rid`/`clid`/date, parse the rendered
  service-calendar (FullCalendar `events` array + `.submit-skip` button data attrs).

## Commerce (shop / checkout / gift certificates)
- `/accounts/shop/`, `/accounts/checkout/`, `/gift-certificates/`, `/accounts/claim-gift-certificate/`.
- Involve payment → **out of scope for v1** (payment entry is a prohibited action). Read-only shop listing at most.
