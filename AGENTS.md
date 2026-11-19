# welinc-backend-vrms

## Overview

The VRMS API: NestJS 11 with Prisma 7 on PostgreSQL. It owns repair tickets, issues, parts, vehicles, garages, mechanics, drivers, the knowledge base and audit logs. It owns no accounts: it verifies JWTs issued by `welinc-auth`, then checks the caller's session with `welinc-auth` (spec 0009, suite spec 0003). It also serves the VRMS login and refresh routes under `/vrms/session`. It is reached through the gateway at `/vrms/` only.

## Key files

| File | Owns |
|---|---|
| `src/main.ts` | Bootstrap, `trust proxy` from `TRUST_PROXY_HOPS`, `cookie-parser`, global `ValidationPipe`, listen on `PORT` |
| `src/auth/` | `JwtAuthGuard`, `account-check.ts` (the session check against welinc-auth, cached per `sid`, fail closed; see Gotchas) and `roles.ts` (`UserRole`, `SystemType`) |
| `src/session/` | The VRMS session routes (suite spec 0003), the reference other groups copy: the controller, `auth-client.ts` (calls to `/auth/token`), `cookies.ts` (`vrms_rt` and the login cookies on `/vrms/session`), `csrf.guard.ts` (`Origin` must equal `WEB_APP_URL`) |
| `src/auth/verify/` | The token check (suite spec 0002): ES256 verify against welinc-auth's published keys, and this service's own token for calls to welinc-auth. Self contained so other groups can copy it; see its `README.md` |
| `src/auth/permissions/` | The permission matrix (spec 0011; edited in welinc-auth since suite spec 0013): `catalog.ts` (the keys VRMS checks; labels and defaults live in welinc-auth's `prisma/catalog/vrms.ts`), `permissions.service.ts` and `permission-matrix.service.ts` (grants and the version cache; a missing row denies), `sync/` (the 60 s pull from welinc-auth), `ability.factory.ts` (CASL), `permission.decorators.ts`, `permissions.fake.ts` (a test copy of welinc-auth's defaults) |
| `src/modules/vrms/mechanic-work.service.ts` | Open work, workload and the release of a person's tickets (routes in `config/config.controller.ts`); the released list reads `MECHANIC_UNASSIGNED` rows with the `SYSTEM` actor |
| `src/modules/vrms/mechanic-workload.ts` | The one "Occupied" rule (`isOccupied`: at least one In Progress ticket) and the workload counts by open status |
| `src/modules/vrms/mechanic-roster.service.ts` | Keeps in house `Mechanic` rows in step with welinc-auth users (the poll, a refresh, the just in time row on first request); `mechanics.role` keeps the last VRMS role when someone loses access |
| `src/modules/vrms/directory/` | Suite spec 0005 directory sync: `auth-directory.client.ts` (the only reader of `/auth/directory/*`), `directory-sync.service.ts` (one leased tick, `recover()`), `directory-poll.job.ts` (every 30 s), `people-copy.ts` (`vrms_people`, the Users page list) |
| `src/modules/vrms/directory/erasure-rewrite.ts`, `src/modules/vrms/mechanic-work.service.ts` | Suite spec 0012: an `erased` feed entry rewrites name copies to "Deleted user" (emails to null, ticket notes never); a deleted, deactivated or de-roled mechanic's open tickets are unassigned (Assigned goes back to Open, In progress keeps its status) |
| `src/modules/vrms/repairs.controller.ts`, `repairs.service.ts` | Repair ticket endpoints and business rules |
| `src/modules/vrms/audit-events.ts` | Audit event names and builders for the ticket timeline; each event carries a `changes` list of field, before and after |
| `src/modules/vrms/ticket-statuses.ts` | The one definition of open and finished ticket statuses (spec 0010); queries read it, never a list of their own |
| `src/modules/vrms/odometer.ts` | The odometer floor (`vehicleOdometerFloor`) and the below last and jump rules for a new ticket (spec 0016); create and the vehicle summary both read it. `ticketOdometerBounds` gives an edited ticket its floor and ceiling from the truck's other tickets, ordered by `(createdAt, id)` (spec 0019) |
| `src/modules/vrms/ticket-edits.service.ts`, `ticket-edits.ts`, `ticket-inputs.ts` | Editing a ticket after create (spec 0019): details, the full mechanic list and issues; `ticket-edits.ts` holds the lock, stale and stamp helpers, `ticket-inputs.ts` the driver, corporation and issue text helpers that create shares |
| `src/modules/vrms/lookups/`, `src/modules/vrms/vehicles/` | Generic lookup lists (`vehicle_type`, `corporation`) behind `lookups.manage` with a `LookupValueChange` history, and the Settings Vehicles endpoints behind `vehicle.manage` with a `VehicleChange` history (spec 0016) |
| `src/modules/vrms/config/` | Dropdown lists, the vehicle summary, and the `/vrms/mechanics/*` and `/vrms/people` routes |
| `src/modules/knowledge/` | Knowledge base API at `/vrms/knowledge` (spec 0007): categories, entries, stats, suggestions and grouping; its four business values come from `SettingsService`, the fixed tuning constants stay in `knowledge.tuning.ts` |
| `src/modules/analytics/` | The eight `/vrms/analytics/*` endpoints (spec 0013): `AnalyticsService` runs live `$queryRaw` over the VRMS tables, and `maskCosts()` nulls the peso fields without `ticket.costs.view` |
| `src/modules/ai/` | AI diagnosis and embeddings (spec 0013): `ai-provider.ts` is the one seam to a provider (`gemini.provider.ts`, `ai-provider.fake.ts` for tests), `diagnosis.service.ts` runs and stores diagnoses, `embedding.service.ts` and `embedding-catchup.job.ts` keep `issue_embeddings` current |
| `src/settings/` | Settings and module switches (spec 0012): `catalog.ts` is the one definition of every setting, `SettingsService.get(key)` reads them, `GET` and `PATCH /vrms/settings` and `GET /vrms/settings/changes` save and log them, and `module-disabled.ts` is the 403 `MODULE_DISABLED` answer |
| `src/modules/vrms/ticket-knowledge.ts` | What a ticket's issues carry from the knowledge base, and the "What fixed it" rules on the move to For verification |
| `src/modules/vrms/checklist-edits.service.ts`, `checklist-edits.ts` | Per ticket checklist edits (spec 0023) and their pure rules |
| `src/config/` | `env.ts` (the one env schema, suite spec 0010, see Conventions), `check-env.ts` (`npm run env:check`), the Jest setup fixture |
| `src/openapi/` | VRMS spec 0026, the docs at `/vrms/docs`: `document.ts` (builds the OpenAPI document in a stable order), `docs.ts` (mounts Scalar, the document and the bundle behind `API_DOCS_ENABLED`), `decorators.ts` (the security scheme and error reply decorators every route uses), `expect-reply.ts` (reply tests against the committed `docs/openapi.json`) |
| `src/instrument.ts`, `src/monitoring/` | VRMS spec 0025, Sentry: `instrument.ts` starts it before Nest (first import in `main.ts`, off with no `SENTRY_DSN`); `sentry-options.ts` (init options and the allowlist `beforeSend`), `sentry-exception.filter.ts` (reports 5xx `HttpException`s), `user-context.ts` (id and VRMS role names, set in `JwtAuthGuard`), the staging only `POST /vrms/debug/sentry-test` (registered only when `SENTRY_TEST_ROUTES=true`) |
| `prisma/seed.ts`, `prisma/seeds/` | Seed data: `people.json` is a byte for byte copy of welinc-auth's manifest (suite spec 0006); check it with `npm --prefix welinc-auth run seed:check -- welinc-backend-vrms/prisma/seeds/people.json` |

