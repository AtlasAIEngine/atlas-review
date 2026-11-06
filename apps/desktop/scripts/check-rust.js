#!/usr/bin/env node

/**
 * Checks if Rust/Cargo is available in the PATH.
 * If not, provides helpful instructions.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function checkCargo() {
  try {
    execSync('cargo --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (checkCargo()) {
    // Cargo is available, continue
    process.exit(0);
  }

  // Check if Rust is installed but not in PATH
  const cargoPath = join(homedir(), '.cargo', 'bin', 'cargo');
  const rustInstalled = existsSync(cargoPath);

  console.error('\n❌ Rust/Cargo not found in PATH\n');

  if (rustInstalled) {
    console.error('Rust is installed but ~/.cargo/bin is not in your PATH.\n');
    console.error('Quick fix (for current session):');
    console.error('  export PATH="$HOME/.cargo/bin:$PATH"\n');
    console.error('Permanent fix (add to ~/.zshrc or ~/.bashrc):');
    console.error('  echo \'export PATH="$HOME/.cargo/bin:$PATH"\' >> ~/.zshrc');
    console.error('  source ~/.zshrc\n');
  } else {
    console.error('Rust is not installed. Install it via rustup:\n');
    console.error('  curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh');
    console.error('  source $HOME/.cargo/env\n');
  }

  console.error('Then try running the command again.\n');
  process.exit(1);
}

main();
