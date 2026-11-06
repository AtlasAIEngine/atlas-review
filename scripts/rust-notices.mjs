import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
const metadata=JSON.parse(execFileSync('cargo',['metadata','--locked','--format-version','1','--manifest-path','apps/desktop/src-tauri/Cargo.toml'],{encoding:'utf8',maxBuffer:50*1024*1024}));
const packages=metadata.packages.map(pkg=> {
  const root=dirname(pkg.manifest_path);
  const files=readdirSync(root).filter(name=>/^(?:LICEN[CS]E|COPYING|NOTICE)(?:$|[.\-_])/i.test(name));
  return {name:pkg.name,version:pkg.version,license:pkg.license,repository:pkg.repository,notices:files.filter(name=>statSync(join(root,name)).isFile()).map(name=>({file:name,text:readFileSync(join(root,name),'utf8')}))};
});
writeFileSync('apps/desktop/src-tauri/resources/RUST_DEPENDENCY_NOTICES.json',JSON.stringify({packages},null,2)+'\n');
console.log(`Collected ${packages.length} Rust package notices.`);
