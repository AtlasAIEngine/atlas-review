import crypto from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export function getLegacyDesktopDataDir() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  switch (process.platform) {
    case 'darwin':
      return path.join(homeDir, 'Library', 'Application Support', 'AtlasEngine');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'AtlasEngine');
    default:
      return path.join(homeDir, '.local', 'share', 'AtlasEngine');
  }
}

function getDesktopKeyPaths(appDataDir, legacyDataDir = getLegacyDesktopDataDir()) {
  return Array.from(new Set([
    path.join(appDataDir, '.encryption-key'),
    path.join(legacyDataDir, '.encryption-key'),
  ]));
}

function readExistingKeys(keyPaths) {
  return keyPaths.flatMap((keyPath) => {
    try {
      if (!fs.existsSync(keyPath)) return [];
      const key = fs.readFileSync(keyPath, 'utf8').trim();
      if (!key) return [];
      return [{ path: keyPath, key }];
    } catch (error) {
      console.warn(`Failed to read desktop encryption key at ${keyPath}:`, error.message);
      return [];
    }
  });
}

function writeKeyToPath(keyPath, key, { overwrite = false } = {}) {
  const existing = fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8').trim() : null;
  if (!overwrite && existing) return;
  if (existing === key) return;

  const keyDir = path.dirname(keyPath);
  if (!fs.existsSync(keyDir)) {
    fs.mkdirSync(keyDir, { recursive: true });
  }
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
}

function mirrorKey(keyPaths, key, { overwrite = false } = {}) {
  for (const keyPath of keyPaths) {
    writeKeyToPath(keyPath, key, { overwrite });
  }
}

function decryptWithKey(encryptedData, envKey) {
  const parts = String(encryptedData || '').split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }

  const keyBuffer = Buffer.from(String(envKey || ''), 'base64');
  if (keyBuffer.length !== KEY_LENGTH) {
    throw new Error(`Invalid key length: ${keyBuffer.length}`);
  }

  const [ivBase64, authTagBase64, ciphertext] = parts;
  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');
  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid IV length: ${iv.length}`);
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(`Invalid auth tag length: ${authTag.length}`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv);
  decipher.setAuthTag(authTag);
  let plaintext = decipher.update(ciphertext, 'base64', 'utf8');
  plaintext += decipher.final('utf8');
  return plaintext;
}

function loadEncryptedTokenSamples(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];

  let database = null;
  try {
    const Database = requireBetterSqlite3();
    database = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = database.prepare(`
      SELECT user_access_token_encrypted, access_token_encrypted, refresh_token_encrypted
      FROM github_integrations
      WHERE is_active = 1
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 10
    `).all();

    return rows.flatMap((row) => ([
      row?.user_access_token_encrypted,
      row?.access_token_encrypted,
      row?.refresh_token_encrypted,
    ].filter((value) => typeof value === 'string' && value.trim())));
  } catch (error) {
    console.warn(`Failed to inspect desktop GitHub token samples at ${dbPath}:`, error.message);
    return [];
  } finally {
    if (database) {
      try {
        database.close();
      } catch {
        // Ignore close failures during startup.
      }
    }
  }
}

let _betterSqlite3Module = null;
const require = createRequire(import.meta.url);

function requireBetterSqlite3() {
  if (_betterSqlite3Module) {
    return _betterSqlite3Module;
  }

  // Delay loading the native addon until we actually need to inspect
  // persisted encrypted tokens during startup.
  _betterSqlite3Module = require('better-sqlite3');
  return _betterSqlite3Module;
}

function findValidatedKey(existingKeys, encryptedTokenSamples) {
  for (const candidate of existingKeys) {
    const canDecryptAnySample = encryptedTokenSamples.some((sample) => {
      try {
        const plaintext = decryptWithKey(sample, candidate.key);
        return Boolean(plaintext);
      } catch {
        return false;
      }
    });
    if (canDecryptAnySample) {
      return candidate;
    }
  }
  return null;
}

export function loadDesktopEncryptionKey(appDataDir, options = {}) {
  const keyPaths = getDesktopKeyPaths(appDataDir, options.legacyDataDir);
  const existingKeys = readExistingKeys(keyPaths);
  const encryptedTokenSamples = existingKeys.length > 0
    ? loadEncryptedTokenSamples(options.dbPath)
    : [];

  if (existingKeys.length > 0 && encryptedTokenSamples.length > 0) {
    const validatedKey = findValidatedKey(existingKeys, encryptedTokenSamples);
    if (validatedKey) {
      mirrorKey(keyPaths, validatedKey.key, { overwrite: true });
      if (validatedKey.path !== keyPaths[0]) {
        console.log(`Recovered desktop encryption key from: ${validatedKey.path}`);
      }
      return validatedKey.key;
    }
  }

  if (existingKeys.length > 0) {
    const preferredKey = existingKeys.find((entry) => entry.path === keyPaths[0]) || existingKeys[0];
    mirrorKey(keyPaths, preferredKey.key, { overwrite: false });
    if (preferredKey.path !== keyPaths[0]) {
      console.log(`Reusing desktop encryption key from legacy path: ${preferredKey.path}`);
    }
    return preferredKey.key;
  }

  const key = crypto.randomBytes(KEY_LENGTH).toString('base64');
  mirrorKey(keyPaths, key, { overwrite: true });
  console.log('Generated new encryption key');
  return key;
}
