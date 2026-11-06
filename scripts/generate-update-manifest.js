#!/usr/bin/env node
/**
 * Generate Tauri v2 update manifest for AtlasEngine Desktop
 *
 * Usage:
 *   node scripts/generate-update-manifest.js --version 0.19.1 --channel stable
 *   node scripts/generate-update-manifest.js --help
 *
 * Environment:
 *   TAURI_SIGNING_PRIVATE_KEY - Private key content (written to temp file for signing)
 *   TAURI_SIGNING_PRIVATE_KEY_PATH - Path to private key file (preferred)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PLATFORMS = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'linux-x86_64'];

function printHelp() {
  console.log(`
AtlasEngine Update Manifest Generator

Usage:
  node scripts/generate-update-manifest.js [options]

Options:
  --version, -v       Version string (e.g., 0.19.1, 0.20.0-beta.1)
  --notes, -n         Release notes (can be multiline with \\n)
  --channel, -c       Update channel: stable, beta, or test (default: stable)
  --base-url          Base URL for artifacts (default: https://atlasengine.dev/updates)
  --github-release-url  GitHub Release URL for direct artifact downloads
                        (e.g., https://github.com/owner/repo/releases/download/v0.19.0)
  --artifacts         Path to directory containing build artifacts
  --output, -o        Output file path (default: stdout)
  --output-dir        Output directory for manifest (creates {channel}.json)
  --sign              Sign artifacts (requires TAURI_SIGNING_PRIVATE_KEY or _PATH)
  --help, -h          Show this help message

Environment Variables:
  TAURI_SIGNING_PRIVATE_KEY         Private key content (will be written to temp file)
  TAURI_SIGNING_PRIVATE_KEY_PATH    Path to private key file (preferred)

Examples:
  # Generate test manifest
  node scripts/generate-update-manifest.js -v 0.19.1 -n "Bug fixes" -c test

  # Generate signed production manifest
  node scripts/generate-update-manifest.js -v 0.19.1 --artifacts ./dist --sign -o stable.json

  # Generate manifest for GitHub Release (CI/CD)
  node scripts/generate-update-manifest.js \\
    --version 0.19.1 \\
    --github-release-url "https://github.com/owner/repo/releases/download/v0.19.1" \\
    --artifacts ./release-artifacts \\
    --output-dir ./docs/updates \\
    --channel stable
`);
}

function parseArgs(args) {
  const options = {
    version: null,
    notes: '',
    channel: 'stable',
    baseUrl: 'https://atlasengine.dev/updates',
    githubReleaseUrl: null,
    artifacts: null,
    output: null,
    outputDir: null,
    sign: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--version':
      case '-v':
        options.version = next;
        i++;
        break;
      case '--notes':
      case '-n':
        options.notes = next ? next.replace(/\\n/g, '\n') : '';
        i++;
        break;
      case '--channel':
      case '-c':
        options.channel = next;
        i++;
        break;
      case '--base-url':
        options.baseUrl = next;
        i++;
        break;
      case '--github-release-url':
        options.githubReleaseUrl = next;
        i++;
        break;
      case '--artifacts':
        options.artifacts = next;
        i++;
        break;
      case '--output':
      case '-o':
        options.output = next;
        i++;
        break;
      case '--output-dir':
        options.outputDir = next;
        i++;
        break;
      case '--sign':
        options.sign = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
    }
  }

  return options;
}

function getArtifactFilename(platform, version) {
  const v = version;
  switch (platform) {
    case 'darwin-aarch64':
      return `AtlasEngine_${v}_aarch64.app.tar.gz`;
    case 'darwin-x86_64':
      return `AtlasEngine_${v}_x86_64.app.tar.gz`;
    case 'windows-x86_64':
      return `AtlasEngine-${v}-windows-x64-setup.exe`;
    case 'linux-x86_64':
      return `atlasengine_${v}_amd64.AppImage.tar.gz`;
    default:
      return `atlasengine_${v}_${platform}.tar.gz`;
  }
}

function signArtifact(artifactPath) {
  const privateKeyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  const privateKeyEnv = process.env.TAURI_SIGNING_PRIVATE_KEY;

  if (!privateKeyPath && !privateKeyEnv) {
    throw new Error(
      'Signing requested but no private key found. ' +
        'Set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH'
    );
  }

  // Use tauri signer to sign the artifact
  // The signature file is created alongside the artifact
  const sigPath = `${artifactPath}.sig`;

  try {
    let keyArg;
    let tempKeyFile = null;

    if (privateKeyPath) {
      // Use path directly if provided
      keyArg = privateKeyPath;
    } else {
      // Write key to temp file to avoid command-line escaping issues with newlines
      const os = require('os');
      tempKeyFile = path.join(os.tmpdir(), `.tauri_key_${Date.now()}`);
      fs.writeFileSync(tempKeyFile, privateKeyEnv, { mode: 0o600 });
      keyArg = tempKeyFile;
    }

    try {
      execSync(
        `tauri signer sign -k "${keyArg}" "${artifactPath}"`,
        { stdio: 'pipe' }
      );
    } finally {
      // Clean up temp key file
      if (tempKeyFile && fs.existsSync(tempKeyFile)) {
        fs.unlinkSync(tempKeyFile);
      }
    }

    if (fs.existsSync(sigPath)) {
      return fs.readFileSync(sigPath, 'utf8').trim();
    }

    throw new Error(`Signature file not created: ${sigPath}`);
  } catch (error) {
    throw new Error(`Failed to sign ${artifactPath}: ${error.message}`);
  }
}

/**
 * Read signature from existing .sig file in artifacts directory
 */
