# Test the karaoke backend's R2 connection

This add-on uses your existing backend dependencies and the actual `R2FileStorage` adapter. No additional npm package or database migration is needed.

## Install

Extract the ZIP contents directly into `C:\Karaoke\backend`. It adds:

- `scripts/test-r2.mjs`
- `tests/r2-connection.test.mjs`
- `R2-CONNECTION-TEST.md`

Your backend must already contain `src/Modules/Services/R2FileStorage.ts` and have its dependencies installed with `npm ci`.

## Configure

Your existing `.dev.vars` needs these real values:

```env
R2_ACCOUNT_ID=YOUR_32_CHARACTER_CLOUDFLARE_ACCOUNT_ID
R2_BUCKET=karaoke-media
R2_ACCESS_KEY_ID=YOUR_R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=YOUR_R2_SECRET_ACCESS_KEY
FRONTEND_ORIGINS=http://localhost:3000
```

Use R2 Object Read & Write credentials scoped to the karaoke bucket. Keep your Turso entries. Do not copy placeholder values over credentials you have already filled in. Keep credentials private.

## Run in PowerShell

```powershell
cd C:\Karaoke\backend
node --env-file=.dev.vars --import tsx scripts/test-r2.mjs
```

The backend server does not have to be running for this test. If it is running, you can leave it open and use a second PowerShell window.

The test prints only the bucket name, frontend origin, check results, and any temporary keys that need manual cleanup. It never prints credentials or signed URLs.

## Checks

1. Signed PUT URL and upload CORS preflight for the configured frontend origin.
2. Upload of one tiny generated JSON file using that signed URL.
3. Authenticated HEAD to confirm read access, byte size, and content type.
4. Signed GET with the matching origin and exact byte comparison.
5. Partial GET (`Range: bytes=0-15`), HTTP 206, Content-Range, and exposed CORS headers.
6. Conditional copy using the backend storage method, retaining content type and content bytes.
7. Cleanup of the temporary source and copied object.

All test keys use a fresh UUID under `_staging/_connection-tests/`. No existing songs or other objects are overwritten or deleted. The script does not create song records, change the application storage budget, or access Turso. A few R2 operations and temporary bytes count toward your R2 allowance.

A successful run ends with:

```text
R2 CONNECTION TEST PASSED
```

If a request fails after a write may have happened, cleanup is attempted. If cleanup fails, the script prints the precise temporary keys to remove manually. Your one-day `_staging/` lifecycle rule is an additional fallback; it is not relied on as the test's only cleanup method.

## Troubleshooting

- Missing configuration: fill in the named entry in `.dev.vars` and save.
- Wrong account ID: use the account ID, not the S3 endpoint URL or bucket name.
- HTTP 403 on upload/read/copy: confirm the Access Key ID, Secret Access Key, and permission scope for this exact bucket. The general Cloudflare API token value does not replace S3 credentials.
- CORS failures: allow the exact frontend origin, PUT/GET/HEAD, and Content-Type/Range headers; expose ETag and Content-Range. Keep public access disabled. CORS may take a short time to propagate.
- Wrong origin selected: this test uses `R2_TEST_ORIGIN` if set, otherwise the first origin in `FRONTEND_ORIGINS`, otherwise `http://localhost:3000`.
- Old connection values: environment variables already set in PowerShell override `.dev.vars`. Open a fresh terminal or clear just the outdated R2 variables before rerunning.
- Certificate/network errors: check the connection and system clock. Do not disable TLS certificate verification.

Share the PASS/FAIL output for troubleshooting, not `.dev.vars` or your keys.

## Verification and limits

Five local tests verify successful orchestration, CORS rejection before writing, cleanup after failed downloads, byte mismatch detection, and failure reporting when cleanup fails. They use fake storage/network responses. The existing backend's 24 type/API/runtime checks also pass after adding this helper.

Your real R2 account has not been contacted by the assistant. Run the command above to perform that check. Even a successful storage test does not verify backend login, database permissions, the full song-publication workflow, real browser microphone behavior, or deployed Workers CPU limits. Browser CORS headers are checked with real requests; the final Next.js app should still be tested in its target browsers.
