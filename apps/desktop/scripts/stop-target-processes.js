#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopDir = dirname(__dirname);
const tauriTargetDir = join(desktopDir, 'src-tauri', 'target');

if (process.platform !== 'win32') {
  process.exit(0);
}

const powershellScript = `
$ErrorActionPreference = 'Stop'
$targetDir = [System.IO.Path]::GetFullPath('${tauriTargetDir.replace(/\\/g, '\\\\')}')
$allowedNames = @('AtlasEngine.exe', 'atlasengine-desktop.exe', 'node.exe')
$processes = Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and
  $allowedNames -contains $_.Name -and
  ([System.IO.Path]::GetFullPath($_.ExecutablePath)).StartsWith($targetDir, [System.StringComparison]::OrdinalIgnoreCase)
}

if (-not $processes) {
  Write-Output 'No build-output AtlasEngine processes are running.'
  exit 0
}

foreach ($proc in $processes) {
  Write-Output ('Stopping {0} ({1}) from {2}' -f $proc.Name, $proc.ProcessId, $proc.ExecutablePath)
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

$deadline = (Get-Date).AddSeconds(8)
do {
  Start-Sleep -Milliseconds 250
  $remaining = Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and
    $allowedNames -contains $_.Name -and
    ([System.IO.Path]::GetFullPath($_.ExecutablePath)).StartsWith($targetDir, [System.StringComparison]::OrdinalIgnoreCase)
  }
} while ($remaining -and (Get-Date) -lt $deadline)

if ($remaining) {
  Write-Error ('Timed out waiting for build-output processes to stop: ' + (($remaining | ForEach-Object { '{0} ({1})' -f $_.Name, $_.ProcessId }) -join ', '))
}
`;

execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    powershellScript,
  ],
  {
    cwd: desktopDir,
    stdio: 'inherit',
  },
);
