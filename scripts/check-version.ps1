<#
.SYNOPSIS
  Verifica la versión de un paquete del monorepo (desktop, server o web) y, si
  se pasa un tag, que el tag sea esa misma versión.

.DESCRIPTION
  Cada paquete tiene su propia versión y su propio formato de tag:
    desktop  3 fuentes que tienen que coincidir      tag vX.Y.Z
    server   packages/server/package.json                tag server-vX.Y.Z
    web      packages/web/package.json                   tag web-vX.Y.Z

.EXAMPLE
  pwsh scripts/check-version.ps1                              # desktop, solo consistencia
  pwsh scripts/check-version.ps1 -Tag v0.2.0                  # desktop, además contra el tag
  pwsh scripts/check-version.ps1 -Package server -Tag server-v0.1.0
#>
param(
  [ValidateSet('desktop', 'server', 'web')][string]$Package = 'desktop',
  [string]$Tag
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Read-PackageJsonVersion([string]$Relative) {
  $path = "$root/$Relative"
  if (-not (Test-Path $path)) {
    Write-Error "No existe ${Relative}: el paquete '$Package' todavía no está en el repo."
  }
  (Get-Content $path -Raw | ConvertFrom-Json).version
}

# Fuentes de versión de cada paquete (ver "Versionado" en AGENTS.md).
switch ($Package) {
  'desktop' {
    $cargo = Select-String -Path "$root/Cargo.toml" -Pattern '^version\s*=\s*"([^"]+)"' |
      Select-Object -First 1 | ForEach-Object { $_.Matches[0].Groups[1].Value }
    $sources = [ordered]@{
      'Cargo.toml [workspace.package]'          = $cargo
      'packages/desktop/package.json'               = Read-PackageJsonVersion 'packages/desktop/package.json'
      'packages/desktop/src-tauri/tauri.conf.json'  = Read-PackageJsonVersion 'packages/desktop/src-tauri/tauri.conf.json'
    }
    $tagPrefix = 'v'
  }
  'server' {
    $sources = [ordered]@{ 'packages/server/package.json' = Read-PackageJsonVersion 'packages/server/package.json' }
    $tagPrefix = 'server-v'
  }
  'web' {
    $sources = [ordered]@{ 'packages/web/package.json' = Read-PackageJsonVersion 'packages/web/package.json' }
    $tagPrefix = 'web-v'
  }
}
$sources.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-42} {1}" -f $_.Key, $_.Value) }

$distinct = @($sources.Values | Sort-Object -Unique)
if ($distinct.Count -ne 1 -or -not $distinct[0]) {
  Write-Error "La versión de '$Package' no coincide entre las fuentes."
}
$version = $distinct[0]

if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
  Write-Error "La versión '$version' no es semver (MAJOR.MINOR.PATCH)."
}

if ($Tag) {
  if ($Tag -ne "$tagPrefix$version") {
    Write-Error "El tag '$Tag' no coincide con la versión de '$Package': se esperaba '$tagPrefix$version'."
  }
  Write-Host "Tag $Tag coincide con la versión de $Package."
}

Write-Host "Versión ($Package): $version"
# Para los workflows: deja la versión disponible como output del paso.
if ($env:GITHUB_OUTPUT) { "version=$version" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8 }
