# Builds the Windows desktop installer for one release. scripts/t3code-desktop-release
# copies this next to the source archive on the Windows build machine and runs it
# there; see docs/operations/forgejo-packages.md.
param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$UpdateUrl
)
# Native tools write progress to stderr, which "Stop" would turn into failures.
$ErrorActionPreference = "Continue"
# A shell started through WSL keeps the PATH from when WSL booted.
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
  [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:APPDATA\npm"
$src = Join-Path (Split-Path -Parent $PSCommandPath) "src"

function Step([string]$name, [scriptblock]$body) {
  $start = Get-Date
  Write-Host "=== $name"
  $global:LASTEXITCODE = 0
  & $body
  if ($LASTEXITCODE -ne 0) {
    Write-Host "=== FAILED: $name (exit $LASTEXITCODE)"
    exit 1
  }
  Write-Host ("=== ok: $name ({0:n0}s)" -f ((Get-Date) - $start).TotalSeconds)
}

Step "unpack source" {
  # A clean tree every time: files from an older commit must not reach the build.
  if (Test-Path $src) { cmd /c rmdir /s /q "$src" }
  New-Item -ItemType Directory -Force $src | Out-Null
  tar -xzf $Archive -C $src
}
Set-Location $src
Step "install vp" {
  $pin = (Select-String -Path pnpm-workspace.yaml -Pattern '^\s*vite-plus:\s*"?(\d[^"\s]*)').Matches[0].Groups[1].Value
  npm install --global --no-fund --no-audit "vite-plus@$pin"
}
Step "install dependencies" {
  vp install --filter=@t3tools/desktop... --filter=t3... --filter=@t3tools/scripts... --filter=@t3tools/web...
}
Step "set version $Version" { node scripts/update-release-package-versions.ts $Version }
Step "build installer" {
  $env:T3CODE_DESKTOP_UPDATE_URL = $UpdateUrl
  vp run dist:desktop:artifact --platform win --target nsis --arch x64 --build-version $Version
}
Write-Host "=== DONE"
