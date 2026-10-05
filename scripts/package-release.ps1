<#
.SYNOPSIS
  Empaqueta los instaladores de Windows que genera `cargo tauri build` con el
  nombre de release `<os>_<versión>.<extensión>` y sus hashes SHA-256.

.DESCRIPTION
  Toma de target/release/bundle:
    nsis/*.exe  ->  windows_<versión>.exe   (instalador)
    msi/*.msi   ->  windows_<versión>.msi   (instalador MSI)
  y en -OutDir deja además:
    <archivo>.sha256    hash de cada archivo, formato de `sha256sum`
    SHA256SUMS.txt      todos los hashes juntos
    release-notes.md    tabla de descarga con los hashes, para la release

.EXAMPLE
  pwsh scripts/package-release.ps1 -Version 0.1.0
#>
param(
  [Parameter(Mandatory)][string]$Version,
  [string]$OutDir = 'release'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Texto ASCII con finales LF, sin importar el sistema.
function Write-Lf([string]$Path, [string[]]$Lines) {
  [IO.File]::WriteAllText([IO.Path]::GetFullPath($Path), (($Lines -join "`n") + "`n"), [Text.Encoding]::ASCII)
}
$bundle = Join-Path $root 'target/release/bundle'
$os = 'windows'

$sources = @(
  @{ Dir = 'nsis'; Filter = '*.exe'; Ext = 'exe'; Label = 'Instalador (.exe)' }
  @{ Dir = 'msi'; Filter = '*.msi'; Ext = 'msi'; Label = 'Instalador MSI (.msi)' }
)

if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force $OutDir | Out-Null

$artifacts = foreach ($s in $sources) {
  # Solo el de esta versión: el bundle puede tener restos de builds anteriores.
  $found = @(Get-ChildItem (Join-Path $bundle $s.Dir) -Filter $s.Filter -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*_${Version}_*" })
  if ($found.Count -ne 1) {
    Write-Error "Se esperaba 1 archivo $($s.Filter) de la versión $Version en $($s.Dir), hay $($found.Count)."
  }
  $name = "${os}_${Version}.$($s.Ext)"
  $dest = Join-Path $OutDir $name
  Copy-Item $found[0].FullName $dest
  $hash = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLowerInvariant()
  # Formato de `sha256sum`: "<hash>  <archivo>" (dos espacios), con LF: con CRLF
  # `sha256sum -c` toma el `\r` como parte del nombre y no encuentra el archivo.
  Write-Lf "$dest.sha256" @("$hash  $name")
  [pscustomobject]@{ Name = $name; Hash = $hash; Label = $s.Label; Size = (Get-Item $dest).Length }
}

Write-Lf (Join-Path $OutDir 'SHA256SUMS.txt') ($artifacts | ForEach-Object { "$($_.Hash)  $($_.Name)" })

$rows = $artifacts | ForEach-Object {
  "| $($_.Label) | ``$($_.Name)`` | $([math]::Round($_.Size / 1MB, 1)) MB | ``$($_.Hash)`` |"
}
@"
## Descargas (Windows)

| | Archivo | Tamaño | SHA-256 |
|---|---|---|---|
$($rows -join "`n")

### Verificar la descarga

En PowerShell, el hash tiene que coincidir con el de la tabla (o con ``SHA256SUMS.txt``):

``````powershell
(Get-FileHash .\$($artifacts[0].Name) -Algorithm SHA256).Hash
``````
"@ | Out-File -FilePath (Join-Path $OutDir 'release-notes.md') -Encoding utf8

Write-Host "Artefactos en ${OutDir}:"
$artifacts | ForEach-Object { Write-Host "  $($_.Name)  $($_.Hash)" }
