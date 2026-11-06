import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDesktopEncryptionKey } from '../desktopEncryptionKey.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

function encryptWithKey(plaintext, envKey) {
  const keyBuffer = Buffer.from(envKey, 'base64');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);
  let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
  ciphertext += cipher.final('base64');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext}`;
}

function createGitHubIntegrationDb(dbPath, encryptedToken) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE github_integrations (
      id TEXT PRIMARY KEY,
      is_active INTEGER NOT NULL,
      user_access_token_encrypted TEXT,
      access_token_encrypted TEXT,
      refresh_token_encrypted TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO github_integrations (
      id, is_active, user_access_token_encrypted, access_token_encrypted,
      refresh_token_encrypted, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?)
  `).run(
    'integration-1',
    encryptedToken,
    encryptedToken,
    null,
    now,
    now
  );
  db.close();
}

describe('loadDesktopEncryptionKey', () => {
  const tempDirs = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it('recovers the decryptable legacy key and overwrites a bad current key', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-desktop-key-'));
    tempDirs.push(rootDir);

    const appDataDir = path.join(rootDir, 'current');
    const legacyDataDir = path.join(rootDir, 'legacy');
    fs.mkdirSync(appDataDir, { recursive: true });
    fs.mkdirSync(legacyDataDir, { recursive: true });

    const wrongCurrentKey = crypto.randomBytes(32).toString('base64');
    const validLegacyKey = crypto.randomBytes(32).toString('base64');
    fs.writeFileSync(path.join(appDataDir, '.encryption-key'), wrongCurrentKey, 'utf8');
    fs.writeFileSync(path.join(legacyDataDir, '.encryption-key'), validLegacyKey, 'utf8');

    const dbPath = path.join(appDataDir, 'atlas.db');
    createGitHubIntegrationDb(dbPath, encryptWithKey('desktop-user-token', validLegacyKey));

    const resolved = loadDesktopEncryptionKey(appDataDir, { dbPath, legacyDataDir });

    expect(resolved).toBe(validLegacyKey);
    expect(fs.readFileSync(path.join(appDataDir, '.encryption-key'), 'utf8').trim()).toBe(validLegacyKey);
    expect(fs.readFileSync(path.join(legacyDataDir, '.encryption-key'), 'utf8').trim()).toBe(validLegacyKey);
  });

  it('generates a new key when neither location exists', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-desktop-key-'));
    tempDirs.push(rootDir);

    const appDataDir = path.join(rootDir, 'current');
    const legacyDataDir = path.join(rootDir, 'legacy');
    const resolved = loadDesktopEncryptionKey(appDataDir, { legacyDataDir });

    expect(resolved).toBeTruthy();
    expect(Buffer.from(resolved, 'base64')).toHaveLength(32);
    expect(fs.existsSync(path.join(appDataDir, '.encryption-key'))).toBe(true);
    expect(fs.existsSync(path.join(legacyDataDir, '.encryption-key'))).toBe(true);
  });
});
