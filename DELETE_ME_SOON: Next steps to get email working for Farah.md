# Next steps to get bulk email working for Farah

This file is a one-time setup checklist. Delete it once everything below is done.

The admin bulk email tool lives at **`/admin/emails`** on the student portal (admin-only). Magic-link login emails are unchanged; **bulk Admissions campaigns use Postmark only**.

---

## 1. Google Sheet — Admissions tab

Create or confirm a tab named **`Admissions`** in the same spreadsheet the app already uses (`GOOGLE_SHEET_ID`).

**Required columns (row 1 = headers):**

| Column | Header (example) | Used for |
|--------|------------------|----------|
| **B** | AESOP ID | `[[AESOP ID]]` in messages |
| **C** | Name | `[[Name]]` |
| **D** | Email | Recipient address (rows with blank email are skipped) |

**Optional columns** (any header in row 1):

- Used for **filtering** on the Emails page (e.g. column **Round 1** with values `Accepted` / `Rejected` → “send to all Rejected”).
- Used as **template variables** in the message body, e.g. `[[Round 1]]`.

The service account that reads the People sheet must have **read access** to this tab.

If the tab name is not `Admissions`, set in Fly secrets / `secrets.json`:

```json
"googleSheets": {
  "admissionsSheetName": "Admissions",
  "admissionsIdColumn": "B",
  "admissionsNameColumn": "C",
  "admissionsEmailColumn": "D",
  "admissionsHeaderRow": "1"
}
```

Or env vars: `GOOGLE_ADMISSIONS_SHEET_NAME`, `GOOGLE_ADMISSIONS_ID_COLUMN`, etc.

---

## 2. Postgres (required for bulk send)

Bulk campaigns are stored in the database. Without Postgres, preview/test may work for sheet data, but **Send** returns an error.

Production (Fly) should already have:

- `DATABASE_URL` set
- `DATABASE_AUTO_MIGRATE=true` in `fly.toml` (runs migrations on deploy)

Migrations to apply:

- `db/migrations/004_email_campaigns.sql` — campaigns + recipients
- `db/migrations/005_email_postmark_tracking.sql` — delivery/open tracking

After deploy, confirm migrations ran (app log: `[db] auto-migrate complete`). If needed manually:

```bash
fly machine exec <machine-id> -a aesop-afghanistan "sh -c 'cd /app && node db/migrate.js'"
```

---

## 3. Postmark — server and sender

