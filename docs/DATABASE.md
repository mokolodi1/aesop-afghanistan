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

**Rebuild `people` from scratch** (truncates `people` and FK-linked rows, then imports the full People sheet):

```bash
npm run db:rebuild-people -- --dry-run
npm run db:rebuild-people
npm run sync:hourly-cache   # repopulate Ding mirror after rebuild
```

## Hourly Postgres cache

Postgres is the **read cache** for the portal and admin UI. A background job refreshes it; the app serves from DB when data is **fresh**, and falls back to Google Sheets / Classroom API when stale.

### TTL (default: 1 hour)

| Variable | Example | Purpose |
|----------|---------|---------|
| `MIRROR_CACHE_TTL_HOURS` | `1` | Human-friendly cache TTL |
| `MIRROR_CACHE_MAX_AGE_MS` | `3600000` | Cache TTL in milliseconds |
| `PORTAL_MIRROR_MAX_AGE_MS` | `3600000` | Legacy alias for the same TTL |

Freshness is checked per domain:

- **People** — row `synced_at` on `people`
- **Applicants + Drive** — row `synced_at` on `applicants` (includes Drive file metadata)
- **Classroom** — last successful `sync_runs.finished_at` (rosters, grades, enrollments)

When cache is stale, reads fall back to live Sheets/Classroom (slower but current).

### Refresh the cache (hourly on Fly)

All scheduled syncs are defined in the repo's `crontab` and run by Supercronic on the `cron` process group Machine (see `[processes]` in `fly.toml` and `scripts/cron-server.js`). They deploy with the app image on every `fly deploy` — no manual scheduling scripts.

Every run — scheduled or admin-triggered — goes through `scripts/run-job.js`, which records it in the **`job_runs`** table (status, duration, trigger, result summary, and captured console logs, pruned to the last 100 runs per job). Job definitions live in `services/jobRegistry.js`; the admin portal's **Jobs tab** lists each job with its last run, run history, logs, and a **Run now** button.

On-demand runs from the Jobs tab are forwarded to the cron Machine over Fly private networking (`cron.process.<app>.internal`, port `CRON_TRIGGER_PORT`, default 3100), so heavy syncs run on the 1GB cron Machine instead of a 512MB web Machine. The trigger returns a `job_runs` id immediately and the UI polls for progress. If the cron Machine is unreachable (e.g. local dev), the web process spawns the job locally instead.

**Hourly job** (every hour on the hour, Afghanistan time / Asia/Kabul, except 2:00 AM and 4:00 AM when the daily jobs below run instead) — People, current Ding numbers, **Applicants**, **ApplicantReviews**, and **Google Drive** voice memo metadata:

```bash
npm run sync:hourly-cache
```

This runs `mirrorPeopleAndDingFromSheets()` every hour (without full Ding change history):

| Source | Postgres `people` columns |
|--------|---------------------------|
| People tab | `aesop_id`, `name`, `email`, `phone`, `people_type`, `admin_role`, `people_status`, `last_login`, `past_ding`, `reviewer_role`, `portal_role` (derived), `sheet_row` (full header→value JSON) |

Other hourly mirrors:

| Source | Postgres tables |
|--------|-----------------|
| Ding changes tab (current values only) | `ding_numbers` |
| Applicants tab | `applicants` |
| ApplicantReviews tab | `applicant_reviews` |
| Google Drive folder | `applicants.drive_file_id`, `drive_file_name`, `drive_duration_seconds` (length is read from the sheet's `Voice memo length (secs)` column when its Voice note link matches the current Drive file; Drive is only probed for missing/changed files) |

Google Classroom is **not** included in the hourly job by default (too heavy). Keep Classroom on a daily schedule (below). To also run Classroom hourly, set `HOURLY_CACHE_INCLUDE_CLASSROOM=true` in `fly.toml` `[env]`.

**Daily jobs** (see `crontab`) — voice memo sync at **2:00 AM** Afghanistan time; Classroom sync (rosters, grades, enrollments + sheet dual-write + backup export, and **Ding change history**) at **4:00 AM** Afghanistan time:

```bash
npm run sync:classroom
```

**People vs Classroom:** the hourly job owns the `people` table (from the **People** sheet). Classroom sync only writes `courses`, enrollments, and grades, and links them to emails that already exist in `people`. It does **not** create people rows for Classroom-only emails without a People sheet row. Run `sync:hourly-cache` before `sync:classroom` when both are due.

**Shared emails:** multiple `people` rows may share the same email and/or name. Only `aesop_id` is unique (when set). Rows without an AESOP ID are tracked by sheet row number.

### Monitor cache age

```
GET /api/health
```

Response includes `mirrorCache` with `classroom`, `people`, and `applicants` freshness vs `maxAgeMs`.

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
| `MIRROR_CACHE_TTL_HOURS` | Postgres read cache TTL in hours (default `1`) |
| `MIRROR_CACHE_MAX_AGE_MS` | Same TTL in milliseconds (overrides hours when set) |
| `PORTAL_MIRROR_MAX_AGE_MS` | Legacy alias for mirror cache TTL |
| `HOURLY_CACHE_INCLUDE_CLASSROOM` | `true` to run Google Classroom sync inside hourly job (default off) |
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

- `sync_runs` — Classroom sync audit log (legacy; superseded by `job_runs` for the Jobs tab)
- `job_runs` — one row per sync job run (scheduled or admin-triggered) with status, result summary, and captured logs
- `people` — AESOP IDs, emails, portal roles (**People sheet mirror only**; Classroom sync links by email)
- `courses`, `course_enrollments`, `course_grades`, `assignments`, `assignment_grades` — Classroom cache
- `ding_numbers`, `ding_change_history`, `ding_topups` — Ding mirror and future DingConnect automation audit
