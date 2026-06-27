# AESOP Afghanistan

This repo contains various scripts used to manage the AESOP Afghanistan organization.

[For more information about AESOP Afghanistan, please refer to our website: aesopafghanistan.org](https://aesopafghanistan.org/about)

## Deployment

This application is automatically deployed to Fly.io via GitHub Actions when changes are pushed to the `main` or `master` branch.

### Initial Setup

1. **Install Fly.io CLI** (if not already installed):

   ```bash
   curl -L https://fly.io/install.sh | sh
   ```

2. **Login to Fly.io**:

   ```bash
   flyctl auth login
   ```

3. **Create the Fly.io app** (if it doesn't exist):

   ```bash
   flyctl launch --no-deploy
   ```

   This will use the existing `fly.toml` configuration.

4. **Get your Fly.io API token**:
   - Go to https://fly.io/user/personal_access_tokens
   - Create a new token
   - Copy the token

5. **Add the token to GitHub Secrets**:
   - Go to your GitHub repository
   - Navigate to Settings → Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `FLY_API_TOKEN`
   - Value: Your Fly.io API token
   - Click "Add secret"

6. **Configure Application Secrets in Fly.io**:
   After your first deployment, create `config/secrets.json` locally (see [Configuration](#configuration); it is gitignored). Push it to Fly as **`SECRETS_JSON`** by running from the repository root:
   ```bash
   bash scripts/update_secrets.sh
   ```
   That script uploads the contents of `config/secrets.json` to the `aesop-afghanistan` app. You must be logged in (`flyctl auth login`). Alternatively, set discrete variables (see Configuration); those apply only when `SECRETS_JSON` is unset.

### Manual Deployment

To deploy manually:

```bash
flyctl deploy
```

### Local Development

Run the server locally:

```bash
npm install
npm start
```

The server will be available at `http://localhost:3000`

## Configuration

### Setting Up Secrets

This application requires configuration for Google Sheets and email services. Resolution order is **`SECRETS_JSON`** (environment) → **`config/secrets.json`** → discrete environment variables only.

#### Option 1: Using `config/secrets.json` (Recommended for local development)

1. Copy the example file:

   ```bash
   cp config/secrets.example.json config/secrets.json
   ```

2. Edit `config/secrets.json` with your credentials (see sections below)

#### Option 2: `SECRETS_JSON` on Fly.io (Recommended for production)

Production uses one Fly secret whose value is the full JSON config (same structure as `secrets.example.json`):

- `SECRETS_JSON` - Full config object as a JSON string

After any change to local `config/secrets.json`, sync it to Fly from the repo root:

```bash
bash scripts/update_secrets.sh
```

After load, `googleSheets` is merged with non-empty `GOOGLE_*` environment variables so you can override the sheet ID without editing the blob.

#### Option 3: Discrete environment variables only

If `SECRETS_JSON` is unset and `config/secrets.json` is absent (typical minimal containers), use:

- `GOOGLE_SHEET_ID` - Your Google Sheet ID
- `GOOGLE_APPLICATION_CREDENTIALS` - Optional path to an Application Default Credentials or Workload Identity Federation config file
- `GOOGLE_SHEET_NAME` - Sheet name (default: `People`)
- `GOOGLE_ID_COLUMN` - ID column (default: `B`)
- `GOOGLE_EMAIL_COLUMN` - Column name or index containing emails
- `GOOGLE_GRADES_SHEET_NAME` - Tab for imported grades (default: `Import: Google Grades`). The portal matches the student’s **People** name to the **`Name`** column, shows **`Section`** as class and **`Calculated Grade`** as grade. Optional: `GOOGLE_GRADES_HEADER_ROW`, `GOOGLE_GRADES_NAME_HEADER`, `GOOGLE_GRADES_SECTION_HEADER`, `GOOGLE_GRADES_GRADE_HEADER` (use `|` for alternates).
- `GOOGLE_TEACHERS_SHEET_NAME` - Tab listing teachers (default: `Teachers`). If the signed-in **AESOP ID** matches column **`A`** (`GOOGLE_TEACHERS_ID_COLUMN`), **Category** is **Teacher** and column **`B`** (`GOOGLE_TEACHERS_CLASSES_COLUMN`) is shown as **Teaching** (classes they teach).
- **Google Classroom sync** (see [Google Classroom roles &amp; grades](#google-classroom-roles--grades) below):
  - `CLASSROOM_SYNC_ENABLED` - Set to `true` to let the portal read roles/grades from the Classroom-synced tabs (default: off).
  - `CLASSROOM_IMPERSONATE_EMAIL` - Workspace user the service account impersonates to read all courses (defaults to `GMAIL_SA_DELEGATED_USER`).
  - `CLASSROOM_ROLES_SHEET_NAME` (default `Classroom Roles`), `CLASSROOM_ROLES_EMAIL_COLUMN` (`A`), `CLASSROOM_ROLES_ROLE_COLUMN` (`B`), `CLASSROOM_ROLES_CLASSES_COLUMN` (`C`).
  - `CLASSROOM_GRADES_SHEET_NAME` (default `Classroom Grades`), `CLASSROOM_GRADES_EMAIL_COLUMN` (`A`), `CLASSROOM_GRADES_NAME_COLUMN` (`B`), `CLASSROOM_GRADES_SECTION_COLUMN` (`C`), `CLASSROOM_GRADES_GRADE_COLUMN` (`D`).
- `EMAIL_PROVIDER` - Email provider: `postmark`, `smtp`, `sendgrid`, `gmail`, or `gmailServiceAccount`
- `EMAIL_FROM` - From email address
- `POSTMARK_SERVER_TOKEN` - Postmark Server API token (if using Postmark)
- `POSTMARK_MESSAGE_STREAM` - Postmark message stream (default: `outbound`)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` - SMTP settings
- `SENDGRID_API_KEY` - If using SendGrid
- `GMAIL_USER`, `GMAIL_APP_PASSWORD` - If using Gmail
- `GMAIL_SA_DELEGATED_USER` - Workspace mailbox to impersonate (e.g. `auth@yourdomain.com`)
- `GMAIL_SA_CREDENTIALS_JSON` - Entire service account JSON as a single JSON string
- `BASE_URL` - Default base URL for magic links when `PORTAL_BASE_URL` is unset (e.g., `https://aesop-afghanistan.fly.dev` or your apex domain).
- `PORTAL_BASE_URL` - **Recommended for `portal.*` deployments.** Full origin where students should open magic links (no trailing slash), e.g. `https://portal.aesopafghanistan.org`. The app stores the signed-in student only in **sessionStorage**, which does **not** carry between different hosts (apex vs `portal.` vs `fly.dev`). If this is unset, magic links use `BASE_URL`; verifying on one host and browsing another looks “broken” (empty Ding tools).
- `PORTAL_EXTRA_HOSTS` - Optional comma-separated hostnames that should receive the portal SPA for `/`, `/profile`, and `/faq` (for hosts that do not start with `portal.`).
- **Portal Ding history** (“Date &amp; time” column): the API returns UTC **`atMs`** per row; the browser formats it with **`Intl`** in **the student’s device timezone**. Plain-text timestamps from Sheets are normalized (commas stripped). Both **`M/D/YYYY H:mm:ss`** (24-hour) and **`M/D/YYYY h:mm:ss AM/PM`** are parsed as **UTC civil time**, aligned with **`dateToGoogleSheetsSerial`** when the spreadsheet’s **display time zone** is **UTC** (common): e.g. **`6:38 PM`** in column B means **18:38 UTC**, which displays as **`~2:38 PM EDT`** on Eastern devices — **not** “6:38 PM Eastern”. To make Google Sheets itself show Eastern wall-clock (e.g. **`2:38 PM`** with Eastern formatting), set **File → Settings → Time zone** on that spreadsheet to **`(GMT-05:00) Eastern Time`**. **`luxon`** remains for spreadsheet portal-note formatting when saving Ding rows.
- `PORTAL_SPA_FALLBACK` - **Legacy.** `/profile` and `/faq` always serve the portal SPA; this variable is no longer read by the server.

### Student portal (magic links)

1. Point **`portal.yourdomain`** at the same Fly app as the main site.
2. Set **`PORTAL_BASE_URL`** to that portal origin in Fly secrets so emailed links use **`https://portal…/verify.html`**. Students stay on one origin from verify through Ding updates.
3. If magic links must stay on the apex domain, keep using **`BASE_URL`** there and use **`/portal.html`** on that same host only—do not expect a session on **`portal.*`** until you add cross-host sessions (cookies/JWT), which this app does not implement yet.

Magic-link tokens are stored **in memory** on each server instance. If Fly runs **more than one machine**, verifications can fail intermittently; keep **one machine** or replace the store with shared storage (for example Redis).

### Google Classroom roles &amp; grades

The portal can derive each person's **role** (Student or Teacher) and **grades** directly from Google Classroom instead of hand-maintaining the `Teachers` and `Import: Google Grades` tabs. Login is unchanged (students still use the magic link); Classroom data is pulled by a background sync that runs as the service account and matches Classroom accounts to the **`People`** tab **by email**.

How it works:

1. `npm run sync:classroom` signs in as the Gmail service account via **domain-wide delegation**, impersonating `CLASSROOM_IMPERSONATE_EMAIL`, and reads all **ACTIVE** courses, their teachers, students, coursework, and submissions (read-only).
2. It rewrites two email-keyed tabs in the same spreadsheet:
   - **`Classroom Roles`** - `Email`, `Role` (`Teacher` if they teach &ge;1 active course, else `Student`), `Classes Taught`.
   - **`Classroom Grades`** - `Email`, `Name`, `Section` (enrolled courses), `Calculated Grade` (overall % across graded submissions).
3. On magic-link verify, the portal looks up the signed-in email in those tabs. If `CLASSROOM_SYNC_ENABLED` is off or a row is missing, it falls back to the legacy `Teachers` (by AESOP ID) and `Import: Google Grades` (by name) tabs, so nothing breaks during the transition.

Setup:

1. **Enable the Google Classroom API** in the same Google Cloud project (APIs &amp; Services -> Library).
2. **Grant the service account read-only Classroom scopes via domain-wide delegation** (Workspace Admin Console -> Security -> API controls -> Domain-wide delegation). Use the service account's client ID and these scopes:
   - `https://www.googleapis.com/auth/classroom.courses.readonly`
   - `https://www.googleapis.com/auth/classroom.rosters.readonly`
   - `https://www.googleapis.com/auth/classroom.profile.emails`
   - `https://www.googleapis.com/auth/classroom.coursework.students.readonly`
   - `https://www.googleapis.com/auth/classroom.student-submissions.students.readonly`
3. Set `CLASSROOM_IMPERSONATE_EMAIL` to a Workspace user (usually an admin or teacher) who can see the courses, and set `CLASSROOM_SYNC_ENABLED=true`.
4. Run the sync once to populate the tabs:

```bash
npm run sync:classroom
```

5. Schedule it so roles/grades stay current. On Fly.io, create a daily scheduled Machine that reuses the app image and inherits `SECRETS_JSON`:

```bash
bash scripts/schedule-classroom-sync.sh            # daily, app aesop-afghanistan
FLY_APP=my-app SCHEDULE=hourly bash scripts/schedule-classroom-sync.sh
```

The script resolves the current deployed image, then runs `fly machine run <image> --schedule daily node scripts/sync-classroom.js`. A dedicated scheduled Machine is used (rather than in-process `node-cron`) because `fly.toml` sets `min_machines_running = 0` with `auto_stop_machines`, so the web machine sleeps when idle. Inspect with `fly machine list -a <app>`.

> The sync reuses the existing `email.gmailServiceAccount.credentials`, so no second key is needed - the service account just needs the Classroom scopes added to its delegation.

### Google Sheets Setup

1. **Create a Google Cloud Project**:
   - Go to https://console.cloud.google.com/
   - Create a new project or select an existing one

2. **Enable Google Sheets API**:
   - Navigate to "APIs & Services" → "Library"
   - Search for "Google Sheets API" and enable it

3. **Create a Service Account**:
   - Go to "APIs & Services" → "Credentials"
   - Click "Create Credentials" → "Service Account"
   - Give it a name and create it
   - Do not create or download a JSON private key

4. **Allow your local Google user to impersonate the service account**:
   - Go to IAM in Google Cloud
   - Grant your Google user the `Service Account Token Creator` role on the service account

5. **Create local Application Default Credentials**:

   ```bash
   gcloud auth application-default login \
     --impersonate-service-account=your-service-account@your-project.iam.gserviceaccount.com

   ```

6. Get Your Sheet ID:
   Open your Google Sheet
   The Sheet ID is in the URL: https://docs.google.com/spreadsheets/d/SHEET_ID_HERE/edit

7. Share the Sheet:
   Open your Google Sheet
   Click "Share" and add the service account email with "Viewer" permissions

8. Configure in secrets.json:
   {
   "googleSheets": {
   "sheetId": "your-sheet-id-here",
   "sheetName": "People",
   "idColumn": "B",
   "emailColumn": "D"
   }
   }

### Email Setup

Choose one of the following email providers:

#### Postmark (Recommended)

Verify your sending domain in Postmark (DKIM + Return-Path), create a Server, and copy its **Server API token**. Keep `gmailServiceAccount` in secrets if you use Google Sheets or Classroom sync — those features still need the service account credentials.

```json
{
  "email": {
    "provider": "postmark",
    "from": "noreply@aesopafghanistan.org",
    "postmark": {
      "serverToken": "YOUR-POSTMARK-SERVER-API-TOKEN",
      "messageStream": "outbound"
    },
    "gmailServiceAccount": {
      "delegatedUser": "auth@yourdomain.com",
      "credentials": { "...": "service account JSON for Sheets/Classroom" }
    }
  }
}
```

Test delivery locally:

```bash
node scripts/send-test-email.js you@example.com
```

#### SMTP (Generic)

```json
{
  "email": {
    "provider": "smtp",
    "from": "noreply@aesopafghanistan.org",
    "smtp": {
      "host": "smtp.example.com",
      "port": 587,
      "secure": false,
      "user": "your-email@example.com",
      "password": "your-password"
    }
  }
}
```

#### SendGrid

```json
{
  "email": {
    "provider": "sendgrid",
    "from": "noreply@aesopafghanistan.org",
    "sendgrid": {
      "apiKey": "SG.your-api-key-here"
    }
  }
}
```

#### Gmail

```json
{
  "email": {
    "provider": "gmail",
    "from": "your-email@gmail.com",
    "gmail": {
      "user": "your-email@gmail.com",
      "appPassword": "your-app-specific-password"
    }
  }
}
```

**Note**: For Gmail, you'll need to generate an [App Password](https://support.google.com/accounts/answer/185833) instead of your regular password.

#### Gmail Service Account (Workspace + Domain-Wide Delegation)

```json
{
  "email": {
    "provider": "gmailServiceAccount",
    "from": "auth@yourdomain.com",
    "gmailServiceAccount": {
      "delegatedUser": "auth@yourdomain.com",
      "credentials": {
        "type": "service_account",
        "project_id": "your-project-id",
        "private_key_id": "your-private-key-id",
        "private_key": "-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY\n-----END PRIVATE KEY-----\n",
        "client_email": "your-service-account@your-project-id.iam.gserviceaccount.com",
        "client_id": "your-client-id",
        "token_uri": "https://oauth2.googleapis.com/token"
      }
    }
  }
}
```

## Application Features

- **Magic Link Authentication**: Users enter their email and receive a secure magic link
- **Google Sheets Integration**: Email verification against a Google Sheet
- **Email Sending**: Automated magic link emails via Postmark, SMTP, SendGrid, or Gmail
- **Secure Token Generation**: Cryptographically secure magic links with 15-minute expiration
