#!/usr/bin/env node

import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { loadDesktopLocalEnv } from './load-local-env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopDir = dirname(__dirname);
const projectRoot = resolve(desktopDir, '..', '..');
const manifestScriptPath = join(projectRoot, 'scripts', 'generate-update-manifest.js');
const publicReleaseRepo = 'AtlasAIEngine/atlas-review';
const allowedChannels = new Set(['stable', 'beta']);
const requiredUpdaterPlatformsByChannel = {
  stable: ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64'],
  beta: [],
};

loadDesktopLocalEnv();

function parseArgs(argv) {
  const options = {
    version: null,
    channel: 'stable',
    artifactsDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--version':
      case '-v':
        options.version = next;
        index += 1;
        break;
      case '--channel':
      case '-c':
        options.channel = next;
        index += 1;
        break;
      case '--artifacts-dir':
      case '-a':
        options.artifactsDir = next;
        index += 1;
        break;
      default:
        break;
    }
  }

  if (!options.version) {
    throw new Error('Missing required --version');
  }

  if (!options.artifactsDir) {
    throw new Error('Missing required --artifacts-dir');
  }

  if (!allowedChannels.has(options.channel)) {
    throw new Error(`Invalid --channel "${options.channel}". Expected one of: ${Array.from(allowedChannels).join(', ')}`);
  }

  return options;
}

function commandName(base) {
  if (process.platform !== 'win32') {
    return base;
  }

  if (base === 'npm' || base === 'npx') {
    return `${base}.cmd`;
  }

  if (base === 'gh') {
    return 'gh.exe';
  }

  return base;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? desktopDir,
    stdio: options.capture ? 'pipe' : 'inherit',
    env: options.env ?? process.env,
    encoding: options.capture ? 'utf8' : undefined,
  });
}

function githubAuthEnv(token) {
  const auth = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');

  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
  };
}

function shouldRetryCloneWithAuth(error) {
  const details = String(
    error?.stderr || error?.stdout || error?.message || ''
  ).toLowerCase();
  const authFailurePatterns = [
    'repository not found',
    'authentication failed',
    'could not read username',
    'http basic: access denied',
    '403',
    '401',
    'access denied',
    'permission denied',
    'remote: invalid username or token',
    'remote: repository not found',
  ];

  return authFailurePatterns.some((pattern) => details.includes(pattern));
}

function ensureRepoInitialized(repoDir, token) {
  let hasHead = '';
  try {
    hasHead = run('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoDir,
      capture: true,
    }).trim();
  } catch {
    hasHead = '';
  }

  if (hasHead) {
    try {
      run('git', ['checkout', '-B', 'main', 'origin/main'], { cwd: repoDir });
    } catch {
      run('git', ['checkout', '-B', 'main'], { cwd: repoDir });
    }
    return;
  }

  run('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: repoDir });
  run('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'], { cwd: repoDir });
  run('git', ['checkout', '--orphan', 'main'], { cwd: repoDir });

  mkdirSync(join(repoDir, 'docs', 'updates'), { recursive: true });
  writeFileSync(join(repoDir, 'README.md'), '# AtlasEngineRelease\n\nPublic release artifacts and updater manifests for AtlasEngine Desktop.\n');
  writeFileSync(
    join(repoDir, 'docs', 'updates', 'stable.json'),
    JSON.stringify({
      version: '0.0.0',
      notes: 'No public release published yet',
      pub_date: '1970-01-01T00:00:00Z',
      platforms: {},
    }, null, 2) + '\n'
  );
  writeFileSync(
    join(repoDir, 'docs', 'updates', 'beta.json'),
    JSON.stringify({
      version: '0.0.0-beta.0',
      notes: 'No public beta release published yet',
      pub_date: '1970-01-01T00:00:00Z',
      platforms: {},
    }, null, 2) + '\n'
  );

  run('git', ['add', 'README.md', 'docs/updates/stable.json', 'docs/updates/beta.json'], { cwd: repoDir });
  run('git', ['commit', '-m', 'chore: initialize public release repository'], { cwd: repoDir });
  run('git', ['push', 'origin', 'HEAD:main'], {
    cwd: repoDir,
    env: githubAuthEnv(token),
  });
}

