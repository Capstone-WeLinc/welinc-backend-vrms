# welinc-backend-vrms

## Overview

The VRMS API: NestJS 11 with Prisma 7 on PostgreSQL, listening on port 3002 (set by `PORT`). It owns repair tickets, issues, parts, vehicles, garages, mechanics, drivers, the knowledge base and audit logs. It owns no accounts: it verifies JWTs issued by `welinc-auth`, then checks the caller's session with `welinc-auth` (spec 0009, spec 0003). It also serves the VRMS login and refresh routes under `/vrms/session`. It is reached through the gateway at `/vrms` and `/repairs`.

## Key files

| File | Owns |
|---|---|
| `src/main.ts` | Bootstrap, `trust proxy` from `TRUST_PROXY_HOPS`, `cookie-parser`, global `ValidationPipe`, listen on `PORT` |
| `src/app.module.ts` | Root module wiring |
| `src/auth/` | `JwtAuthGuard`, `account-check.ts` (the session check: `GET /auth/session`, cached by `sid` for 30 s, ended answers until the token's `exp`, one shared call per `sid`, fail closed; the caller's name comes from it, the roles from the token) and `roles.ts` (`UserRole` and `SystemType`) |
| `src/session/` | The VRMS session routes (spec 0003), the reference other groups copy: `session.controller.ts` (`start`, `callback`, `refresh`, `activity`, `logout` are `@Public()`, `status` is `@Authenticated()`; `refresh` also answers `sessionAbsoluteExpiresAt`, the 12 hour end; `logout` falls back to the bearer token's `sid`), `auth-client.ts` (the code exchange and refresh calls to `/auth/token` with the client assertion and `X-WeLinc-User-Address`, 3 s timeout, `ended`, `no_access` or `unavailable`), `cookies.ts` (`vrms_rt` and the per attempt `vrms_login_<state prefix>`, both on `/vrms/session`), `csrf.guard.ts` (`SessionCsrfGuard`, `Origin` must equal `WEB_APP_URL`), `session.config.ts` |
| `src/auth/verify/` | The token check (spec 0002): ES256 verify against welinc-auth's published keys, and this service's own token for calls to welinc-auth. Self contained so other groups can copy it; see its `README.md` |
| `src/auth/permissions/` | The permission matrix (spec 0011): `catalog.ts` (the one definition of keys, defaults and locks), `permissions.service.ts` (stored grants, startup backfill, version cache), `ability.factory.ts` (CASL ability per request), `permissions.guard.ts` and `permission.decorators.ts` (`@RequirePermission`, `@Authenticated`, `@Public`), `permission-matrix.service.ts` and `permissions.controller.ts` (the `/vrms/permissions` API) |
| `src/modules/vrms/mechanic-work.service.ts` | Open work for a person who leaves VRMS: `GET /vrms/mechanics/:authUserId/open-work` and `POST .../release-tickets`. Also the Users page workload: `GET /vrms/mechanics/workload` and `GET /vrms/mechanics/:authUserId/open-tickets`, all behind `users.manage`, except that `open-tickets` also accepts `mechanics.view` (the Chief dashboard Team dialog, spec 0022) |
| `src/modules/vrms/mechanic-workload.ts` | The one "Occupied" rule (`isOccupied`: at least one In Progress ticket) and the workload counts by open status |
| `src/modules/vrms/mechanic-roster.service.ts` | Keeps in house `Mechanic` rows in step with `welinc-auth` users: `apply` (one directory person, used by the poll), `refreshOne` (`POST /vrms/mechanics/:authUserId/refresh`, through the directory lookup) and the just in time row on first request. Each row stores the person's VRMS role in `mechanics.role` (`MECHANIC`, `CHIEF_MECHANIC` or empty; kept when someone loses access), and `GET /vrms/mechanics/roster` (`mechanics.view` or `users.manage`) returns the active roster plus inactive people holding open tickets, with `mechanicId`, `occupied`, `total` and `byStatus` per row |
| `src/modules/vrms/directory/` | Spec 0005: `auth-directory.client.ts` (the only reader of welinc-auth's `/auth/directory/*`, with VRMS's service token; `DirectoryCursorError` means read everything again, `DirectoryUnavailableError` anything else), `directory-sync.service.ts` (one tick: a full read when `directory_sync_state.cursor` is null, else up to 10 feed pages; a lease so one copy runs at a time; one warning while welinc-auth fails; `recover()` behind `POST /vrms/mechanics/sync`, 409 `SYNC_RUNNING`) and `directory-poll.job.ts` (every 30 s, no overlap in one process) |
| `src/modules/vrms/repairs.controller.ts`, `repairs.service.ts` | Repair ticket endpoints and business rules |
| `src/modules/vrms/audit-events.ts` | Audit event names and builders for the ticket timeline; each event carries a `changes` list of field, before and after |
| `src/modules/vrms/ticket-statuses.ts` | The one definition of open and finished ticket statuses (spec 0010); queries read it, never a list of their own |
| `src/modules/vrms/odometer.ts` | The odometer floor (`vehicleOdometerFloor`) and the below last and jump rules for a new ticket (spec 0016); create and the vehicle summary both read it. `ticketOdometerBounds` gives an edited ticket its floor and ceiling from the truck's other tickets, ordered by `(createdAt, id)` (spec 0019) |
| `src/modules/vrms/ticket-edits.service.ts`, `ticket-edits.ts`, `ticket-inputs.ts` | Editing a ticket after create (spec 0019): details, the full mechanic list and issues; `ticket-edits.ts` holds the lock, stale and stamp helpers, `ticket-inputs.ts` the driver, corporation and issue text helpers that create shares |
| `src/modules/vrms/lookups/`, `src/modules/vrms/vehicles/` | Generic lookup lists (`vehicle_type`, `corporation`) behind `lookups.manage` with a `LookupValueChange` history, and the Settings Vehicles endpoints behind `vehicle.manage` with a `VehicleChange` history (spec 0016) |
| `src/modules/vrms/config/` | VRMS configuration endpoints (dropdown lists and settings) |
| `src/modules/vrms/dto/` | Request DTOs validated with `class-validator` |
| `src/modules/knowledge/` | Knowledge base API at `/vrms/knowledge` (spec 0007): categories, entries, stats, suggestions and grouping; its four business values come from `SettingsService`, the fixed tuning constants stay in `knowledge.tuning.ts` |
| `src/modules/analytics/` | The eight `/vrms/analytics/*` endpoints (spec 0013): `AnalyticsService` runs live `$queryRaw` over the VRMS tables, and `maskCosts()` nulls the peso fields without `ticket.costs.view` |
| `src/modules/ai/` | AI diagnosis and embeddings (spec 0013): `ai-provider.ts` is the one seam to a provider (`gemini.provider.ts`, `ai-provider.fake.ts` for tests), `diagnosis.service.ts` runs and stores diagnoses, `embedding.service.ts` and `embedding-catchup.job.ts` keep `issue_embeddings` current |
| `src/settings/` | Settings and module switches (spec 0012): `catalog.ts` is the one definition of every setting, `SettingsService.get(key)` reads them, `GET` and `PATCH /vrms/settings` and `GET /vrms/settings/changes` save and log them, and `module-disabled.ts` is the 403 `MODULE_DISABLED` answer |
| `src/modules/vrms/ticket-knowledge.ts` | What a ticket's issues carry from the knowledge base, and the "What fixed it" rules on the move to For verification |
| `src/modules/vrms/checklist-edits.service.ts`, `checklist-edits.ts` | Per ticket checklist edits (spec 0023): `PUT /vrms/repairs/:id/issues/:issueId/steps` behind `ticket.checklist.edit` (CASL `editChecklist`), and the pure rules (`normalizeStepText`, `cleanSteps`, `checklistDiff` with the moved set, the four `STEP_*` audit builders) |
| `src/shared/` | `PrismaService`, `SharedModule` |
| `prisma/schema.prisma`, `prisma/migrations/` | Data model and migration history |
| `prisma/seed.ts`, `prisma/seeds/` | Seed data (`npm run seed`): `people.json` is a byte for byte copy of welinc-auth's manifest (spec 0006; check it with `npm --prefix welinc-auth run seed:check -- welinc-backend-vrms/prisma/seeds/people.json`), `shared-ids.ts` reads it (`seedActor`, `vrmsRole`) and `mechanics.seed.ts` makes a `Mechanic` row per VRMS mechanic or chief in it; `catalog.ts` holds the fleet, problems, parts and prices; `repairs.seed.ts` plays out each truck's history in order |

## Commands

```bash
npm run start:dev    # nest --watch
npm run lint         # runs eslint with --fix, so it edits files
npm run build
npm run test         # Jest unit tests
npm run test:e2e
npm run seed         # wipes and rebuilds the data (and resets the permission matrix to the catalog defaults); SEED=<n> npm run seed repeats a run
npm run permissions:prune   # deletes matrix rows whose key left the catalog; startup never deletes them
npm run settings:prune      # deletes stored settings whose key left the catalog, logged as a reset by System
npm run ai:embed-all        # embeds every issue that has no current embedding, 50 at a time with a pause; safe to run again, run once per environment after deploy
npm run studio       # Prisma Studio on 5555
npx prisma generate
npx prisma migrate dev   # asks first, see root rules
```

## Conventions

- Every route carries exactly one of `@RequirePermission(key)`, `@Authenticated()` or `@Public()`; a route with none answers 403, and `route-permissions.spec.ts` fails on it. Role names are `ADMIN`, `CHIEF_MECHANIC` and `MECHANIC`, but code never checks a role: it asks the CASL ability (`PermissionsService.abilityFor(user)`). Ownership ("assigned to me") is a rule condition, and the ability is built per request because it carries the caller's id. A new action adds its key to `catalog.ts` (Admin on, others off unless its spec says otherwise) plus its CASL rule and decorator (spec 0011).
- Every request body is a DTO class with `class-validator` decorators. The global `ValidationPipe` rejects anything else.
- Database access goes through `PrismaService`, never a new `PrismaClient`.
- Repair updates use optimistic locking. The client sends `lastUpdatedAt` and a stale write is rejected. Keep that check on any new update path (see `update-costs.dto.ts` and `update-repair-status.dto.ts`).
- Any path that changes a ticket's `repairStatus` must also set `statusChangedAt` in the same update (spec 0015); `applyStatusMove` does, so go through it. The For verification list sorts on it.
- Ticket changes write audit events through `audit-events.ts`, so a new state change should add one.
- Every audit event type needs a category in `AUDIT_CATEGORY` (spec 0021; the compiler enforces it), and an action that writes several rows stamps them 1 ms apart with `stampedAt`, setting `lastActivityAt` to the newest. `audit_logs` is append only: a database trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`, so a migration or script that must touch it has to switch the triggers off inside itself and say why (the seed does, in a `finally`). Never call `auditLog.update`, `delete` or `upsert`; a guard test fails the build.
- A ticket edit (spec 0019) runs `assertFresh`, then `stampEdit` from `ticket-edits.ts` as the first write in its transaction: the guarded `updateMany where { id, updatedAt }` that sets `editedAt`, `editedByUserId` and `editedByName` from the token (`count === 0` answers 409). A save that changes nothing writes no audit row and no stamp. Locked Closed and Cancelled tickets answer `TICKET_LOCKED`; unlocked ones need a `reason`.
- A checklist save (spec 0023) locks on the issue's `checklist_version`, never the ticket's `updatedAt`, so it never makes other ticket edits stale. Any path that deletes or replaces an issue's steps must raise `checklistVersion` (`{ increment: 1 }`) as its first write on that issue (today: `linkKnowledge`, the `clearsFix` issue edit, an approved suggestion that copies steps), or an open Edit steps dialog can save over it. `normalizeStepText` and `checklistDiff` in `checklist-edits.ts` are the one normalizer and the one diff.
- An issue's stored `description` is always built by `issueDescription` in `ticket-inputs.ts` (`[System] rootCause: text`), on create and on edit alike.
- The photo rules on Start work, Send for verification and Close (spec 0018) run inside `applyStatusMove` through `modules/vrms/photo-rules.ts`, after the conditional update takes the row lock, never in a controller. A new move that needs a photo rule goes through the same place, and `blockedBy` on each move comes from the same check.
- `workStartedAt` on a ticket is written only by `applyStatusMove` (spec 0018). It decides the derived Before or After label on photos, so nothing else should set it.
- A truck has at most one ticket in an open status, enforced only by `RepairsService.create` (a row lock on the vehicle, then the check). Any new path that inserts a ticket must go through `create` (spec 0016).
- Knowledge entry and category writes log one `KnowledgeEntryChange` row per changed field in the same transaction (`knowledge-changes.ts`). Knowledge "who" fields hold the JWT email with no foreign key, like `AuditLog`.
- Every schema change needs a migration folder under `prisma/migrations/`, named with a timestamp. The history starts at one baseline, `20261029000000_baseline` (spec 0010); add new folders after it.
- New variables go in `.env.example` only (today: `PORT`, `NODE_ENV`, `DATABASE_URL`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_INTERNAL_URL`, `AUTH_CLIENT_ID`, `AUTH_CLIENT_PRIVATE_KEY` (all five required, the app refuses to start without them), `WEB_APP_URL`, `PORTAL_URL`, `AUTH_PUBLIC_URL`, `API_PUBLIC_URL` (required in production; `<API_PUBLIC_URL>/vrms/session/callback` must equal welinc-auth's registry row), `SESSION_COOKIE_SECURE`, `TRUST_PROXY_HOPS`, `CORS_ORIGINS`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_EMBED_MODEL`, `STORAGE_CONNECTION_STRING`, `STORAGE_ACCOUNT_URL`, `STORAGE_CONTAINER`, `STORAGE_PUBLIC_URL`). With no `GEMINI_API_KEY` the app still starts: AI runs answer 503 `AI_UNAVAILABLE` and analytics works. With no storage setting the app starts and attachment routes answer 503 `STORAGE_UNAVAILABLE`.
- "Occupied" is defined once, as `isOccupied` in `mechanic-workload.ts`. The Users page workload and the assignment picker's `busy` both read it, so never work it out again somewhere else. Unassign and Reassign on that page go through `PUT /vrms/repairs/:id/assignments`, not a new write route.
- Read people from welinc-auth only through `AuthDirectoryClient` (spec 0005). Never call `/auth/users` from this service: it answers service tokens 403 (AC-21).
- Roles and systems come from `src/auth/roles.ts`, not `@prisma/client`: this database holds no users. `Mechanic.authUserId` and `AuditLog.actorUserId` are `welinc-auth` user ids (no foreign key); look a caller up by `req.user.sub`, never by email or name.

## Gotchas

- In the local Docker stack, the `welinc_vrms_backend` container does not see edits made from Windows. Run `docker restart welinc_vrms_backend` and wait for "Nest application successfully started" before testing the API.
- There is no `JWT_SECRET`: tokens are checked with welinc-auth's published keys. `AUTH_CLIENT_PRIVATE_KEY` comes from `npm run keys:dev` in welinc-auth, and `AUTH_ISSUER` must equal welinc-auth's string exactly, or every request returns 401. If welinc-auth's keys can't be reached and no copy is left, requests answer 503 `AUTH_UNAVAILABLE`, never 401.
- `@nestjs/platform-express` pins its own `multer`, and that copy handles uploads, so bumping the top level `multer` alone changes nothing. `"multer": "$multer"` in `package.json` `overrides` makes Nest use ours; check `npm ls multer` after any upgrade. The `glob` and `minimatch` overrides there patch dev tools only.
- `npm run lint` fixes files in place, so check `git diff` afterwards.
- A deactivation or an ended session in `welinc-auth` reaches VRMS within 30 seconds, because each session's answer is cached in memory by `sid` for that long. A role change reaches VRMS at the next refresh (15 minutes at most), because the roles come from the token. A lock ends no live session. If `welinc-auth` is down, uncached requests get 503.
- A token without a `sid` (from before spec 0003) gets 401 `SESSION_ENDED`, and an expired one 401 `TOKEN_EXPIRED`, which the web app answers with one refresh and one retry.
- An Admin's matrix edits live in `role_permissions` and apply on the next request on every replica, because each checked request reads `permission_matrix.version`. A hand edit in the database applies only after you bump that version. A replica that has never loaded the matrix answers 503 on `GET /` until a request loads it. A `PATCH /vrms/permissions` that takes a right away needs a `note` of 5 to 500 characters (400 otherwise); adding rights needs none.
- Settings work the same way through `settings_state.version`, read together with the matrix version. A module switched off removes its permission keys and answers 403 `MODULE_DISABLED`. Every `/vrms/ai/*` route and the embedding paths check the AI switch.
- The baseline migration needs the `pg_trgm` extension and seeds the issue categories itself (Brakes to Transmission, plus General), so `npm run seed` must not create or delete them.
- Embeddings use pgvector. The extension is created in plain SQL by the `ai_diagnosis` migration (no preview feature), so the database image must be `pgvector/pgvector:pg16` locally and `azure.extensions` must include `VECTOR` on Azure. The vector column is `Unsupported`, so read and write it with `$queryRaw`; Prisma Studio cannot show `issue_embeddings`.
- The free Gemini tier counts a batch of texts as one request per text and allows about 100 a minute and 1K a day. Keep embed batches at 50 (`EMBED_BATCH_SIZE`). Only `src/modules/ai/` may talk to a provider, always through `AiProvider`.

## Agent skills

- [nestjs-best-practices](../.claude/skills/nestjs-best-practices/): `kadajett/agent-nestjs-skills`, modules, DI and security
- [prisma-client-api](../.claude/skills/prisma-client-api/), [prisma-cli](../.claude/skills/prisma-cli/): `prisma/skills`, Prisma 7 queries and CLI
- [azure-blob-storage](../.claude/skills/azure-blob-storage/): `microsoftdocs/agent-skills`, Blob Storage, signed links and managed identity (ticket attachments)
- Declined: Agent Skills for `sharp`, `pdf-lib`, `heic-convert`, `multer` and `@nestjs/throttler` (2026-11-01 search found only weak matches)

## Context files

- [src/modules/attachments/AGENTS.md](src/modules/attachments/AGENTS.md): ticket file uploads, the rebuild pipelines, signed links, retention and the error order (spec 0017)

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
