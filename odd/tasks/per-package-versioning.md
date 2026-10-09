# per-package-versioning — versión independiente por paquete

## Objetivo

Versionar por separado `desktop`, `server` y `web`. Solo el desktop publica
releases de GitHub.

## Problema

Hoy hay una única versión (la del desktop, en 3 fuentes) y `AGENTS.md`
habla de "la versión de la app". Con el server Nest y la web en el
monorepo, cada paquete evoluciona a su ritmo y necesita su propia versión.

## Decisiones del usuario (2026-10-07)

- Desktop: tags `vX.Y.Z` sin prefijo (se entiende que es la app de
  escritorio; continúa desde `v0.2.0`). Única que genera release de GitHub.
- Server: `apps/server/package.json`, tags `server-vX.Y.Z`.
- Web: `apps/web/package.json`, tags `web-vX.Y.Z` (la app nace en T6b de
  `nest-server`; el chequeo se activa cuando exista).
- Artefactos del desktop: `opencollab-<so>-<versión>.<ext>` (p. ej.
  `opencollab-windows-0.3.0.exe`), con su `.sha256` y `SHA256SUMS.txt`.
- `PROTOCOL_VERSION` sigue independiente de las tres.

## Alcance autorizado

Rama `feature/per-package-versioning` (desde `develop`). Tocar:
`scripts/check-version.ps1`, `scripts/package-release.ps1`,
`.github/workflows/release.yml`, `.github/workflows/ci.yml` (paso de
versión), `AGENTS.md` (Versionado, CI/CD, Git Flow) y este documento.

## Checklist

- [x] **V1** — `check-version.ps1 -Package desktop|server|web [-Tag]`:
  desktop valida las 3 fuentes y tag `vX.Y.Z`; server/web validan su
  `package.json` y tag `<paquete>-vX.Y.Z`; web falla claro si el paquete no
  existe. Default `desktop` (compatibilidad).
- [x] **V2** — `package-release.ps1` y `release.yml`: nombres
  `opencollab-windows-<versión>.{exe,msi}`; release solo con tags `v*.*.*`
  del desktop.
- [x] **V3** — CI: chequeo de versión de desktop y server.
- [x] **V4** — `AGENTS.md`: Versionado por paquete, ramas
  `release/X.Y.Z` (desktop), `release/server-X.Y.Z`, `release/web-X.Y.Z` (y
  `hotfix/` igual), convención de nombres de artefactos.

## Checks aplicables

Sin runner de tests para los scripts PowerShell (TDD no aplica a estos
archivos): verificación funcional ejecutando `check-version.ps1` en todos
los casos (ok, tag correcto/incorrecto, paquete inexistente) y
`package-release.ps1` contra instaladores falsos en una carpeta temporal.

## Ruta

Delegado directo: un writer (5 archivos no triviales).

## Progreso

- 2026-10-07: creado. Rama `feature/per-package-versioning` desde `develop`.
- 2026-10-07: V1–V4 implementados (sin commit). Evidencia: `check-version.ps1` sin args = ok (0.2.0); `-Package desktop -Tag v0.2.0` ok, `-Tag v9.9.9` falla; `-Package web` falla claro (paquete inexistente). `apps/server/package.json` NO existe en esta rama (`apps/server/` está sin trackear y sin package.json), así que `-Package server` falla acá; verificado en un árbol temporal con un package.json falso: ok, `-Tag server-v0.1.0` ok, `-Tag v0.1.0` falla. `package-release.ps1 -Version 0.0.0-test` con instaladores falsos produjo `opencollab-windows-0.0.0-test.{exe,msi}` + `.sha256` + `SHA256SUMS.txt` + `release-notes.md`; `sha256sum -c` OK. Bug propio corregido en el camino (`$Relative:` se parseaba como variable con ámbito). `actionlint` y PyYAML no disponibles: workflows sin parsear. Pendiente: el paso de CI de server fallará hasta que `apps/server/package.json` esté versionado en el repo (lo introduce `nest-server`).

- 2026-10-07: el parent ajustó V3: el paso de CI verifica desktop siempre y
  server/web solo si existe su `package.json` (se activan solos al
  mergear `nest-server` y T6b). Simulado localmente: desktop ok, server y
  web salteados en `develop`. Commit work-unit en esta rama.
- 2026-10-07: Review de `5752498` (4 lentes, riesgo alto por shell en CI,
  consent granted): aprobada y acknowledged. Corregido inline: el guard
  `$LASTEXITCODE` cortaba el loop con éxito antes de la web (variable sin
  setear → `exit $null`); se quitó (el script corta con error terminante) y
  se loguea cuando un paquete se saltea; `AGENTS.md` alineado. Simulado en
  un árbol temporal: desktop y server verificados, web salteada con log,
  server con versión inválida → exit 1.
- 2026-10-07: Review de `3d8f5cd` (4 lentes, consent granted): aprobada y
  acknowledged. Aviso R3-001 (el paso depende del error terminante del
  script) verificado y aceptado: el script fija `$ErrorActionPreference =
  'Stop'`, el shell `pwsh` de Actions también, y la simulación con versión
  inválida dio exit 1. Feature lista para PR a `develop` (cuando el
  usuario decida el push).
