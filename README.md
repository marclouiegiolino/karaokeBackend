# Karaoke Backend

Express + TypeScript on Cloudflare Workers, with Turso and private Cloudflare R2 storage. The directory layout follows the Medical Booking API pattern: `Controllers`, `DTOs`, `Main`, feature `Modules`, `Modules/Services`, `Security`, `Routes`, and SQL `Migrations`.

## What is included

- User registration (explicit opt-in), login, logout, and session lookup.
- User-approved Workers-compatible password hashing: HMAC-SHA256 with a dedicated pepper, then 12,000 PBKDF2-SHA256 iterations with random 32-byte salts. Random session tokens are stored only as SHA-256 digests.
- HttpOnly session cookies, exact-origin CORS, origin checks on mutations, administrator authorization, validation, and request/body limits.
- Draft song creation, metadata editing, validated audio/cover/package uploads, publication, archival, and authorized download links.
- Private playlists and favorites.
- Duplicate-safe offline performance sync and private score history.
- SQLite-compatible, checksummed Turso migrations, administrative account creation, storage reservation accounting, maintenance, and CI.
- Integration tests against local libSQL and smoke tests of the bundle in the Workers runtime.

This is the **backend project only**. The Next.js PWA, microphone capture, pitch detection, offline cache, and scoring engine are separate frontend work. This server stores device-reported results; it does not independently verify a singer's performance.

## First run on Windows (PowerShell)

Extract into a new directory. Keep your existing scaffold separately until you decide to replace it.

Use a current Node.js 24 LTS installation and npm. From the extracted `karaoke-backend` directory:

```powershell
npm ci
Copy-Item .dev.vars.example .dev.vars
npm run db:migrate
node --import tsx scripts/worker-auth-migration.mjs prepare --allow-local
npm run admin:create
npm run dev
```

`admin:create` prompts for your own credentials; there is no default administrator/password. The password policy is defined in `src/DTOs/Auth/RegisterRequest.ts`. This authentication update leaves your edited 8-character policy in place. Keep the generated `PASSWORD_PEPPER` in your private `.dev.vars` and as a matching Worker secret; do not rotate it without migrating password records. Local public registration is enabled in the example configuration and can be turned off.

Open <http://localhost:8787/api/health>. Local development binds only to your computer. It uses `.local/karaoke.db`, so no Turso account is required for the first run. R2 is optional until you use media endpoints. Migrations run explicitly, never on API startup or song playback.

Stop the server with Ctrl+C. Do not run `create-cloudflare` inside this project again.

## Commands

| Command                     | Purpose                                                                   |
| --------------------------- | ------------------------------------------------------------------------- |
| `npm run dev`               | Local Node/Express server with watch mode and local libSQL                |
| `npm run dev:worker`        | Workers runtime; requires remote Preview Turso configuration              |
| `npm run db:migrate`        | Apply missing SQL migrations; refuse edits to already-applied migrations  |
| `npm run admin:create`      | Create an administrator interactively                                     |
| `npm run maintenance`       | Clean expired sessions/reservations and recover interrupted uploads       |
| `npm run typecheck`         | TypeScript check                                                          |
| `npm test`                  | API/database integration tests                                            |
| `npm run build`             | Bundle for Workers without deployment                                     |
| `npm run test:worker`       | Bundle and run local Workers runtime smoke tests                          |
| `npm run check`             | Type check, API tests, Workers bundle and runtime smoke tests             |
| `npm run auth:benchmark`    | Local hash/verify wall-time measurement; not a production CPU measurement |
| `npm run typegen`           | Generate Cloudflare binding declarations                                  |
| `npm run deploy:preview`    | Run checks and deploy the configured Preview environment                  |
| `npm run deploy:production` | Run checks and deploy the configured Production environment               |

## Production status

The user verified local Node and local Worker integration against Turso/R2, then deployed the API and verified health on November 17, 2026. The original live login failed on the hosted PBKDF2 iteration limit. This update prepares the approved peppered replacement and explicit credential migration; it must be installed and verified on the deployed account. See [Peppered authentication update](docs/PEPPERED-AUTH.md). Before public use:

