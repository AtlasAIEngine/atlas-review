import { spawnSync } from 'node:child_process';
if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Use Node.js 22 (see .nvmrc).');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const dir of ['.', 'backend', 'frontend', 'mcp-review-server', 'apps/desktop']) {
  const result = spawnSync(npm, ['ci'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const result = spawnSync(npm, ['run', 'build'], { cwd: 'mcp-review-server', stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status || 0);
