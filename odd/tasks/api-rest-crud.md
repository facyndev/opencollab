# API REST CRUD — workspaces, sessions, terminals, invitations

Objective: expose the existing domain + persistence (Workspace/Session/Terminal/Invitation) as authenticated REST endpoints so the desktop (Feature 2: dual storage mode) has a cloud CRUD surface to call.
Branch: feature/api-rest-crud | Delivery: PR a develop | Test runner: `pnpm --filter @opencollab/server test` (unit) + `pnpm --filter @opencollab/server test:integration` (needs Postgres via `DATABASE_URL`)

## Specs

- S1: `POST /workspaces` — any authenticated user creates a workspace; the caller becomes owner. Body: `{ "name": string }` (trimmed, 1..100 chars). Returns the created workspace view (201).
- S2: `GET /workspaces` — lists every workspace where the caller is owner or member, each with its member count. Returns an array (200).
- S3: `GET /workspaces/:id` — workspace detail (name, owner, members with username/displayName). Owner or member only; 404 if not found, 403 if the caller has no access.
- S4: `POST /workspaces/:workspaceId/sessions` — creates a session in the workspace. Owner only (matches domain `Session.create` which requires `workspace.ensureOwner(actor)`). Body: `{ "name": string }` (trimmed, 1..100). Returns the session view (201). 403 for non-owner members, 404 if the workspace does not exist or the caller has no access.
- S5: `GET /workspaces/:workspaceId/sessions` — lists the sessions of the workspace (owner or member), each with its terminals in position order. Returns an array (200).
- S6: `GET /sessions/:id` — session detail with terminals (id, name, command, args, cwd). Viewable by anyone who can view the session (owner, member, or guest — matches `session.canView(workspace, user)`). 404 if not found, 403 if no view access.
- S7: `POST /sessions/:id/terminals` — appends a terminal to the session. Owner only (domain `addTerminal` is owner-only). Body: `{ "name": string, "command": string, "args"?: string[], "cwd"?: string | null }`. Returns the terminal view (201). Env is never accepted nor persisted (domain rule: env may hold secrets).
- S8: `DELETE /sessions/:id/terminals/:terminalId` — removes the terminal. Owner only. 204 on success; 404 if session or terminal not found; 403 if not owner.
- S9: `POST /workspaces/:id/invitations` — invites a user to the workspace as member. Owner only (domain `inviteMember`). Body: `{ "inviteeId": string }` (a UserId). Creates the invitation as pending. Returns the invitation view (201). 403 for non-owners; 409 if the invitee is already owner or member (`AlreadyHasAccess`).
- S10: `POST /sessions/:id/invitations` — invites a user to the session as guest. Owner only (domain `inviteGuest`). Body: `{ "inviteeId": string }`. Returns the invitation view (201). 403 for non-owners; 409 if the invitee already has a role (`AlreadyHasAccess`).
- S11: `GET /invitations` — lists the caller's pending, non-expired invitations (uses `InvitationRepository.listPendingFor`). Each entry carries the target (workspace or session) and who invited. Returns an array (200).
- S12: `POST /invitations/:id/accept` — accepts an invitation. Only the invitee may accept (403 otherwise). Applies the domain accept (`Workspace.acceptInvitation` or `Session.acceptInvitation`), persists the workspace/session, and marks the invitation accepted. 204 on success; 404 if not found; 409 if already responded/revoked/expired.
- S13: `POST /invitations/:id/decline` — declines an invitation. Only the invitee (403 otherwise). Marks it declined. 204; 404 if not found; 409 if already responded/revoked/expired.
- S14: All endpoints require `Authorization: Bearer <access token>` (reuse `AccessGuard` + `CurrentUser`); missing/invalid token → 401. Bodies are validated with zod + `ZodPipe` (strict: unknown fields rejected); invalid body → 400 with field paths only, never echoing submitted values.
- S15: Domain errors map to HTTP: `NotOwner` → 403, `AlreadyHasAccess` → 409, `NotAParticipant` → 403, `TerminalNotInSession` → 404, invitation already responded → 409. Persistence changes are transactional: a failed accept never leaves a half-applied workspace/session plus an accepted invitation.

