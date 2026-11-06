import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readDiscoveryEntry,
  resolveDesktopDataDir,
  resolveDiscoveryFilePath,
} from '../dist/src/desktopDiscovery.js';

async function makeTempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function writeEntry(filePath, entry) {
  fs.writeFileSync(filePath, JSON.stringify(entry), 'utf8');
}

const BASE_ENTRY = {
  schemaVersion: 1,
  host: '127.0.0.1',
  port: 52779,
  pid: process.pid,
  startedAt: '2026-04-17T10:34:00.000Z',
  appVersion: '0.24.6',
};

test('readDiscoveryEntry returns null when the file is missing', async (t) => {
  const dir = await makeTempDir('atlas-discovery-missing-');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const result = readDiscoveryEntry({ dataDir: dir });
  assert.equal(result, null);
});

test('readDiscoveryEntry returns the entry + URL when the file is valid', async (t) => {
  const dir = await makeTempDir('atlas-discovery-valid-');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const filePath = path.join(dir, 'backend-port.json');
  writeEntry(filePath, BASE_ENTRY);

  const result = readDiscoveryEntry({ dataDir: dir });
  assert.ok(result, 'expected a result');
  assert.equal(result.source, 'discovery');
  assert.equal(result.url, 'http://127.0.0.1:52779/api');
  assert.equal(result.entry.port, 52779);
  assert.equal(result.entry.host, '127.0.0.1');
  assert.equal(result.path, filePath);
});

test('readDiscoveryEntry returns null for malformed JSON', async (t) => {
  const dir = await makeTempDir('atlas-discovery-malformed-');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'backend-port.json'), '{not-json', 'utf8');

  assert.equal(readDiscoveryEntry({ dataDir: dir }), null);
});

test('readDiscoveryEntry returns null for unsupported schema version', async (t) => {
  const dir = await makeTempDir('atlas-discovery-schema-');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  writeEntry(path.join(dir, 'backend-port.json'), { ...BASE_ENTRY, schemaVersion: 99 });

  assert.equal(readDiscoveryEntry({ dataDir: dir }), null);
});

test('readDiscoveryEntry rejects invalid port values', async (t) => {
  const dir = await makeTempDir('atlas-discovery-port-');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  for (const badPort of [0, -1, 65_536, 'abc', null, undefined]) {
    writeEntry(path.join(dir, 'backend-port.json'), { ...BASE_ENTRY, port: badPort });
    assert.equal(readDiscoveryEntry({ dataDir: dir }), null, `port=${badPort} should be rejected`);
  }
});

test('readDiscoveryEntry treats dead pid as stale and returns null', async (t) => {
  const dir = await makeTempDir('atlas-discovery-deadpid-');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  writeEntry(path.join(dir, 'backend-port.json'), { ...BASE_ENTRY, pid: 999_999_999 });

  // Use a custom isProcessAlive to simulate the pid being dead without relying
  // on platform behavior for arbitrary pids.
  const result = readDiscoveryEntry({
    dataDir: dir,
    isProcessAlive: () => false,
  });
  assert.equal(result, null);
});

test('readDiscoveryEntry honors ATLAS_DESKTOP_DATA_DIR override', async (t) => {
  const dir = await makeTempDir('atlas-discovery-override-');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  writeEntry(path.join(dir, 'backend-port.json'), BASE_ENTRY);

  const result = readDiscoveryEntry({ env: { ATLAS_DESKTOP_DATA_DIR: dir } });
  assert.ok(result);
  assert.equal(result.url, 'http://127.0.0.1:52779/api');
});

test('resolveDesktopDataDir computes macOS path', () => {
  const dir = resolveDesktopDataDir({
    platform: 'darwin',
    homedir: '/Users/test',
    env: {},
  });
  assert.equal(dir, '/Users/test/Library/Application Support/com.atlasengine.desktop');
});

test('resolveDesktopDataDir computes Linux path with XDG_DATA_HOME', () => {
  const dir = resolveDesktopDataDir({
    platform: 'linux',
    homedir: '/home/test',
    env: { XDG_DATA_HOME: '/home/test/.local/xdg' },
  });
  assert.equal(dir, '/home/test/.local/xdg/com.atlasengine.desktop');
});

test('resolveDesktopDataDir computes Linux path without XDG_DATA_HOME', () => {
  const dir = resolveDesktopDataDir({
    platform: 'linux',
    homedir: '/home/test',
    env: {},
  });
  assert.equal(dir, '/home/test/.local/share/com.atlasengine.desktop');
});

test('resolveDesktopDataDir computes Windows path with APPDATA', () => {
  const dir = resolveDesktopDataDir({
    platform: 'win32',
    homedir: 'C:\\Users\\test',
    env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
  });
  assert.equal(dir, path.join('C:\\Users\\test\\AppData\\Roaming', 'com.atlasengine.desktop'));
});

test('resolveDiscoveryFilePath appends the file name', () => {
  const filePath = resolveDiscoveryFilePath({
    platform: 'darwin',
    homedir: '/Users/test',
    env: {},
  });
  assert.equal(
    filePath,
    '/Users/test/Library/Application Support/com.atlasengine.desktop/backend-port.json'
  );
});
