import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(process.execPath, ['server-desktop.js'], { cwd: `${root}/backend`, stdio: 'inherit', env: process.env }),
  spawn(npm, ['run', 'dev', '--', '--host', '127.0.0.1'], { cwd: `${root}/frontend`, stdio: 'inherit', shell: process.platform === 'win32' }),
];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code || 0));
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