Assumptions (marked as such, not user requirements):
- A1: "terminales" as an API resource means the persisted terminal profile (name/command/args/cwd), not live PTY streaming — live I/O already goes through the WebSocket gateway (`collab.gateway.ts`).
- A2: Renaming workspaces/sessions, removing members, and changing session access via REST are out of scope for this feature (access changes already exist as the `access_changed` WS frame).
- A3: `WorkspaceRepository` gains a `listForUser` method (it currently only has find/save); `InvitationRepository` is added to `PersistenceModule` exports (currently missing).

## Tasks

- T1 (S1-S3, S14): WorkspacesController — list/create/get + `WorkspaceRepository.listForUser` + module wiring; int tests RED→GREEN. route: inline — DONE (13 int tests, unit 166, int 107, typecheck ok). Review: tier high (463 lines), outcome granted/acknowledged (lineage review-78dd02cdbbd5c9c3, 0 blockers; advisory R3-001/R3-002 → L6)
- T2 (S4-S6, S14-S15): SessionsController — create/list/get sessions + terminals in views; int tests RED→GREEN. route: inline
- T3 (S7-S8, S14-S15): TerminalsController — add/remove terminal; int tests RED→GREEN. route: inline
- T4 (S9-S13, S15): InvitationsController + accept/decline orchestration service; int tests RED→GREEN. route: inline
- T5 (S1-S15): AppModule wiring, full unit + integration suite green, typecheck + build. route: inline

## Log

- L1 (2026-10-14, user verbatim): "En la API ya se encuentran los endpoints para la creación de workspaces - sesiones - terminales e invitaciones. Lo ideal es que el usuario tenga 2 opciones al usar la aplicación, almacenar todo local (podria ser en appdata) o guardar todo en "cloud" que seria que se interactue con la API."
- L2 (2026-10-14, verification): Checked the premise against develop HEAD 6a45795: the API has NO REST endpoints for workspaces/sessions/terminals/invitations — only `/auth/*`, `/health`, the WS gateway, and internal repositories. User confirmed the scope split.
- L3 (2026-10-14, user decision): Dual-mode product decisions (for Feature 2, recorded here for continuity): mode selection = "Onboarding + Settings"; collaboration in local mode = "Visibles pero inactivas"; switching local→cloud = "Migrar local → cloud".
- L4 (2026-10-14, user decision): Scope = "Dos features secuenciales": this feature builds the API REST CRUD first; Feature 2 (desktop dual storage mode) follows in a separate feature branch.
- L5 (2026-10-14, T1 done): WorkspacesController (POST/GET /workspaces, GET /workspaces/:id) implemented with `WorkspaceRepository.listForUser`, `UserRepository.findByIds`, zod `ZodPipe` validation, `AccessGuard`. New `CollabModule` imports PersistenceModule + AuthModule; AuthModule now exports `AuthService` and `AccessGuard` (previously only SessionService/SessionRevocations). Added `collab/test-app.ts` (bootstraps AuthModule+CollabModule against the `_test` database). Verified: unit 166/166, integration 107/107, typecheck clean.
- L6 (2026-10-15, T1 review): RDD review of commit 2e3e113 (lineage review-78dd02cdbbd5c9c3, tier high, 463 changed lines, 3 lenses risk/readability/reliability) reached approved; authority burned, no corrections, 0 blocking findings. Advisory (non-blocking, candidates for T5 test hardening — not authorized scope by themselves): R3-001 `GET /workspaces/:id` casts the raw route param to WorkspaceId without a malformed-id failure-path assertion (400 vs 404 vs 500 unproved); R3-002 create-body upper boundary/shape handling and summary memberCount lack observable assertions (overlong name, non-string name, trimmed persistence, memberCount).
