# dsh-liang-guard installer (Windows) - follows the dsh-balance install pattern
# Typical use: clone this repo into ~/.dsh/plugins/dsh-liang-guard, then run
#   powershell -ExecutionPolicy Bypass -File install.ps1
# (also accepts -Source <plugin dir> and -DshHome <DSH home> overrides)
param(
  [string]$Source = $PSScriptRoot,
  [string]$DshHome = $env:DSH_HOME
)
$ErrorActionPreference = 'Stop'
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
if (-not (Test-Path $DshHome)) { throw "DSH home not found: $DshHome (set DSH_HOME or pass -DshHome)" }

$dest = $Source
$link = Join-Path $DshHome 'profiles\node_modules\dsh-liang-guard'
$patch = Join-Path $DshHome 'profiles\web\cordis.patch.yml'

if (-not (Test-Path (Join-Path $dest 'lib\index.js'))) { throw "plugin files not found under: $dest" }

Write-Host '[1/2] Linking into profile node_modules...' -ForegroundColor Cyan
if (Test-Path $link) { $item = Get-Item $link -Force; if ($item.LinkType) { $item.Delete() } else { Remove-Item $link -Recurse -Force } }
New-Item -ItemType Junction -Path $link -Target $dest -Force | Out-Null

Write-Host '[2/2] Registering in cordis.patch.yml...' -ForegroundColor Cyan
if (-not (Test-Path $patch)) { New-Item -ItemType Directory -Path (Split-Path $patch) -Force | Out-Null }
$content = if (Test-Path $patch) { Get-Content $patch -Raw } else { '' }
if ($content -notmatch 'dsh-liang-guard') {
  $content = $content.TrimEnd() + "`n- insert:`n    - id: dsh-liang-guard`n      name: 'dsh-liang-guard'`n"
  [System.IO.File]::WriteAllText($patch, $content, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host ''
Write-Host 'Done! liang-guard installed.' -ForegroundColor Green
Write-Host '1) Restart the DSH server'
Write-Host '2) Hard-refresh the web UI (Ctrl+F5) - a guard button appears below the New Session button'
