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
   After your first deployment, set the required secrets:
   ```bash
   flyctl secrets set GOOGLE_SHEET_ID=your-sheet-id
   flyctl secrets set GOOGLE_CLIENT_EMAIL=your-service-account@project.iam.gserviceaccount.com
   flyctl secrets set GOOGLE_PRIVATE_KEY="$(cat path/to/private-key.pem)"
   flyctl secrets set EMAIL_PROVIDER=smtp
   flyctl secrets set SMTP_HOST=smtp.example.com
   flyctl secrets set SMTP_USER=your-email@example.com
   flyctl secrets set SMTP_PASSWORD=your-password
   flyctl secrets set EMAIL_FROM=noreply@aesopafghanistan.org
   ```
   See the Configuration section below for all available environment variables.

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

This application requires configuration for Google Sheets and email services. You can configure these in two ways:

#### Option 1: Using `config/secrets.json` (Recommended for local development)

1. Copy the example file:
   ```bash
   cp config/secrets.example.json config/secrets.json
   ```

2. Edit `config/secrets.json` with your credentials (see sections below)

#### Option 2: Using Environment Variables (Recommended for production/Fly.io)

Set the following environment variables in Fly.io:
- `GOOGLE_SHEET_ID` - Your Google Sheet ID
- `GOOGLE_CLIENT_EMAIL` - Service account email
- `GOOGLE_PRIVATE_KEY` - Service account private key
- `GOOGLE_SHEET_INDEX` - Sheet index (default: 0)
- `GOOGLE_EMAIL_COLUMN` - Column name or index containing emails
- `EMAIL_PROVIDER` - Email provider: `smtp`, `sendgrid`, or `gmail`
- `EMAIL_FROM` - From email address
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` - SMTP settings
- `SENDGRID_API_KEY` - If using SendGrid
- `GMAIL_USER`, `GMAIL_APP_PASSWORD` - If using Gmail
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
   - Click on the service account → "Keys" tab → "Add Key" → "Create new key" → JSON
   - Download the JSON file

4. **Get Your Sheet ID**:
   - Open your Google Sheet
   - The Sheet ID is in the URL: `https://docs.google.com/spreadsheets/d/SHEET_ID_HERE/edit`

5. **Share the Sheet**:
   - Open your Google Sheet
   - Click "Share" and add the service account email (from the JSON file) with "Viewer" permissions

6. **Configure in secrets.json**:
   ```json
   {
     "googleSheets": {
       "sheetId": "your-sheet-id-here",
       "clientEmail": "service-account@project-id.iam.gserviceaccount.com",
       "privateKey": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----",
       "sheetIndex": 0,
       "emailColumn": 0
     }
   }
   ```
   - Copy the `private_key` from the downloaded JSON (keep the `\n` characters)
   - `sheetIndex`: Which sheet tab to use (0 = first sheet)
   - `emailColumn`: Column name (string) or index (number) containing email addresses

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

## Application Features

- **Magic Link Authentication**: Users enter their email and receive a secure magic link
- **Google Sheets Integration**: Email verification against a Google Sheet
- **Email Sending**: Automated magic link emails via SMTP, SendGrid, or Gmail
- **Secure Token Generation**: Cryptographically secure magic links with 15-minute expiration