## Commands

```bash
npm run start:dev    # nest --watch
npm run lint         # eslint --fix edits files; check git diff afterwards
npm run build        # also the typecheck
npm run env:check    # checks the environment without starting the app (after a build); exits 1 with the list
npm run db:deploy:job  # env:check, then db:deploy (migrations plus the audit_logs revoke): what the hosted migration job runs
npm run openapi      # rewrites docs/openapi.json from the built app; commit it with any route, DTO or reply class change
npm run openapi:check  # exits 1 when docs/openapi.json differs from the code (CI runs it)
npm run test         # Jest unit tests
npm run test:e2e
npm run seed         # wipes and rebuilds the data (and clears the matrix sync's ETag, so the next tick applies welinc-auth's matrix again); SEED=<n> npm run seed repeats a run
npm run seed -- --reference   # hosted bootstrap (spec 0008): garages, vehicles, knowledge and settings only, into an empty database, in one transaction; with NODE_ENV=production a plain seed refuses unless SEED_ALLOW=staging
npm run permissions:export -- <file>   # one time (suite spec 0013, AC-28): cells and matrix history to JSON for welinc-auth's permissions:import; run it before the drop migration deploys
npm run settings:prune      # deletes stored settings whose key left the catalog, logged as a reset by System
npm run ai:embed-all        # embeds every issue that has no current embedding, 50 at a time with a pause; safe to run again, run once per environment after deploy
npm run studio       # Prisma Studio on 5555
npx prisma generate
npx prisma migrate dev   # creates the migration folder; ask before running
```