function readSignatureFile(artifactPath) {
  const sigPath = `${artifactPath}.sig`;
  if (fs.existsSync(sigPath)) {
    return fs.readFileSync(sigPath, 'utf8').trim();
  }
  return null;
}

function generateManifest(options) {
  if (!options.version) {
    throw new Error('Version is required. Use --version or -v');
  }

  // Preserve existing platforms from current manifest (e.g. Windows builds
  // when only Mac artifacts are being updated). Never drop platforms that
  // were published from a different machine.
  let existingPlatforms = {};
  if (options.outputDir) {
    const existingPath = path.join(options.outputDir, `${options.channel}.json`);
    if (fs.existsSync(existingPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
        if (existing.platforms && typeof existing.platforms === 'object') {
          existingPlatforms = existing.platforms;
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  const manifest = {
    version: options.version,
    notes: options.notes,
    pub_date: new Date().toISOString(),
    platforms: { ...existingPlatforms },
  };

  // Use GitHub Release URL if provided, otherwise fall back to base URL
  const useGitHubUrl = !!options.githubReleaseUrl;

  for (const platform of PLATFORMS) {
    const filename = getArtifactFilename(platform, options.version);

    // Construct the download URL
    let url;
    if (useGitHubUrl) {
      // GitHub Release direct download URL
      url = `${options.githubReleaseUrl}/${filename}`;
    } else {
      // Default URL structure
      url = `${options.baseUrl}/${options.channel}/${filename}`;
    }

    let signature = null;

    // First, try to read existing signature file from artifacts
    if (options.artifacts) {
      const artifactPath = path.join(options.artifacts, filename);

      // Try to read pre-existing .sig file (created by Tauri build)
      signature = readSignatureFile(artifactPath);

      // If signing is requested and no sig file exists, sign now
      if (!signature && options.sign && fs.existsSync(artifactPath)) {
        signature = signArtifact(artifactPath);
      }

      if (!signature && fs.existsSync(artifactPath)) {
        console.error(`Warning: No signature found for ${filename}`);
      }
    }

    // Only include platform if we have a valid artifact/signature, or use placeholder
    if (!signature) {
      // Skip platforms without artifacts in production mode
      if (options.artifacts && !options.sign) {
        console.error(`Skipping ${platform}: no artifact or signature found`);
        continue;
      }
      signature = `PLACEHOLDER_SIGNATURE_${platform.replace(/-/g, '_')}`;
    }

    manifest.platforms[platform] = {
      signature,
      url,
    };
  }

  return manifest;
}

function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  try {
    const manifest = generateManifest(options);
    const json = JSON.stringify(manifest, null, 2);

    // Determine output destination
    let outputPath = options.output;
    if (!outputPath && options.outputDir) {
      // Create output directory if it doesn't exist
      if (!fs.existsSync(options.outputDir)) {
        fs.mkdirSync(options.outputDir, { recursive: true });
      }
      outputPath = path.join(options.outputDir, `${options.channel}.json`);
    }

    if (outputPath) {
      fs.writeFileSync(outputPath, json + '\n');
      console.error(`Manifest written to: ${outputPath}`);
    } else {
      console.log(json);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