function createReleaseNotes(version, prerelease, artifactNames) {
  const channelNote = prerelease
    ? 'This is a beta release for testing purposes.'
    : 'This is a stable release recommended for all users.';

  const downloads = [];
  const installNotes = [];

  if (artifactNames.includes(`AtlasEngine-${version}-macos-aarch64.dmg`)) {
    downloads.push(`| macOS | Apple Silicon (M1/M2/M3) | \`AtlasEngine-${version}-macos-aarch64.dmg\` |`);
    installNotes.push('- macOS Apple Silicon: download the `.dmg` and move AtlasEngine to Applications.');
  }

  if (artifactNames.includes(`AtlasEngine-${version}-macos-x86_64.zip`)) {
    downloads.push(`| macOS | Intel | \`AtlasEngine-${version}-macos-x86_64.zip\` |`);
    installNotes.push('- macOS Intel: download the `.zip`, extract it, and move AtlasEngine.app to Applications.');
  }

  if (artifactNames.includes(`AtlasEngine-${version}-windows-x64-setup.exe`)) {
    downloads.push(`| Windows | x64 | \`AtlasEngine-${version}-windows-x64-setup.exe\` |`);
    installNotes.push('- Windows: download and run the `-setup.exe`.');
  }

  if (artifactNames.includes(`AtlasEngine-${version}-windows-x64.msi`)) {
    downloads.push(`| Windows | x64 (MSI) | \`AtlasEngine-${version}-windows-x64.msi\` |`);
    installNotes.push('- Windows enterprise deployments can use the `.msi` package.');
  }

  return `## AtlasEngine Desktop v${version}

${channelNote}

### Downloads

| Platform | Architecture | Download |
|----------|--------------|----------|
${downloads.join('\n')}

### Installation

${installNotes.join('\n')}

### Auto-Updates

AtlasEngine will automatically check for updates and notify you when a new version is available.
`;
}

function bootstrapClone(repoDir, token) {
  try {
    run('git', ['clone', `https://github.com/${publicReleaseRepo}.git`, repoDir], {
      cwd: os.tmpdir(),
    });
  } catch (error) {
    if (!shouldRetryCloneWithAuth(error)) {
      throw error;
    }

    run('git', ['clone', `https://github.com/${publicReleaseRepo}.git`, repoDir], {
      cwd: os.tmpdir(),
      env: githubAuthEnv(token),
    });
  }
  ensureRepoInitialized(repoDir, token);
}

function ensureArtifactsDir(dirPath) {
  const files = readdirSync(dirPath).filter((name) => !name.endsWith('.json'));
  if (files.length === 0) {
    throw new Error(`No release artifacts found in ${dirPath}`);
  }
}

function getUpdaterAssetRequirements(version) {
  return {
    'darwin-aarch64': [
      `AtlasEngine_${version}_aarch64.app.tar.gz`,
      `AtlasEngine_${version}_aarch64.app.tar.gz.sig`,
    ],
    'darwin-x86_64': [
      `AtlasEngine_${version}_x86_64.app.tar.gz`,
      `AtlasEngine_${version}_x86_64.app.tar.gz.sig`,
    ],
    'windows-x86_64': [
      `AtlasEngine-${version}-windows-x64-setup.exe`,
      `AtlasEngine-${version}-windows-x64-setup.exe.sig`,
    ],
  };
}

function getReleaseAssets(tagName) {
  const output = run(commandName('gh'), [
    'release',
    'view',
    tagName,
    '--repo',
    publicReleaseRepo,
    '--json',
    'assets',
  ], { capture: true });
  return JSON.parse(output).assets || [];
}

function getAvailableUpdaterPlatforms(version, releaseAssets) {
  const assetNames = new Set(releaseAssets.map((asset) => asset.name));
  const requirements = getUpdaterAssetRequirements(version);

  return Object.entries(requirements)
    .filter(([, requiredFiles]) => requiredFiles.every((fileName) => assetNames.has(fileName)))
    .map(([platform]) => platform);
}

function getMissingRequiredUpdaterPlatforms(version, releaseAssets, channel) {
  const requiredPlatforms = requiredUpdaterPlatformsByChannel[channel] || [];
  if (requiredPlatforms.length === 0) {
    return [];
  }

  const availablePlatforms = new Set(getAvailableUpdaterPlatforms(version, releaseAssets));
  return requiredPlatforms.filter((platform) => !availablePlatforms.has(platform));
}

