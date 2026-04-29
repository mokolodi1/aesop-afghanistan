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
- `EMAIL_PROVIDER` - Email provider: `smtp`, `sendgrid`, `gmail`, or `gmailServiceAccount`
- `EMAIL_FROM` - From email address
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` - SMTP settings
- `SENDGRID_API_KEY` - If using SendGrid
- `GMAIL_USER`, `GMAIL_APP_PASSWORD` - If using Gmail
- `GMAIL_SA_DELEGATED_USER` - Workspace mailbox to impersonate (e.g. `auth@yourdomain.com`)
- `GMAIL_SA_CREDENTIALS_JSON` - Entire service account JSON as a single JSON string
- `BASE_URL` - Base URL for magic links (e.g., `https://aesop-afghanistan.fly.dev`)

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
- **Email Sending**: Automated magic link emails via SMTP, SendGrid, or Gmail
- **Secure Token Generation**: Cryptographically secure magic links with 15-minute expiration
