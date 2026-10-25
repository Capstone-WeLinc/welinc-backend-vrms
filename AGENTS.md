# welinc-backend-vrms

## Overview

The VRMS API: NestJS 11 with Prisma 7 on PostgreSQL, listening on port 3002 (set by `PORT`). It owns repair tickets, issues, parts, vehicles, garages, mechanics, drivers, bookings, checklists, maintenance schedules and audit logs. It checks JWTs issued by `welinc-auth` and is reached through the gateway at `/vrms` and `/repairs`.

## Key files

| File | Owns |
|---|---|
| `src/main.ts` | Bootstrap, global `ValidationPipe`, listen on `PORT` |
| `src/app.module.ts` | Root module wiring |
| `src/auth/` | `JwtAuthGuard`, `RolesGuard`, `@Roles()` decorator, JWT strategy and DTOs |
| `src/modules/vrms/repairs.controller.ts`, `repairs.service.ts` | Repair ticket endpoints and business rules |
| `src/modules/vrms/audit-events.ts` | Audit event names and builders for the ticket timeline |
| `src/modules/vrms/config/` | VRMS configuration endpoints (dropdown lists and settings) |
| `src/modules/vrms/dto/` | Request DTOs validated with `class-validator` |
| `src/modules/knowledge/` | Knowledge base API at `/vrms/knowledge` (spec 0007): categories, entries, stats, suggestions and grouping; tunables in `knowledge.settings.ts` |
| `src/modules/vrms/ticket-knowledge.ts` | What a ticket's issues carry from the knowledge base, and the "What fixed it" rules on the move to For verification |
| `src/shared/` | `PrismaService`, `MailService`, `SharedModule` |
| `prisma/schema.prisma`, `prisma/migrations/` | Data model and migration history |
| `prisma/seed.ts`, `prisma/seeds/` | Seed data (`npm run seed`) |

## Commands

```bash
npm run start:dev    # nest --watch
npm run lint         # runs eslint with --fix, so it edits files
npm run build
npm run test         # Jest unit tests
npm run test:e2e
npm run seed
npm run studio       # Prisma Studio on 5555
npx prisma generate
npx prisma migrate dev   # asks first, see root rules
```

## Conventions

- Routes are protected with `JwtAuthGuard` and `RolesGuard`. Role names match the web app: `ADMIN`, `CHIEF_MECHANIC` and `MECHANIC`. A chief mechanic follows the mechanic rules on tickets (`RepairsService.isMechanic`) and is an editor in the knowledge base, so every ticket route that lists `MECHANIC` also lists `CHIEF_MECHANIC`.
- Every request body is a DTO class with `class-validator` decorators. The global `ValidationPipe` rejects anything else.
- Database access goes through `PrismaService`, never a new `PrismaClient`.
- Repair updates use optimistic locking. The client sends `lastUpdatedAt` and a stale write is rejected. Keep that check on any new update path (see `update-costs.dto.ts` and `update-repair-status.dto.ts`).
- Ticket changes write audit events through `audit-events.ts`, so a new state change should add one.
- Knowledge entry and category writes log one `KnowledgeEntryChange` row per changed field in the same transaction (`knowledge-changes.ts`). Knowledge "who" fields hold the JWT email with no foreign key, like `AuditLog`.
- Every schema change needs a migration folder under `prisma/migrations/`, named with a timestamp.
- New variables go in `.env.example` only (today: `PORT`, `NODE_ENV`, `DATABASE_URL`, `JWT_SECRET`, `JWT_ACCESS_EXPIRY`, `JWT_REFRESH_EXPIRY`, `SEMAPHORE_*`).

## Gotchas

- In the local Docker stack, the `welinc_vrms_backend` container does not see edits made from Windows. Run `docker restart welinc_vrms_backend` and wait for "Nest application successfully started" before testing the API.
- `JWT_SECRET` must match the one `welinc-auth` signs with, or every request returns 401.
- `npm run lint` fixes files in place, so check `git diff` afterwards.
- The knowledge base migration needs the `pg_trgm` extension and seeds the issue categories itself (Brakes to Transmission, plus General), so `npm run seed` must not create or delete them.

## Agent skills

- [nestjs-best-practices](../.claude/skills/nestjs-best-practices/): `kadajett/agent-nestjs-skills`, modules, DI and security
- [prisma-client-api](../.claude/skills/prisma-client-api/), [prisma-cli](../.claude/skills/prisma-cli/): `prisma/skills`, Prisma 7 queries and CLI

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