1. Sign in at [postmarkapp.com](https://postmarkapp.com).
2. Create a **Server** for bulk Admissions mail (or reuse one dedicated to this).
3. Verify your **sender domain** / signature so you can send from the same From address as the rest of AESOP (default: `noreply@aesopafghanistan.org` via `EMAIL_FROM`).
4. Copy the **Server API token**.

Add to Fly `SECRETS_JSON` (or env):

```json
"postmark": {
  "serverToken": "your-postmark-server-token-here"
}
```

Or:

```bash
POSTMARK_SERVER_TOKEN=your-postmark-server-token-here
```

**Note:** Magic links and Ding notifications still use Gmail / existing `email.provider`. Only the **Emails** admin tool uses Postmark.

---

## 4. Postmark webhooks — delivery & open tracking

So the app can show **Delivered** and **Opened** counts after a campaign sends:

1. In Postmark → your server → **Webhooks** → add a webhook.
2. **URL:**

   ```
   https://<your-portal-host>/api/postmark/webhook
   ```

   Example production: `https://portal.aesopafghanistan.org/api/postmark/webhook` (use whatever host serves the portal SPA).

3. Enable event types:
   - **Delivery**
   - **Open**
   - **Bounce** (recommended)

4. Set a long random **webhook secret** and add it to secrets:

```json
"postmark": {
  "serverToken": "...",
  "webhookSecret": "pick-a-long-random-string"
}
```

Or:

```bash
POSTMARK_WEBHOOK_SECRET=pick-a-long-random-string
```

5. Configure Postmark to send that secret on each request using **one** of:
   - Header: `Authorization: Bearer <webhookSecret>`
   - Header: `X-Aesop-Postmark-Webhook-Secret: <webhookSecret>`

   (Postmark’s UI may use HTTP Basic Auth instead — equivalent as long as the app receives one of the headers above; if using Basic Auth only, you may need to align with whoever deployed the app.)

**Open tracking** uses the HTML part of each email (tracking pixel). Plain text is still sent; opens are counted from HTML.

---

## 5. Admin access

Only portal admins can open `/admin/emails`. Farah should be on the admin allowlist:

```json
"admin": {
  "emails": ["farahnosh@aesopafghanistan.org"]
}
```

Or env: `PORTAL_ADMIN_EMAILS=farahnosh@aesopafghanistan.org,...`

Sign in via the normal magic link, then go to **Emails** in the portal nav (or `/admin/emails`).

---

## 6. Deploy

1. Merge/deploy the branch with the email feature (`teo-email` or whatever is current).
2. Ensure `npm run build` runs in deploy (client bundle includes the Emails page).
3. Confirm secrets include `POSTMARK_SERVER_TOKEN`, `POSTMARK_WEBHOOK_SECRET`, and `DATABASE_URL`.
4. Redeploy / restart the Fly app so migrations and the batch worker start.

The batch worker sends **250 emails immediately**, then **250 every 5 minutes** until the campaign finishes.

---

## 7. How to send a campaign (Farah’s workflow)

1. Open **`/admin/emails`** while signed in as admin.
2. **Group:** Admissions (Students is “coming soon”).
3. **Filter:** Check “All rows with an email”, or pick a column + value (e.g. Round 1 = Rejected).
4. **Message:** Write subject and body using placeholders:
   - Always available: `[[AESOP ID]]`, `[[Name]]`, `[[Email]]`
   - Any Admissions column header: e.g. `[[Round 1]]`
   - Globals you define: e.g. `[[Date]]` — fill in the **Global variables** section when it appears.
5. **Review:** Confirm the count (“**N emails will be sent**”) and scroll the recipient list.
6. **Send test to me** — **required** after any change to message, filter, or variables. Uses the **first row** matching your filter for sample data.
7. **Send to N recipients** — enabled only after a successful test; confirm the dialog.

After send, **Send progress** shows Sent / Failed / Delivered / Opened (Delivered/Opened update via webhooks).

---

## 8. Smoke-test checklist

- [ ] `/admin/emails` loads for Farah; non-admins see “Access denied”.
- [ ] Admissions tab loads; filter columns and values appear.
- [ ] Filter “Round 1 = Rejected” (or similar) shows the expected count and email list.
- [ ] Test email arrives at Farah’s inbox with substituted names/fields.
- [ ] Send stays disabled until test; editing the body disables Send again until a new test.
- [ ] Small test campaign (1–2 addresses) completes; Postmark activity shows sends.
- [ ] Delivery webhook fires; **Delivered** count increases on the progress panel.
- [ ] Opening the HTML email increases **Opened** (may take a minute).

---

## 9. Troubleshooting

| Problem | Things to check |
|--------|------------------|
| “Postmark is not configured” | `POSTMARK_SERVER_TOKEN` missing or wrong server |
| “Bulk email campaigns require a configured database” | `DATABASE_URL` not set on Fly |
| Admissions columns empty | Tab name wrong; service account can’t read tab; header row not row 1 |
| Send blocked | Run **Send test to me** again after changing message or filter |
| Delivered/Opened stay 0 | Webhook URL reachable from internet; `POSTMARK_WEBHOOK_SECRET` matches; Delivery/Open enabled in Postmark |
| Bounces | Check Postmark activity; recipient row may show **Bounced** in DB |

---

## 10. Optional env reference

| Variable | Purpose |
|----------|---------|
| `POSTMARK_SERVER_TOKEN` | Send bulk + test campaign mail via Postmark |
| `POSTMARK_WEBHOOK_SECRET` | Authenticate webhook POSTs |
| `EMAIL_FROM` | From address (default `noreply@aesopafghanistan.org`) |
| `GOOGLE_ADMISSIONS_SHEET_NAME` | Admissions tab name (default `Admissions`) |
| `DATABASE_URL` | Required for campaigns |
| `PORTAL_ADMIN_EMAILS` | Comma-separated admin emails |

See [`config/secrets.example.json`](config/secrets.example.json) for the full JSON shape used in `SECRETS_JSON` on Fly.
