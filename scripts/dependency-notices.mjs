import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const base = 'apps/desktop/src-tauri/resources';
const packages = [];
function visit(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    const pkgPath = join(path, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const licenses = readdirSync(path).filter(name => /^(?:LICEN[CS]E|COPYING|NOTICE)(?:$|[.\-_])/i.test(name))
        .filter(name => { try { return !readdirSync(join(path,name)); } catch { return true; } })
        .map(name => ({ file: name, text: readFileSync(join(path,name), 'utf8') }));
      packages.push({name:pkg.name,version:pkg.version,license:pkg.license ?? 'SEE PACKAGE LICENSE',repository:pkg.repository,notices:licenses});
    }
    if (entry.name.startsWith('@')) visit(path);
    visit(join(path,'node_modules'));
  }
}
for (const sub of ['backend','mcp-review-server']) visit(join(base,sub,'node_modules'));
visit('frontend/node_modules');
writeFileSync(join(base,'DEPENDENCY_NOTICES.json'),JSON.stringify({packages},null,2)+'\n');
console.log(`Collected ${packages.length} production dependency notices.`);
