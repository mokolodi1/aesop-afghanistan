# Database & backup operations

This app caches Google Classroom data in **PostgreSQL** (Fly **Managed Postgres** recommended). Google Sheets remains a transitional dual-write target until the database path is validated.

## Provision Postgres (Fly.io)

```bash
bash scripts/provision-postgres.sh
fly secrets deploy -a aesop-afghanistan
fly deploy -a aesop-afghanistan
fly machine list -a aesop-afghanistan
fly machine exec <machine-id> -a aesop-afghanistan "sh -c 'cd /app && node db/migrate.js'"
```

Fly sets `DATABASE_URL` on the app when Managed Postgres is attached. You can also set `database.url` in `config/secrets.json` for local development.

Current production cluster: `aesop-afghanistan-mpg` in org `aesop-afghanistan-934`, region `iad`, Basic plan.

## Run migrations locally

```bash
export DATABASE_URL='postgres://user:pass@localhost:5432/aesop'
npm run db:migrate
```

## Daily Classroom sync (24h)

The sync job writes to Postgres, mirrors People/Ding data from Sheets, dual-writes Classroom tabs (unless `CLASSROOM_SHEET_DUAL_WRITE=false`), and exports admin backup JSON files.

```bash
npm run sync:classroom
```

Schedule on Fly (existing script):

```bash
bash scripts/schedule-classroom-sync.sh
```

## Backup layers

### Layer 1 — Postgres (required)

Fly **Managed Postgres** includes automatic backups, HA, and failover. Use the [Managed Postgres dashboard](https://fly.io/dashboard/aesop-afghanistan-934/managed_postgres) for restore operations.

**Restore from backup**

1. Restore via `fly mpg restore` or the Fly dashboard
2. Attach the restored cluster: `fly mpg attach <cluster-id> -a aesop-afghanistan`
3. Run migrations if needed: `node db/migrate.js`
4. Re-run sync if data is stale: `npm run sync:classroom`

### Layer 2 — Post-sync JSON exports

After each successful sync, the app writes:

| File | Contents |
|------|----------|
| `grades-*.json` | Student course grades with AESOP IDs |
| `rosters-*.json` | Per-course teacher/student lists |
| `sync-manifest-*.json` | Sync counts, timestamps, errors |

**Local (default):** `data/backups/` in the sync container filesystem.

**S3 / Fly Tigris (recommended for production):** set secrets:

```bash
fly secrets set -a aesop-afghanistan \
  BACKUP_EXPORT_PROVIDER=tigris \
  BACKUP_S3_BUCKET=your-bucket \
  BACKUP_S3_ENDPOINT=https://fly.storage.tigris.dev \
  BACKUP_S3_REGION=auto \
  BACKUP_S3_ACCESS_KEY_ID=... \
  BACKUP_S3_SECRET_ACCESS_KEY=...
```

The latest export key is shown on the admin **Overview** tab (`backupExportKey`).

### Layer 3 — Google Sheets dual-write

While `CLASSROOM_SHEET_DUAL_WRITE` is not `false`, sync continues updating **Classroom Roles** and **Classroom Grades** tabs. If Postgres is unavailable, portal reads fall back to Sheets via existing `googleSheets.js` helpers.

## Rebuild from JSON snapshots (manual)

If Postgres is empty but snapshot files exist:

1. Restore Postgres from Fly backup **or** provision a fresh cluster
2. Run `node db/migrate.js`
3. Run `npm run sync:classroom` — this repopulates from Google Classroom (preferred)

JSON snapshots are primarily for **admin reporting archives** and audit; they are not auto-imported. To rebuild solely from snapshots, contact ops to run a one-off import script against `grades-*.json` and `rosters-*.json`.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection string |
| `DATABASE_SSL` | Set to `false` for local Postgres without SSL |
| `CLASSROOM_SHEET_DUAL_WRITE` | `false` to stop writing Classroom tabs (default: dual-write on) |
| `BACKUP_EXPORT_ENABLED` | `false` to skip snapshot exports |
| `BACKUP_EXPORT_PROVIDER` | `local`, `s3`, or `tigris` |
| `BACKUP_S3_*` | Object storage credentials for off-site exports |

## Health check

```
GET /api/health
```

Returns `{ ok, database: { enabled, ok }, classroomEnabled }`.

## Schema overview

- `sync_runs` — sync job audit log
- `people` — AESOP IDs, emails, portal roles (Classroom + People mirror)
- `courses`, `course_enrollments`, `course_grades`, `assignments`, `assignment_grades` — Classroom cache
- `ding_numbers`, `ding_change_history`, `ding_topups` — Ding mirror and future DingConnect automation audit
