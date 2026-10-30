# welinc-backend-vrms

## Overview

The VRMS API: NestJS 11 with Prisma 7 on PostgreSQL, listening on port 3002 (set by `PORT`). It owns repair tickets, issues, parts, vehicles, garages, mechanics, drivers, the knowledge base and audit logs. It owns no accounts: it verifies JWTs issued by `welinc-auth`, then asks `welinc-auth` who the caller is (spec 0009). It is reached through the gateway at `/vrms` and `/repairs`.

## Key files

| File | Owns |
|---|---|
| `src/main.ts` | Bootstrap, global `ValidationPipe`, listen on `PORT` |
| `src/app.module.ts` | Root module wiring |
| `src/auth/` | `JwtAuthGuard`, JWT strategy, `account-check.ts` (the live check against `welinc-auth`) and `roles.ts` (`UserRole` and `SystemType`) |
| `src/auth/permissions/` | The permission matrix (spec 0011): `catalog.ts` (the one definition of keys, defaults and locks), `permissions.service.ts` (stored grants, startup backfill, version cache), `ability.factory.ts` (CASL ability per request), `permissions.guard.ts` and `permission.decorators.ts` (`@RequirePermission`, `@Authenticated`, `@Public`), `permission-matrix.service.ts` and `permissions.controller.ts` (the `/vrms/permissions` API) |
| `src/modules/vrms/mechanic-work.service.ts` | Open work for a person who leaves VRMS: `GET /vrms/mechanics/:authUserId/open-work` and `POST .../release-tickets` |
| `src/modules/vrms/mechanic-roster.service.ts` | Keeps in house `Mechanic` rows in step with `welinc-auth` users: `POST /vrms/mechanics/sync` and the just in time row on first request |
| `src/modules/vrms/repairs.controller.ts`, `repairs.service.ts` | Repair ticket endpoints and business rules |
| `src/modules/vrms/audit-events.ts` | Audit event names and builders for the ticket timeline; each event carries a `changes` list of field, before and after |
| `src/modules/vrms/ticket-statuses.ts` | The one definition of open and finished ticket statuses (spec 0010); queries read it, never a list of their own |
| `src/modules/vrms/config/` | VRMS configuration endpoints (dropdown lists and settings) |
| `src/modules/vrms/dto/` | Request DTOs validated with `class-validator` |
| `src/modules/knowledge/` | Knowledge base API at `/vrms/knowledge` (spec 0007): categories, entries, stats, suggestions and grouping; its four business values come from `SettingsService`, the fixed tuning constants stay in `knowledge.tuning.ts` |
| `src/settings/` | Settings and module switches (spec 0012): `catalog.ts` is the one definition of every setting, `SettingsService.get(key)` reads them, `GET` and `PATCH /vrms/settings` and `GET /vrms/settings/changes` save and log them, and `module-disabled.ts` is the 403 `MODULE_DISABLED` answer |
| `src/modules/vrms/ticket-knowledge.ts` | What a ticket's issues carry from the knowledge base, and the "What fixed it" rules on the move to For verification |
| `src/shared/` | `PrismaService`, `SharedModule` |
| `prisma/schema.prisma`, `prisma/migrations/` | Data model and migration history |
| `prisma/seed.ts`, `prisma/seeds/` | Seed data (`npm run seed`): `catalog.ts` holds the fleet, problems, parts and prices; `repairs.seed.ts` plays out each truck's history in order |

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
npm run studio       # Prisma Studio on 5555
npx prisma generate
npx prisma migrate dev   # asks first, see root rules
```

## Conventions

- Every route carries exactly one of `@RequirePermission(key)`, `@Authenticated()` or `@Public()`; a route with none answers 403, and `route-permissions.spec.ts` fails on it. Role names are `ADMIN`, `CHIEF_MECHANIC` and `MECHANIC`, but code never checks a role: it asks the CASL ability (`PermissionsService.abilityFor(user)`). Ownership ("assigned to me") is a rule condition, and the ability is built per request because it carries the caller's id. A new action adds its key to `catalog.ts` (Admin on, others off unless its spec says otherwise) plus its CASL rule and decorator (spec 0011).
- Every request body is a DTO class with `class-validator` decorators. The global `ValidationPipe` rejects anything else.
- Database access goes through `PrismaService`, never a new `PrismaClient`.
- Repair updates use optimistic locking. The client sends `lastUpdatedAt` and a stale write is rejected. Keep that check on any new update path (see `update-costs.dto.ts` and `update-repair-status.dto.ts`).
- Ticket changes write audit events through `audit-events.ts`, so a new state change should add one.
- Knowledge entry and category writes log one `KnowledgeEntryChange` row per changed field in the same transaction (`knowledge-changes.ts`). Knowledge "who" fields hold the JWT email with no foreign key, like `AuditLog`.
- Every schema change needs a migration folder under `prisma/migrations/`, named with a timestamp. The history starts at one baseline, `20261029000000_baseline` (spec 0010); add new folders after it.
- New variables go in `.env.example` only (today: `PORT`, `NODE_ENV`, `DATABASE_URL`, `JWT_SECRET`, `AUTH_SERVICE_URL` (required, the app refuses to start without it), `CORS_ORIGINS`, `AI_SERVICE_URL`).
- Roles and systems come from `src/auth/roles.ts`, not `@prisma/client`: this database holds no users. `Mechanic.authUserId` and `AuditLog.actorUserId` are `welinc-auth` user ids (no foreign key); look a caller up by `req.user.sub`, never by email or name.

## Gotchas

- In the local Docker stack, the `welinc_vrms_backend` container does not see edits made from Windows. Run `docker restart welinc_vrms_backend` and wait for "Nest application successfully started" before testing the API.
- `JWT_SECRET` must match the one `welinc-auth` signs with, or every request returns 401.
- `npm run lint` fixes files in place, so check `git diff` afterwards.
- A change made in `welinc-auth` (deactivate, lock, role change) reaches VRMS within 30 seconds, because each token's 200 answer is cached in memory for that long. If `welinc-auth` is down, uncached requests get 503.
- An Admin's matrix edits live in `role_permissions` and apply on the next request on every replica, because each checked request reads `permission_matrix.version`. A hand edit in the database applies only after you bump that version. A replica that has never loaded the matrix answers 503 on `GET /` until a request loads it. A `PATCH /vrms/permissions` that takes a right away needs a `note` of 5 to 500 characters (400 otherwise); adding rights needs none.
- Settings work the same way through `settings_state.version`, read together with the matrix version. A module switched off removes its permission keys and answers 403 `MODULE_DISABLED`, and the Python service reads the AI and Analytics switches from `app_settings` itself.
- The baseline migration needs the `pg_trgm` extension and seeds the issue categories itself (Brakes to Transmission, plus General), so `npm run seed` must not create or delete them.

## Agent skills

- [nestjs-best-practices](../.claude/skills/nestjs-best-practices/): `kadajett/agent-nestjs-skills`, modules, DI and security
- [prisma-client-api](../.claude/skills/prisma-client-api/), [prisma-cli](../.claude/skills/prisma-cli/): `prisma/skills`, Prisma 7 queries and CLI

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
