# Cloudflare deployment

Deployment procedures for the Karaoke API. Use dedicated karaoke databases/buckets, not existing Medical Booking or Romantic Album resources. The user has deployed the production Worker and verified health. For the approved password migration and replacement of the hosted-incompatible verifier, start with [PEPPERED-AUTH.md](PEPPERED-AUTH.md).

## 1. Prepare Preview resources

Create a Preview Turso database and private R2 Standard bucket. Make an R2 Object Read & Write credential restricted to that bucket. No public bucket URL is required. Keep credentials in `.dev.vars` locally and Workers secrets remotely, never in `wrangler.jsonc`, Git, or the frontend.

Before a remote migration, select the Preview database in your current PowerShell session:

```powershell
$env:TURSO_DATABASE_URL = 'libsql://YOUR-PREVIEW-DATABASE.turso.io'
$env:TURSO_AUTH_TOKEN = 'YOUR-PREVIEW-TOKEN'
$env:CONFIRM_REMOTE_MIGRATION = 'yes'
npm run db:migrate
npm run admin:create
Remove-Item Env:CONFIRM_REMOTE_MIGRATION
```

The migration command creates `schema_migrations` and applies unapplied SQL in a transaction. It refuses changed checksums. After a migration is applied, add another numbered SQL file instead of editing the original.

After changing targets, ensure you do not accidentally reuse Production secrets. The shell's environment takes precedence over `.dev.vars` when using Node's environment-file loading. Close the shell or clear temporary variables when finished.

## 2. R2 configuration

Set a bucket CORS policy using exact frontend origins. Adapt [r2-cors.example.json](r2-cors.example.json) to your actual Preview site. The JSON file intentionally uses an invalid placeholder. Allow GET, HEAD, PUT and the needed content headers. Expose byte-range and length headers. Test uploads and byte-range playback in the browser.

Add a lifecycle rule deleting objects under `_staging/` after 1 day. Keep a rule aborting incomplete multipart uploads after 7 days. Canonical assets live under `songs/`; do not apply staging expiration to that prefix.

Staging objects are copied to unique canonical keys only after basic validation. This prevents a still-valid PUT URL from overwriting the published object. Canonical copy uses the original ETag as a condition. R2 operations and temporary staging objects still consume allowance.

## 3. Configure Workers Preview

Replace `FRONTEND_ORIGINS` under `env.preview.vars` in `wrangler.jsonc`. Use an exact HTTPS origin without a trailing slash. Keep registration disabled unless you deliberately need signups. Namespace IDs in rate-limit bindings are separate for local, Preview and Production.

Authenticate Wrangler using your Cloudflare account and set secrets interactively:

```powershell
npx wrangler login
npx wrangler secret put TURSO_DATABASE_URL --env preview
npx wrangler secret put TURSO_AUTH_TOKEN --env preview
npx wrangler secret put R2_ACCOUNT_ID --env preview
npx wrangler secret put R2_BUCKET --env preview
npx wrangler secret put R2_ACCESS_KEY_ID --env preview
npx wrangler secret put R2_SECRET_ACCESS_KEY --env preview
npx wrangler secret put PASSWORD_PEPPER --env preview
npm run deploy:preview
```

For local `npm run dev:worker`, use remote Preview Turso settings in `.dev.vars` (a `file:` SQLite URL is only supported by the local Node development server). Run `npm run typegen` after changing bindings.

The Worker fails closed when required settings or rate-limit bindings are absent. The local default SQLite URL intentionally cannot be used by the Workers adapter.

## 4. Verify Preview

- Health response, exact frontend CORS, session cookie login/logout, forbidden cross-origin requests.
- Non-admin upload rejection and private draft access.
- Real signed audio/package uploads and immutable copy completion. Verify canonical objects retain Content-Type.
- Playback, seek/range requests and complete offline downloads on target browsers.
- Duplicate score sync, expired-session re-login, account-isolated playlists/history.
- Workers CPU metrics for cold start, registration/login, JSON package validation, signed URLs, and normal requests.
- Backup/restore and storage allowance monitoring.

Local tests and Miniflare do not prove deployed Free-plan CPU suitability. Following the user's explicit decision, password hashing now uses 12,000 PBKDF2-SHA256 iterations after HMAC-SHA256 with a dedicated random pepper. A Worker fixture simulates the hosted iteration ceiling to prevent recurrence of the original unsupported 600,000-iteration call. This does not measure CPU. Do not make further reductions to fit the free plan. No paid service has been enabled by this project.

Cross-site cookies can be blocked between unrelated `pages.dev` and `workers.dev` sites. Plan same-site subdomains or a same-origin `/api` path for reliable cookie authentication. Exact-origin checks complement authentication; CORS is not a replacement for permissions.

## 5. Production

For a new deployment, create the intended Production resources, take backups, apply migrations to that DB, and create the administrator there. Update `env.production.vars.FRONTEND_ORIGINS`, then set the six storage/database secret names plus the dedicated `PASSWORD_PEPPER` with `--env production`. For this user's existing database and administrator, use the verified password migration in PEPPERED-AUTH.md instead of recreating accounts or importing the database again.

Only after Preview verification:

```powershell
npm run deploy:production
```

This command runs local checks before deployment; it does not replace live verification. Keep the database backward-compatible across releases. A Worker code rollback does not undo a SQL migration.

Production config includes one daily scheduled cleanup at 00:00 UTC (8 AM Philippines). It removes expired sessions and releases expired PENDING upload reservations. PROCESSING uploads keep reservations until recovery so uncertain copies cannot silently bypass the application budget. Run `npm run maintenance` with the intended environment after an interrupted upload; it recovers canonical copies or resets missing ones. Inspect unexpected storage errors instead of manually decrementing counters.

The application budget covers its own tracked canonical uploads/reservations. It does not measure staging leftovers, manual writes, other buckets, backup copies, or request charges. Reconcile real R2 usage and set monitoring. Keep Turso overages disabled if your goal is $0 and verify your account's current allowance. No application code can promise unlimited use for free.

No permanent deletion route is included. Archival is reversible at the data level and keeps files/history. A future deletion workflow must remove media and adjust accounting consistently.
