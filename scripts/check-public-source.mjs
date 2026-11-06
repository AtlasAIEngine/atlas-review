import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = files.filter(path => /(^|\/)(?:\.env(?:\..*)?|\.encryption-key|\.tauri_updater_key)$/.test(path) && !/\.example$/.test(path));
for (const path of files) {
  if (/\.(?:pem|p12|pfx|sqlite3?|db)(?:-(?:wal|shm|journal))?$/.test(path)) forbidden.push(path);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(readFileSync(path, 'utf8'))) forbidden.push(path);
}
if (forbidden.length) throw new Error(`Forbidden public files: ${[...new Set(forbidden)].join(', ')}`);
console.log(`Checked ${files.length} tracked public files.`);
