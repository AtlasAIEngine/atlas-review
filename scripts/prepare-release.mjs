import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const tag=process.env.GITHUB_REF_NAME;
const version=tag.slice(1);
const repo=process.env.GH_REPO;
const dir='release-artifacts';
if (!/^v\d+\.\d+\.\d+(?:-(?:beta|alpha|rc)\.\d+)?$/.test(tag)) throw new Error('Invalid release tag.');
const names=[`AtlasEngine-${version}-macos-aarch64.dmg`,`AtlasEngine-${version}-macos-x86_64.zip`,`AtlasEngine-${version}-windows-x64-setup.exe`,`AtlasEngine-${version}-windows-x64.msi`,`AtlasEngine_${version}_aarch64.app.tar.gz`,`AtlasEngine_${version}_x86_64.app.tar.gz`];
for(const name of names) if(!readFileSync(join(dir,name)).length) throw new Error(`Empty artifact ${name}`);
for(const name of names.filter(n=>n.endsWith('.tar.gz')||n.endsWith('-setup.exe'))) {
 if(!readFileSync(join(dir,name+'.sig'),'utf8').trim()) throw new Error(`Missing signature ${name}`);
}
for(const [source,dest] of [[names[0],'AtlasReview-macos-aarch64.dmg'],[names[1],'AtlasReview-macos-x86_64.zip'],[names[2],'AtlasReview-windows-x64-setup.exe'],[names[3],'AtlasReview-windows-x64.msi']]) copyFileSync(join(dir,source),join(dir,dest));
const beta=version.includes('-');
const channel=beta?'beta':'stable';
execFileSync(process.execPath,['scripts/generate-update-manifest.js','--version',version,'--channel',channel,'--github-release-url',`https://github.com/${repo}/releases/download/${tag}`,'--artifacts',dir,'--output-dir',dir],{stdio:'inherit'});
const manifest=JSON.parse(readFileSync(join(dir,channel+'.json'),'utf8'));
for(const platform of ['darwin-aarch64','darwin-x86_64','windows-x86_64']) {
 if(!manifest.platforms[platform]?.signature || !manifest.platforms[platform]?.url) throw new Error(`Missing updater platform ${platform}`);
}
writeFileSync(join(dir,'SOURCE.json'),JSON.stringify({repository:repo,tag,commit:process.env.GITHUB_SHA,workflow_run:process.env.GITHUB_RUN_ID},null,2)+'\n');
const hashes=readdirSync(dir).sort().filter(n=>n!=='SHA256SUMS').map(name=>`${createHash('sha256').update(readFileSync(join(dir,name))).digest('hex')}  ${name}`);
writeFileSync(join(dir,'SHA256SUMS'),hashes.join('\n')+'\n');
writeFileSync('release-notes.md',`Atlas Review ${tag}\n\nSource commit: ${process.env.GITHUB_SHA}\n\n[Windows x64](https://github.com/${repo}/releases/download/${tag}/AtlasReview-windows-x64-setup.exe) | [Mac Apple Silicon](https://github.com/${repo}/releases/download/${tag}/AtlasReview-macos-aarch64.dmg) | [Mac Intel](https://github.com/${repo}/releases/download/${tag}/AtlasReview-macos-x86_64.zip)\n\nThe installed application retains the AtlasEngine bundle identity for compatibility. Verify downloads with SHA256SUMS. Updater payloads are signed. Inspect the build logs and record OS signing/notarization status before publishing this draft.\n`);
const files=readdirSync(dir).map(n=>join(dir,n));
execFileSync('gh',['release','create',tag,'--verify-tag','--draft',...(beta?['--prerelease']:[]),'--title',`Atlas Review ${tag}`,'--notes-file','release-notes.md',...files],{stdio:'inherit'});
