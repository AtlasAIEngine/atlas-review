; NSIS installer hooks for AtlasEngine Desktop
;
; The Tauri NSIS installer already terminates atlasengine-desktop.exe before
; copying files. However, on Windows child processes survive parent termination.
; The bundled Node.js backend (node.exe sidecar) can keep native modules under
; resources\backend\node_modules locked, which prevents NSIS from overwriting
; those files during an update install.
;
; Keep the installer-side process cleanup in a standalone PowerShell script.
; The inline one-liner became too brittle as more lock handling was added.

!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  StrCpy $0 "$PLUGINSDIR\atlas-preinstall.ps1"
  FileOpen $1 $0 w
  FileWrite $1 "param([string]$$InstallDir)$\r$\n"
  FileWrite $1 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $1 "$$installDir = [System.IO.Path]::GetFullPath($$InstallDir).TrimEnd('\')$\r$\n"
  FileWrite $1 "$$runtimeDir = Join-Path $$env:LOCALAPPDATA 'com.atlasengine.desktop\runtime'$\r$\n"
  FileWrite $1 "$$nativeRoot = Join-Path $$installDir 'resources\backend\node_modules'$\r$\n"
  FileWrite $1 "$$lockTargets = @()$\r$\n"
  FileWrite $1 "if (Test-Path $$nativeRoot) {$\r$\n"
  FileWrite $1 "  $$lockTargets += Get-ChildItem -Path $$nativeRoot -Recurse -Filter *.node -File | Select-Object -ExpandProperty FullName$\r$\n"
  FileWrite $1 "}$\r$\n"
  FileWrite $1 "$$lockTargets += (Join-Path $$installDir 'node.exe')$\r$\n"
  FileWrite $1 "function Get-AtlasProcesses {$\r$\n"
  FileWrite $1 "  Get-CimInstance Win32_Process | Where-Object {$\r$\n"
  FileWrite $1 "    ($$_.Name -eq 'AtlasEngine.exe') -or$\r$\n"
  FileWrite $1 "    ($$_.Name -eq 'atlasengine-desktop.exe') -or$\r$\n"
  FileWrite $1 "    ($$_.Name -eq 'node.exe' -and ($\r$\n"
  FileWrite $1 "      ($$_.ExecutablePath -and (($$_.ExecutablePath -like ($$installDir + '\*')) -or ($$_.ExecutablePath -like ($$runtimeDir + '\*')))) -or$\r$\n"
  FileWrite $1 "      ($$_.CommandLine -and (($$_.CommandLine -like ('*' + $$installDir + '*')) -or ($$_.CommandLine -like ('*' + $$runtimeDir + '*')) -or ($$_.CommandLine -like '*server-desktop.js*')))$\r$\n"
  FileWrite $1 "    ))$\r$\n"
  FileWrite $1 "  }$\r$\n"
  FileWrite $1 "}$\r$\n"
  FileWrite $1 "$$deadline = (Get-Date).AddSeconds(30)$\r$\n"
  FileWrite $1 "do {$\r$\n"
  FileWrite $1 "  $$active = @(Get-AtlasProcesses)$\r$\n"
  FileWrite $1 "  foreach ($$proc in $$active) {$\r$\n"
  FileWrite $1 "    Stop-Process -Id $$proc.ProcessId -Force -ErrorAction SilentlyContinue$\r$\n"
  FileWrite $1 "  }$\r$\n"
  FileWrite $1 "  Start-Sleep -Milliseconds 500$\r$\n"
  FileWrite $1 "  $$locked = $$false$\r$\n"
  FileWrite $1 "  foreach ($$target in $$lockTargets) {$\r$\n"
  FileWrite $1 "    if (-not (Test-Path $$target)) { continue }$\r$\n"
  FileWrite $1 "    try {$\r$\n"
  FileWrite $1 "      $$stream = [System.IO.File]::Open($$target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)$\r$\n"
  FileWrite $1 "      $$stream.Close()$\r$\n"
  FileWrite $1 "    } catch {$\r$\n"
  FileWrite $1 "      $$locked = $$true$\r$\n"
  FileWrite $1 "      break$\r$\n"
  FileWrite $1 "    }$\r$\n"
  FileWrite $1 "  }$\r$\n"
  FileWrite $1 "  $$active = @(Get-AtlasProcesses)$\r$\n"
  FileWrite $1 "} while (((($$active.Count -gt 0) -or $$locked)) -and ((Get-Date) -lt $$deadline))$\r$\n"
  FileClose $1
  nsExec::ExecToLog `"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\atlas-preinstall.ps1" -InstallDir "$INSTDIR"`
  Pop $0 ; discard exit code (0 = success, non-zero = PowerShell unavailable)
!macroend
