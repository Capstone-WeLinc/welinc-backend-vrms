# Token check (`src/auth/verify/`)

This folder checks the access tokens welinc-auth signs, and gets this service its own token when it calls welinc-auth. It imports nothing from the rest of VRMS, so you can copy it into another NestJS backend as it is. It is the reference spec 0002 asks every system to use (suite row S11).

Baseline: Node 24, NestJS 11, `jose` 6 (ES modules only; see the Jest setting below).

## What is in it

| File | What it does |
|---|---|
| `key-set.ts` | `ResilientKeySet`: fetches welinc-auth's public keys (`AUTH_JWKS_URL`), keeps them 5 minutes, fetches again for an unknown `kid` at most once a minute, and keeps using the last good set for up to an hour while welinc-auth is down |
| `token-verifier.ts` | `TokenVerifier`: accepts only ES256, `typ: at+jwt`, your `AUTH_ISSUER`, an unexpired `exp` (5 s leeway) and a single `aud` equal to your system. Answers a user token or a service token |
| `guards.ts` | `checkPerson` (for routes meant for people: refuses a service token), `requireService(scope, { clients })` and `@ServiceRoute(scope, { clients })` (for routes meant for services: refuses a person's token, a missing scope and a caller not in `clients`) |
| `errors.ts` | The answers: 401 `Invalid session`, 401 `WRONG_AUDIENCE`, 403 `WRONG_TOKEN_USE` (the wrong kind of token), 403 `FORBIDDEN` (a service token without the route's scope), 503 `AUTH_UNAVAILABLE` |
| `assertion-signer.ts` | Signs the `private_key_jwt` client assertion your service proves itself with (a new one for every token request, 60 s life) |
| `service-token-client.ts` | `ServiceTokenClient`: gets your service token from `POST /auth/token`, keeps it until 60 s before it expires, shares one request between callers, and retries a call once if it answers 401 |
| `verify.module.ts` | `AuthVerifyModule`: reads the settings and provides `TOKEN_VERIFIER`, `VERIFY_CONFIG` and `DIRECTORY_TOKENS` |
| `testing/test-auth.ts` | Test helpers that play welinc-auth with a key made fresh on each run |

## How to copy it

1. Copy the whole folder to `src/auth/verify/` in your backend, tests included.
2. In `verify.module.ts`, set `SERVICE_AUDIENCE` to your system (`VMMS` or `BMS`).
3. Run `npm install jose@^6`.
4. Import `AuthVerifyModule` once (it is global). It needs `ConfigModule.forRoot({ isGlobal: true })`.
5. In your auth guard, call `checkPerson(verifier, request)` with the `TOKEN_VERIFIER` you inject. It answers `{ raw, token }`, or throws the right HTTP error. If you also confirm the account with welinc-auth (VRMS does, through `GET /auth/session`, cached by `sid` for at most 30 s), do it after `checkPerson`, so a service token never reaches that check. Let your guard skip routes marked `@ServiceRoute()`, which bring their own guard. VRMS's `src/auth/guards/jwt-auth.guard.ts` shows the whole guard.
6. For a route other services call, put `@ServiceRoute('<scope>', { clients: ['<client id>'] })` on it. Only those `client_id`s get in. The checked token is on `request.service`. A global permissions guard must skip these routes too, as VRMS's `PermissionsGuard` does.
7. To call welinc-auth's directory as yourself, inject `DIRECTORY_TOKENS` and wrap the call. The call must throw an error with `getStatus() === 401` (a Nest `HttpException`) for the retry to happen:

   ```ts
   const users = await tokens.withToken((token) => askAuth(url, token));
   ```
8. Get your client key: someone with welinc-auth's secrets runs `npm run keys:client -- <your client id> <your secrets file> <auth secrets file>`, then `npm run seed:clients` in welinc-auth. Locally, `npm run keys:dev` in welinc-auth does this for VRMS only, so you run `keys:client` against your own `.env` and welinc-auth's.

## Settings

Every one is required. Your service refuses to start without it, with a message naming it.

| Name | Example (inside Docker) | Secret |
|---|---|---|
| `AUTH_ISSUER` | `http://localhost:3000/auth` | no. It is an identifier, compared character for character and never fetched. Use the identical string every service uses |
| `AUTH_JWKS_URL` | `http://auth-service:3001/auth/.well-known/jwks.json` | no |
| `AUTH_INTERNAL_URL` | `http://auth-service:3001` | no |
| `AUTH_CLIENT_ID` | `vmms`, `bms`, `vmms-analytics`, … | no |
| `AUTH_CLIENT_PRIVATE_KEY` | one line of JSON: a private EC P-256 JWK with `kid` and `alg: ES256` | yes. Never log it, never put it in a `VITE_*` value |

Remove `JWT_SECRET` once you move over. Nothing in the suite signs with it any more.

## The Jest setting

`jose` 6 ships only ES modules, and Jest loads CommonJS. Add this to the `jest` block of your `package.json`, so `ts-jest` turns `jose` into CommonJS for tests:

```json
"transform": {
  "^.+\\.(t|j)s$": ["ts-jest", { "tsconfig": { "allowJs": true, "module": "commonjs", "moduleResolution": "node10", "resolvePackageJsonExports": false } }]
},
"transformIgnorePatterns": ["/node_modules/(?!jose/)"]
```

The build needs nothing extra: with `module: nodenext`, TypeScript 5.8 or later and Node 24 load `jose` through `require()`. VRMS chose `jose` 6 (not 5) because this setting works.

## What the tests cover

`key-set.spec.ts` (the cache, the unknown `kid` refetch, the hour of outage, 503 versus 401), `token-verifier.spec.ts` (every rule above, `alg: none`, HS256 with the old secret and with the public key), `guards.spec.ts` (each HTTP answer), `service-token-client.spec.ts` (the assertion, the kept token, the shared request, one retry on 401 and none on 403) and `verify.module.spec.ts` (the startup checks). Run them after you copy the folder: they need no welinc-auth.
