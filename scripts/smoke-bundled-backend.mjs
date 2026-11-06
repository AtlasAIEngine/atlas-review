import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const target = process.platform === 'win32' ? 'x86_64-pc-windows-msvc.exe' : process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const profile = mkdtempSync(join(tmpdir(),'atlas-review-bundle-smoke-'));
const node = resolve('apps/desktop/src-tauri/binaries',`node-${target}`);
const cwd = resolve('apps/desktop/src-tauri/resources/backend');
const child = spawn(node,['server-desktop.js'],{cwd,env:{...process.env,ATLAS_DATA_DIR:profile,PORT:'0',ATLAS_DISABLE_CLI_PROVIDER_DETECTION:'true',ATLAS_REVIEW_SYNC_SERVER_URL:''},stdio:['ignore','pipe','pipe']});
let logs='';let spawnError=null;
child.stdout.on('data',data=>{logs+=data;});
child.stderr.on('data',data=>{logs+=data;});
child.on('error',error=>{spawnError=error;});
try {
  const deadline=Date.now()+45000;
  let healthy=false;
  while(Date.now()<deadline) {
    if(spawnError) throw spawnError;
    if(child.exitCode!==null) throw new Error(`Bundled backend exited with ${child.exitCode}`);
    const port=logs.match(/BACKEND_PORT=(\d+)/)?.[1];
    if(port) {
      try {
        const response=await fetch(`http://127.0.0.1:${port}/health`);
        const body=await response.json();
        if(response.ok && body.status==='ok' && body.database==='connected') { healthy=true;break; }
      } catch {}
    }
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!healthy) throw new Error('Bundled backend did not become healthy.');
  console.log('Bundled Node.js, native dependencies, SQLite initialization, and backend health passed.');
} catch(error) {
  console.error(logs.slice(-4000));
  throw error;
} finally {
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.kill();
  await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);
  try { rmSync(profile,{recursive:true,force:true}); } catch {}
}
