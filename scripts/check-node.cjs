#!/usr/bin/env node

/**
 * Node.js version check before running the start script.
 */

const REQUIRED_NODE_VERSION = 20;
const currentVersion = parseInt(process.versions.node.split('.')[0], 10);

if (currentVersion < REQUIRED_NODE_VERSION) {
  console.error('ERROR: Node.js version too old.');
  console.error('');
  console.error(`Current version: v${process.versions.node}`);
  console.error(`Required version: v${REQUIRED_NODE_VERSION}.0.0 or higher`);
  console.error('');
  console.error('Please install Node.js 20+ from https://nodejs.org/');
  process.exit(1);
}

require('child_process')
  .spawn(process.execPath, [require('path').join(__dirname, 'start.mjs')], {
    stdio: 'inherit'
  })
  .on('exit', (code) => process.exit(code || 0));
