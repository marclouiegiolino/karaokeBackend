# Verification — November 17, 2026 (peppered authentication update)

## Completed locally

- TypeScript type check: passed.
- API/database, storage and password-hasher tests: passed.
- Workers runtime smoke tests: passed, including the real hasher under a simulated hosted iteration ceiling and R2 XML parsing.
- Wrangler deployment dry run: passed.
- Local Node entry-point startup and real HTTP `/api/health`: passed.
- No dependency changes were required for this password update. The earlier dependency audit result is historical, not a current security audit.

Tests cover authentication, secret-safe responses, expiry, CORS/origin protections, administrator restrictions, private drafts, parameterized searches, file checks, storage budgets, playlist ownership, favorites, performance retry/conflict handling, migrations, and interrupted upload completion. The Workers smoke tests exercise the built Express adapter and the selected password-hashing parameters in the local Workers runtime.

## Still required with your account

The user has verified real Turso/R2 integration with the local Node and local Worker APIs, including signed uploads, conditional copies, publication and ranged downloads. The API was deployed and its public health endpoint returned 200. Hosted login failed with NotSupportedError under the original 600,000-iteration scheme. This is why the user explicitly approved the separate 12,000-iteration HMAC-peppered scheme in this update.

The update and migration are tested with fake credentials and temporary SQLite databases here. No live credential records or deployments were modified from the preparation workspace. The operator installer must run on the user's Windows machine to migrate the selected administrator, upload its dedicated pepper, deploy, and verify live authentication. Real deployed CPU suitability, browser cookie behavior, full media-browser checks and backup restoration still require verification. See PEPPERED-AUTH.md.

The frontend/PWA, on-device microphone processing, offline downloads and actual singing score calculation are not part of this backend ZIP. They are the next implementation phase.