function stageManifestSignatureFiles(localArtifactsDir, manifestArtifactsDir, tagName, releaseAssets) {
  mkdirSync(manifestArtifactsDir, { recursive: true });

  for (const fileName of readdirSync(localArtifactsDir)) {
    if (fileName.endsWith('.sig')) {
      copyFileSync(join(localArtifactsDir, fileName), join(manifestArtifactsDir, fileName));
    }
  }

  for (const asset of releaseAssets) {
    if (!asset.name.endsWith('.sig')) {
      continue;
    }

    const destination = join(manifestArtifactsDir, asset.name);
    if (existsSync(destination)) {
      continue;
    }

    run(commandName('gh'), [
      'release',
      'download',
      tagName,
      '--repo',
      publicReleaseRepo,
      '--pattern',
      asset.name,
      '--dir',
      manifestArtifactsDir,
      '--clobber',
    ]);
  }
}

function publishRelease(options) {
  const artifactsDir = resolve(options.artifactsDir);
  ensureArtifactsDir(artifactsDir);

  const version = options.version;
  const tagName = `v${version}`;
  const prerelease = /-(alpha|beta|rc)/.test(version);
  const token = run(commandName('gh'), ['auth', 'token'], { capture: true }).trim();
  if (!token) {
    throw new Error('gh auth token is empty. Run `gh auth login` first.');
  }

  const workDir = mkdtempSync(join(os.tmpdir(), 'atlasengine-public-release-'));
  const repoDir = join(workDir, 'AtlasEngineRelease');
  const notesPath = join(workDir, 'release-notes.md');
  const manifestOutputDir = join(workDir, 'manifests');
  const manifestArtifactsDir = join(workDir, 'manifest-artifacts');
  const artifactNames = readdirSync(artifactsDir).filter((name) => !name.endsWith('.json'));

  try {
    mkdirSync(manifestOutputDir, { recursive: true });
    writeFileSync(notesPath, createReleaseNotes(version, prerelease, artifactNames));

    bootstrapClone(repoDir, token);

    let releaseExists = true;
    try {
      run(commandName('gh'), ['release', 'view', tagName, '--repo', publicReleaseRepo], { capture: true });
    } catch {
      releaseExists = false;
    }

    const artifactFiles = artifactNames.map((name) => join(artifactsDir, name));
    const releaseAssetsBeforeUpload = releaseExists ? getReleaseAssets(tagName) : [];
    const combinedAssetsByName = new Map(
      releaseAssetsBeforeUpload.map((asset) => [asset.name, asset])
    );
    for (const assetName of artifactNames) {
      if (!combinedAssetsByName.has(assetName)) {
        combinedAssetsByName.set(assetName, { name: assetName });
      }
    }
    const missingRequiredPlatforms = getMissingRequiredUpdaterPlatforms(
      version,
      Array.from(combinedAssetsByName.values()),
      options.channel
    );
    const shouldUpdateManifest = missingRequiredPlatforms.length === 0;

    if (shouldUpdateManifest) {
      stageManifestSignatureFiles(
        artifactsDir,
        manifestArtifactsDir,
        tagName,
        releaseAssetsBeforeUpload
      );
      run(commandName('node'), [
        manifestScriptPath,
        '--version',
        version,
        '--notes',
        'See release notes on GitHub',
        '--channel',
        options.channel,
        '--github-release-url',
        `https://github.com/${publicReleaseRepo}/releases/download/${tagName}`,
        '--artifacts',
        manifestArtifactsDir,
        '--output-dir',
        manifestOutputDir,
      ], {
        env: {
          ...process.env,
          TAURI_SIGNING_PRIVATE_KEY_PATH: process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || join(desktopDir, '.tauri_updater_key'),
        },
      });
    }

    if (shouldUpdateManifest) {
      mkdirSync(join(repoDir, 'docs', 'updates'), { recursive: true });

    // Merge new platform entries into existing manifest instead of replacing it.
    // This allows Mac and Windows builds to publish from separate machines without
    // overwriting each other's signatures.
    const existingManifestPath = join(repoDir, 'docs', 'updates', `${options.channel}.json`);
    const newManifest = JSON.parse(readFileSync(join(manifestOutputDir, `${options.channel}.json`), 'utf8'));
    let mergedManifest = newManifest;
    if (existsSync(existingManifestPath)) {
      try {
        const existing = JSON.parse(readFileSync(existingManifestPath, 'utf8'));
        if (existing.version === newManifest.version) {
          // Same version — merge platforms (new entries override existing for same platform)
          mergedManifest = {
            ...newManifest,
            platforms: {
              ...existing.platforms,
              ...newManifest.platforms,
            },
          };
          const existingPlatforms = Object.keys(existing.platforms || {});
          const newPlatforms = Object.keys(newManifest.platforms || {});
          const mergedPlatforms = Object.keys(mergedManifest.platforms || {});
          console.log(`Merged manifest platforms: ${existingPlatforms.join(', ')} + ${newPlatforms.join(', ')} → ${mergedPlatforms.join(', ')}`);
        }
      } catch {
        // Existing manifest is corrupt or unparseable — use new one as-is
      }
    }
    writeFileSync(existingManifestPath, JSON.stringify(mergedManifest, null, 2) + '\n');

    // Verify manifest signatures match the uploaded .sig files
    const manifestContent = mergedManifest;
    const releaseBaseUrl = `https://github.com/${publicReleaseRepo}/releases/download/${tagName}`;
    let sigMismatch = false;
    for (const [platform, entry] of Object.entries(manifestContent.platforms || {})) {
      if (!entry.url || !entry.signature) continue;
      const sigFilename = entry.url.replace(releaseBaseUrl + '/', '') + '.sig';
      const sigFilePath = join(artifactsDir, sigFilename);
      if (existsSync(sigFilePath)) {
        const localSig = readFileSync(sigFilePath, 'utf8').trim();
        if (localSig !== entry.signature) {
          console.error(`SIGNATURE MISMATCH for ${platform}:`);
          console.error(`  manifest: ${entry.signature.slice(0, 40)}...`);
          console.error(`  .sig file: ${localSig.slice(0, 40)}...`);
          sigMismatch = true;
        }
      }
    }
    if (sigMismatch) {
      throw new Error(
        'Manifest signatures do not match .sig files in artifacts directory. ' +
        'This usually means artifacts were rebuilt after a previous upload. ' +
        'Re-run the full build + publish pipeline from scratch.'
      );
    }
    }

    if (releaseExists) {
      run(commandName('gh'), ['release', 'upload', tagName, ...artifactFiles, '--repo', publicReleaseRepo, '--clobber']);
      run(commandName('gh'), [
        'release',
        'edit',
        tagName,
        '--repo',
        publicReleaseRepo,
        '--title',
        `AtlasEngine Desktop v${version}`,
        '--notes-file',
        notesPath,
      ]);
    } else {
      run(commandName('gh'), [
        'release',
        'create',
        tagName,
        ...artifactFiles,
        '--repo',
        publicReleaseRepo,
        '--target',
        'main',
        '--title',
        `AtlasEngine Desktop v${version}`,
        '--notes-file',
        notesPath,
        ...(prerelease ? ['--prerelease'] : []),
      ]);
    }

    const releaseAssetsAfterUpload = getReleaseAssets(tagName);
    writeFileSync(
      notesPath,
      createReleaseNotes(
        version,
        prerelease,
        releaseAssetsAfterUpload.map((asset) => asset.name)
      )
    );
    run(commandName('gh'), [
      'release',
      'edit',
      tagName,
      '--repo',
      publicReleaseRepo,
      '--title',
      `AtlasEngine Desktop v${version}`,
      '--notes-file',
      notesPath,
    ]);

    if (shouldUpdateManifest) {
      run('git', ['checkout', '-B', 'main', 'origin/main'], { cwd: repoDir });
      run('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: repoDir });
      run('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'], { cwd: repoDir });
      run('git', ['add', join('docs', 'updates', `${options.channel}.json`)], { cwd: repoDir });

      try {
        run('git', ['diff', '--staged', '--quiet'], { cwd: repoDir });
      } catch {
        run('git', ['commit', '-m', `chore(release): update ${options.channel}.json for ${tagName}`], { cwd: repoDir });
        run('git', ['push', 'origin', 'HEAD:main'], {
          cwd: repoDir,
          env: githubAuthEnv(token),
        });
      }
    } else {
      console.log(
        `Skipping ${options.channel}.json update for ${tagName}: release is missing required updater platforms: ${missingRequiredPlatforms.join(', ')}`
      );
      console.log(`Manifest unchanged until all required updater platforms for ${options.channel} are uploaded.`);
    }

    console.log(`Published ${tagName} to ${publicReleaseRepo}`);
    if (shouldUpdateManifest) {
      console.log(`Manifest: https://raw.githubusercontent.com/${publicReleaseRepo}/main/docs/updates/${options.channel}.json`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

publishRelease(parseArgs(process.argv.slice(2)));