## Conventions

- Every route carries exactly one of `@RequirePermission(key)`, `@Authenticated()` or `@Public()`; a route with none answers 403, and `route-permissions.spec.ts` fails on it. Role names are `ADMIN`, `CHIEF_MECHANIC` and `MECHANIC`, but code never checks a role: it asks the CASL ability (`PermissionsService.abilityFor(user)`). Ownership ("assigned to me") is a rule condition, and the ability is built per request because it carries the caller's id. A new action adds its key to `catalog.ts` and to welinc-auth's `prisma/catalog/vrms.ts` (Admin on, others off unless its spec says otherwise; until welinc-auth has it, the key counts as off), plus its CASL rule and decorator (spec 0011, suite spec 0013).
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
- Knowledge entry and category writes log one `KnowledgeEntryChange` row per event, its changed fields as a `changes` JSON list (spec 0010), in the same transaction (`knowledge-changes.ts`). Knowledge "who" fields hold the JWT email with no foreign key, like `AuditLog`.
- Every schema change needs a migration folder under `prisma/migrations/`, named with a timestamp. The history starts at one baseline, `20261029000000_baseline` (spec 0010); add new folders after it.
- `<API_PUBLIC_URL>/vrms/session/callback` must equal welinc-auth's registry row. With no `GEMINI_API_KEY` the app still starts: AI runs answer 503 `AI_UNAVAILABLE` and analytics works.
- Every runtime variable is defined once in `src/config/env.ts` (suite spec 0010). A new one goes in that schema and in `.env.example` together, or the drift test in `env.spec.ts` fails. Read it through `ConfigService<Env, true>` (`config.get('NAME', { infer: true })`), never `process.env`: lint fails on `process.env` outside `src/config/`, `prisma/`, `prisma.config.ts`, `scripts/` and tests. A module that needs config at setup uses `registerAsync` with `useFactory`, never a read at import time.
- "Occupied" is defined once, as `isOccupied` in `mechanic-workload.ts`. The Users page workload and the assignment picker's `busy` both read it, so never work it out again somewhere else. Unassign and Reassign on that page go through `PUT /vrms/repairs/:id/assignments`, not a new write route.
- Read people from welinc-auth only through `AuthDirectoryClient` (suite spec 0005). Never call `/auth/users` from this service: it answers service tokens 403 (AC-21).
- Errors reach Sentry only through `src/monitoring/` (spec 0025). Sentry's own filter skips every `HttpException`, 5xx included, so `SentryExceptionFilter` reports those; a new exception filter that can answer 5xx must call `Sentry.captureException` itself. Never send an email, name, token or request body: `beforeSend` keeps only the method, path and user agent, and the user is only an id.
- Roles and systems come from `src/auth/roles.ts`, not `@prisma/client`: this database holds no users. `Mechanic.authUserId` and `AuditLog.actorUserId` are `welinc-auth` user ids (no foreign key); look a caller up by `req.user.sub`, never by email or name.

## Gotchas

