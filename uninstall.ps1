# dsh-liang-guard uninstaller
param([string]$DshHome = $env:DSH_HOME)
$ErrorActionPreference = 'Stop'
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }

$link = Join-Path $DshHome 'profiles\node_modules\dsh-liang-guard'
$dest = Join-Path $DshHome 'plugins\dsh-liang-guard'
$patch = Join-Path $DshHome 'profiles\web\cordis.patch.yml'

if (Test-Path $link) { $item = Get-Item $link -Force; if ($item.LinkType) { $item.Delete() } else { Remove-Item $link -Recurse -Force } }
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
if (Test-Path $patch) {
  $lines = Get-Content $patch | Where-Object { $_ -notmatch 'dsh-liang-guard' }
  [System.IO.File]::WriteAllText($patch, ($lines -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
}
Write-Host 'Uninstalled. Restart DSH to take effect.' -ForegroundColor Green
