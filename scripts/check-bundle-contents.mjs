import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = 'apps/desktop/src-tauri/resources';
const failures = [];
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { visit(path); continue; }
    if (/^\.env(?:\.|$)/.test(entry.name) || /(?:^\.encryption-key$|^\.tauri_updater_key$|\.(?:pem|p12|pfx|db|sqlite3?)(?:-(?:wal|shm|journal))?$)/.test(entry.name)) failures.push(path);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(readFileSync(path, 'utf8'))) failures.push(path);
  }
}
visit(root);
if (failures.length) throw new Error(`Sensitive bundle contents: ${failures.join(', ')}`);
console.log('Bundled source sensitive-file checks passed.');
