const fs = require("fs");
const path = require("path");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const config = require("../config/secrets");
const { exportSnapshotFromDb, isDatabaseEnabled } = require("./classroomDb");

function getBackupConfig() {
  const file = config.backup || {};
  const envOr = (envKey, fileKey, fallback = "") => {
    const fromEnv = process.env[envKey];
    if (fromEnv != null && String(fromEnv).trim() !== "") {
      return String(fromEnv).trim();
    }
    const fromFile = file[fileKey];
    if (fromFile != null && String(fromFile).trim() !== "") {
      return String(fromFile).trim();
    }
    return fallback;
  };

  return {
    enabled: envOr("BACKUP_EXPORT_ENABLED", "enabled", "true").toLowerCase() !== "false",
    provider: envOr("BACKUP_EXPORT_PROVIDER", "provider", "local"),
    bucket: envOr("BACKUP_S3_BUCKET", "bucket", ""),
    prefix: envOr("BACKUP_S3_PREFIX", "prefix", "classroom-sync"),
    region: envOr("BACKUP_S3_REGION", "region", "auto"),
    endpoint: envOr("BACKUP_S3_ENDPOINT", "endpoint", ""),
    accessKeyId: envOr("BACKUP_S3_ACCESS_KEY_ID", "accessKeyId", ""),
    secretAccessKey: envOr("BACKUP_S3_SECRET_ACCESS_KEY", "secretAccessKey", ""),
    localDir: envOr("BACKUP_LOCAL_DIR", "localDir", path.join(process.cwd(), "data", "backups")),
  };
}

function stampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function buildExportBundle(snapshot) {
  const stamp = stampForFilename();
  return {
    stamp,
    gradesKey: `grades-${stamp}.json`,
    rostersKey: `rosters-${stamp}.json`,
    manifestKey: `sync-manifest-${stamp}.json`,
    gradesBody: JSON.stringify(
      {
        exportedAt: snapshot.exportedAt,
        grades: snapshot.grades,
      },
      null,
      2,
    ),
    rostersBody: JSON.stringify(
      {
        exportedAt: snapshot.exportedAt,
        rosters: snapshot.rosters,
      },
      null,
      2,
    ),
    manifestBody: JSON.stringify(
      {
        exportedAt: snapshot.exportedAt,
        manifest: snapshot.manifest,
        syncRun: snapshot.syncRun,
      },
      null,
      2,
    ),
  };
}

async function writeLocalBackup(bundle, backupConfig) {
  const dir = path.resolve(backupConfig.localDir);
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    [bundle.gradesKey, bundle.gradesBody],
    [bundle.rostersKey, bundle.rostersBody],
    [bundle.manifestKey, bundle.manifestBody],
  ];
  for (const [name, body] of files) {
    fs.writeFileSync(path.join(dir, name), body, "utf8");
  }
  return {
    provider: "local",
    basePath: dir,
    manifestKey: bundle.manifestKey,
    keys: files.map(([name]) => name),
  };
}

async function writeS3Backup(bundle, backupConfig) {
  if (!backupConfig.bucket) {
    throw new Error("BACKUP_S3_BUCKET is required for S3/Tigris backup exports.");
  }

  const client = new S3Client({
    region: backupConfig.region,
    endpoint: backupConfig.endpoint || undefined,
    forcePathStyle: !!backupConfig.endpoint,
    credentials:
      backupConfig.accessKeyId && backupConfig.secretAccessKey
        ? {
            accessKeyId: backupConfig.accessKeyId,
            secretAccessKey: backupConfig.secretAccessKey,
          }
        : undefined,
  });

  const uploads = [
    [bundle.gradesKey, bundle.gradesBody],
    [bundle.rostersKey, bundle.rostersBody],
    [bundle.manifestKey, bundle.manifestBody],
  ];

  const keys = [];
  for (const [name, body] of uploads) {
    const key = `${backupConfig.prefix}/${name}`;
    await client.send(
      new PutObjectCommand({
        Bucket: backupConfig.bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
      }),
    );
    keys.push(key);
  }

  return {
    provider: backupConfig.provider,
    bucket: backupConfig.bucket,
    manifestKey: `${backupConfig.prefix}/${bundle.manifestKey}`,
    keys,
  };
}

/**
 * Export post-sync admin snapshots to local disk and/or S3-compatible storage.
 * @param {number|null} syncRunId
 */
async function exportSyncBackup(syncRunId = null) {
  if (!isDatabaseEnabled()) {
    return { skipped: true, reason: "database_disabled" };
  }

  const backupConfig = getBackupConfig();
  if (!backupConfig.enabled) {
    return { skipped: true, reason: "backup_disabled" };
  }

  const snapshot = await exportSnapshotFromDb();
  if (!snapshot) {
    return { skipped: true, reason: "empty_snapshot" };
  }

  const bundle = buildExportBundle(snapshot);
  const results = [];

  results.push(await writeLocalBackup(bundle, backupConfig));

  if (
    backupConfig.provider === "s3" ||
    backupConfig.provider === "tigris" ||
    backupConfig.bucket
  ) {
    try {
      results.push(await writeS3Backup(bundle, backupConfig));
    } catch (error) {
      console.warn("[backup] S3 export failed:", error.message);
      results.push({ provider: backupConfig.provider, error: error.message });
    }
  }

  return {
    skipped: false,
    syncRunId,
    manifestKey: results.find((entry) => entry.manifestKey)?.manifestKey || bundle.manifestKey,
    results,
  };
}

module.exports = {
  getBackupConfig,
  exportSyncBackup,
};