- `@scalar/nestjs-api-reference` is ES module only and the Jest config doesn't transform it, so a spec that imports `src/openapi/docs.ts` mocks it (see `docs.spec.ts`).
- In the local Docker stack, the `welinc_vrms_backend` container does not see edits made from Windows. Run `docker restart welinc_vrms_backend` and wait for "Nest application successfully started" before testing the API.
- Sentry drops an error identical to the last one from the same process, so calling the test route twice sends one event until the app restarts. The `SENTRY_*` values come from `.env` through `env_file`, which Docker reads only when the container is created: after changing them run `docker compose -f docker-compose.vrms.yml up -d vrms-backend`, not just a restart.
- There is no `JWT_SECRET`: tokens are checked with welinc-auth's published keys. `AUTH_CLIENT_PRIVATE_KEY` comes from `npm run keys:dev` in welinc-auth, and `AUTH_ISSUER` must equal welinc-auth's string exactly, or every request returns 401. If welinc-auth's keys can't be reached and no copy is left, requests answer 503 `AUTH_UNAVAILABLE`, never 401.
- `@nestjs/platform-express` pins its own `multer`, and that copy handles uploads, so bumping the top level `multer` alone changes nothing. `"multer": "$multer"` in `package.json` `overrides` makes Nest use ours; check `npm ls multer` after any upgrade. The `glob` and `minimatch` overrides there patch dev tools only.
- A deactivation or an ended session in `welinc-auth` reaches VRMS within 30 seconds, because each session's answer is cached in memory by `sid` for that long. A role change reaches VRMS at the next refresh (15 minutes at most), because the roles come from the token. A lock ends no live session. If `welinc-auth` is down, uncached requests get 503.
- A token without a `sid` (from before suite spec 0003) gets 401 `SESSION_ENDED`, and an expired one 401 `TOKEN_EXPIRED`, which the web app answers with one refresh and one retry.
- The matrix is edited by suite admins in the portal (welinc-auth) and reaches VRMS within about a minute: the sync rewrites `role_permissions` and bumps `permission_matrix.version`, and every replica reloads on its next checked request. A hand edit to `role_permissions` is overwritten by the next changed matrix, so change it in the portal instead. While welinc-auth is down VRMS keeps its last copy. A replica that has never loaded the matrix answers 503 on `GET /` until a request loads it.
- Settings work the same way through `settings_state.version`, read together with the matrix version. A module switched off removes its permission keys and answers 403 `MODULE_DISABLED`. Every `/vrms/ai/*` route and the embedding paths check the AI switch.
- The baseline migration needs the `pg_trgm` extension and seeds the issue categories itself (Brakes to Transmission, plus General), so `npm run seed` must not create or delete them.
- Embeddings use pgvector. The extension is created in plain SQL by the `ai_diagnosis` migration (no preview feature), so the database image must be `pgvector/pgvector:pg16` locally and `azure.extensions` must include `VECTOR` on Azure. On Azure only the admin may create an untrusted extension, even with `IF NOT EXISTS`, so that migration guards it with a `DO` block that checks `pg_extension` (the admin's `init.sql` made it already); write any new untrusted extension the same way. The vector column is `Unsupported`, so read and write it with `$queryRaw`; Prisma Studio cannot show `issue_embeddings`.
- The free Gemini tier counts a batch of texts as one request per text and allows about 100 a minute and 1K a day. Keep embed batches at 50 (`EMBED_BATCH_SIZE`). Only `src/modules/ai/` may talk to a provider, always through `AiProvider`.
- CI audits with `audit-ci` (`audit-ci.jsonc`), not `npm audit`: high or critical in what ships fails the build. Update the package first; only when no fix exists, add the advisory id to the allowlist with its reason and a review date. Never lower the level or run `npm audit fix --force`.

## Agent skills

- [azure-blob-storage](../.claude/skills/azure-blob-storage/): `microsoftdocs/agent-skills`, Blob Storage, signed links and managed identity (ticket attachments)
- Declined: Agent Skills for `sharp`, `pdf-lib`, `heic-convert`, `multer` and `@nestjs/throttler` (only weak matches)

## Context files

- [src/modules/attachments/AGENTS.md](src/modules/attachments/AGENTS.md): ticket file uploads, the rebuild pipelines, signed links, retention and the error order (spec 0017)

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
