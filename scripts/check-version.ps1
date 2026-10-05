<#
.SYNOPSIS
  Verifica que la versión de la app coincida en sus tres fuentes y, si se pasa
  un tag, que el tag sea esa misma versión (vX.Y.Z).

.EXAMPLE
  pwsh scripts/check-version.ps1              # solo consistencia
  pwsh scripts/check-version.ps1 -Tag v0.1.0  # además, contra el tag
#>
param(
  [string]$Tag
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Las tres fuentes (ver "Versionado" en CLAUDE.md).
$cargo = Select-String -Path "$root/Cargo.toml" -Pattern '^version\s*=\s*"([^"]+)"' |
  Select-Object -First 1 | ForEach-Object { $_.Matches[0].Groups[1].Value }
$package = (Get-Content "$root/apps/desktop/package.json" -Raw | ConvertFrom-Json).version
$tauri = (Get-Content "$root/apps/desktop/src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json).version

$sources = [ordered]@{
  'Cargo.toml [workspace.package]'          = $cargo
  'apps/desktop/package.json'               = $package
  'apps/desktop/src-tauri/tauri.conf.json'  = $tauri
}
$sources.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-42} {1}" -f $_.Key, $_.Value) }

$distinct = @($sources.Values | Sort-Object -Unique)
if ($distinct.Count -ne 1 -or -not $distinct[0]) {
  Write-Error "La versión no coincide entre las fuentes."
}
$version = $distinct[0]

if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
  Write-Error "La versión '$version' no es semver (MAJOR.MINOR.PATCH)."
}

if ($Tag) {
  if ($Tag -ne "v$version") {
    Write-Error "El tag '$Tag' no coincide con la versión de la app 'v$version'."
  }
  Write-Host "Tag $Tag coincide con la versión de la app."
}

Write-Host "Versión: $version"
# Para los workflows: deja la versión disponible como output del paso.
if ($env:GITHUB_OUTPUT) { "version=$version" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8 }