1. Configure distinct Preview and Production databases, R2 buckets, credentials, and allowed frontend origins.
2. Run the real upload/download and cookie flows in Preview, including browser CORS and byte-range playback.
3. Measure deployed Workers CPU usage on login/registration, upload completion, and cold requests. A successful local/runtime test does not prove those routes fit Workers Free. The 12,000-iteration peppered scheme is the user's explicit compatibility tradeoff; do not reduce it further. If CPU usage remains unsuitable, change authentication hosting/provider instead.
4. Set up and test database/media backups, usage monitoring, and the R2 staging lifecycle rules.
5. Use a same-site frontend/API deployment (for example `karaoke.example.com` and `api.example.com`) or an equivalent same-origin `/api` routing arrangement. `pages.dev` plus `workers.dev` cookies may be blocked by browser third-party-cookie policies even with `SameSite=None`.
6. Keep `REGISTRATION_ENABLED=false` for the initial private launch. This version has no email verification, self-service password reset, two-factor authentication, malware scanner, or anti-cheat verification.

Read [Deployment](docs/DEPLOYMENT.md), [API](docs/API.md), and [Offline contract](docs/OFFLINE.md).

The included GitHub Actions workflow assumes this backend is the repository root. In a frontend/backend monorepo, move the workflow into the repository-level `.github/workflows` folder and set its working directory and npm cache path to `backend`.

## How a song becomes available

1. Sign in as an administrator and create a draft with its duration.
2. Request one upload intent for audio, one for its lyrics/melody package, and optionally one for a cover.
3. Upload the exact file bytes to each returned URL using the returned content type. The browser sets Content-Length from the Blob/file body.
4. Complete each upload. The server checks size, content type, file signature or package schema, then copies the object from staging to a unique canonical key. Conditional copy prevents publishing a staging object that changed during validation.
5. Publish the draft. Verified audio and a verified scoring package are required. Published media is immutable in this version; create a new song/package record for a replacement.
6. Users fetch the song's download manifest and save its complete contents on the device.

Only audio formats MP3, WAV, Ogg, and audio MP4 are accepted. Video upload and transcoding are not included. Signature checks are basic format checks, not full codec or malware validation. For the initial private library, upload trusted, prepared files with verified duration and melody timing.

## Storage and free allowances

Application upload budget defaults to **2,000,000,000 bytes** in `storage_budget`. It includes completed uploads and in-progress reservations. Maximum individual uploads: audio 20 MB, cover 300 KB, lyrics/melody JSON 1 MB.

Keep R2 Standard storage. Use a separate karaoke bucket, but account for your other buckets/apps when monitoring total account usage. This database budget is not an R2 billing hard cap, and requests, staging files, other projects, and manually uploaded objects can add usage. R2 reads/writes and storage can incur charges beyond its allowance. Cloudflare Workers and Turso have separate limits too.

No per-note writes or continuous playback polling are used. Scores are synced once per completed performance; retries keep the same performance ID. Archive retains files and performance history, so archived media still consumes storage. The project intentionally does not include automatic permanent deletion of songs.

## Architecture

`Route -> authentication/validation -> Controller -> Service -> Repository / file storage`

- Controllers handle HTTP; services handle rules and ownership; repositories use parameterized SQL.
- Request DTOs export Zod schemas and inferred types.
- `Main/Dependencies.ts` wires dependencies explicitly without a dependency-injection framework.
- `app.ts` builds Express; `index.ts` adapts it to Workers; `local.ts` supplies the local development server.
- Rate-limit bindings are used on Workers. The local in-memory limiter is development-only. Cloudflare's rate limiting is approximate and location-based, not an exact account billing cap.
- Database credentials, R2 keys, passwords, session cookies, and signed URLs must not be logged or committed.

## Reference documentation

- [Cloudflare: Express on Workers](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/)
- [Cloudflare: Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare: Node crypto compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)
- [Cloudflare: R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [OWASP: password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
