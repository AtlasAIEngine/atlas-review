import fs from 'fs';
import os from 'os';
import path from 'path';
import db from '../db/index.js';
import { getPendingMigrations } from '../db/migrations/index.js';

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function main() {
  process.env.ATLAS_DB_TYPE = process.env.ATLAS_DB_TYPE || 'sqlite';

  let tempRoot = null;
  if (!process.env.ATLAS_DB_PATH) {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bootstrap-verify-'));
    process.env.ATLAS_DB_PATH = path.join(tempRoot, 'atlas.db');
    console.log(`No ATLAS_DB_PATH provided, using temporary SQLite DB: ${process.env.ATLAS_DB_PATH}`);
  }

  const initialized = await db.initialize();
  if (!initialized) {
    fail('Fresh-install bootstrap failed: database initialization returned false.');
    return;
  }

  const { rows } = await db.query(
    'SELECT version, description FROM schema_version ORDER BY version'
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    fail(
      `Expected launch migrations in schema_version, found ${rows?.length ?? 0}.`
    );
    return;
  }

  const [{ version, description }] = rows;
  if (Number(version) !== 1 || String(description || '').trim() !== 'pre_release_baseline') {
    fail(
      `Unexpected launch baseline marker: version=${String(version)} description=${String(description)}`
    );
    return;
  }

  const pending = await getPendingMigrations(db);
  if (pending.length > 0) throw new Error(`Unapplied migrations: ${pending.length}`);
  const initializedAgain = await db.initialize();
  if (!initializedAgain) throw new Error('Repeat initialization failed');
  const after = await db.query('SELECT version FROM schema_version ORDER BY version');
  if (after.rows.length !== rows.length) throw new Error('Repeat initialization changed the migration ledger');
  console.log('Fresh-install bootstrap and repeat initialization verified.');
  console.log(
    JSON.stringify(
      {
        dbType: db.getDbType(),
        schemaVersion: Number(version),
        description: String(description),
      },
      null,
      2
    )
  );

  if (tempRoot) {
    console.log(`Temporary verification DB root: ${tempRoot}`);
  }
}

main()
  .catch((error) => {
    fail(`Fresh-install bootstrap verification failed: ${error?.stack || error?.message || String(error)}`);
  })
  .finally(async () => {
    try {
      await db.close();
    } catch {
      // Best effort close for CLI usage.
    }
    try {
      const dbPath = process.env.ATLAS_DB_PATH || '';
      const tempRoot = dbPath ? path.dirname(dbPath) : '';
      if (tempRoot && path.basename(tempRoot).startsWith('atlas-bootstrap-verify-')) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    } catch {
      // Best effort cleanup for temp verification DBs.
    }
  });
