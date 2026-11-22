# Karaoke database and authentication update

This patch applies the Romantic Album approach to the latest reviewed Karaoke
optimization archive (`karaoke-worker-optimization (1).zip`, 31 files). Express and
the Controllers / Services / Repositories layout remain in use.

## What changes

- Individual database queries in the Worker now call Turso's HTTPS `/v2/pipeline`
  endpoint directly with parameterized SQL and an execute-and-close request.
  Named rows are decoded without the SDK's per-query stream and row wrappers.
- The official web-compatible libSQL client is initialized when a batch or
  interactive transaction is needed. Storage reservations, upload completion,
  offline-sync transactions and scheduled atomic batches retain its transaction
  behavior.
- Missing sessions, revoked sessions, wrong passwords, forbidden administrator
  actions and rate-limit denials return their existing JSON responses directly.
  Unexpected database failures still produce sanitized HTTP 500 errors.
- Every authenticated request still checks the database for an active account,
  current role and unexpired session. There is no session or authorization cache.
- Failed individual queries are not automatically retried. A lost acknowledgement
  can mean a write already committed; silently replaying it would be unsafe.

Password hashing remains HMAC-SHA256 with the existing dedicated pepper followed
by PBKDF2-SHA256 at 12,000 iterations. No password migration, secret upload, schema
migration or additional npm dependency is required.

The archive excludes environment files, database files, backups, node_modules,
Wrangler configuration and package manifests. It includes only the changed source,
regression tests, project conventions and this guide.

## Install on Windows PowerShell 5.1

Download the ZIP, stop any running development server, and paste only these commands
(without a `PS C:\...>` prompt):

```powershell
Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\karaoke-album-pattern-update.zip" -DestinationPath "C:\Karaoke\backend" -Force
cd C:\Karaoke\backend
npm run check
```

To repeat the backend HTTP and business-rule tests through the native query path
using a local SQLite protocol fixture:

```powershell
$previousNativeTest = $env:KARAOKE_TEST_NATIVE_DB
try {
    $env:KARAOKE_TEST_NATIVE_DB = "true"
    npm test
    if ($LASTEXITCODE -ne 0) { throw "Native database tests failed." }
}
finally {
    $env:KARAOKE_TEST_NATIVE_DB = $previousNativeTest
}
```

## Verify the remote integration and deploy

Use the Worker development runtime for the remote integration check; the Node
development server continues to use the official client. Start the Worker:

```powershell
cd C:\Karaoke\backend
npm run dev:worker
```

In a second terminal, run the existing end-to-end helper against that local Worker:

```powershell
cd C:\Karaoke\backend
node --env-file=.dev.vars scripts/test-backend-e2e.mjs
```

This helper creates and retains one clearly marked practice song in your configured
database and bucket, as before. After it passes, deploy with your existing settings:

```powershell
npm run deploy:production
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-live-auth.ps1
```

Use the returned `cfRay` to find the same request under Worker Observability >
Invocations. Compare CPU Time for login, valid session lookup and revoked session
lookup. Local tests and local profiling do not establish deployed Free-plan CPU
suitability, and a single successful request is not a CPU-budget guarantee.

## Automated coverage

Verification completed for this patch:

| Check                                                                                                      | Result                         |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------ |
| TypeScript type checking                                                                                   | Passed                         |
| Node unit and HTTP tests                                                                                   | 45/45 passed                   |
| Compiled Worker runtime tests                                                                              | 3/3 passed                     |
| Six diagnostic script suites                                                                               | 50/50 passed                   |
| Unit/HTTP suite repeated with native queries and real SQLite transactions                                  | 45/45 passed                   |
| Prettier formatting                                                                                        | Passed                         |
| Local profiler, including successful/wrong-password login and valid/revoked/missing-cookie session lookups | All response assertions passed |

Local timing results varied by scenario and simulated database delay; they did not
show a consistent CPU reduction across all cases. Deployed CPU savings have not
been established. No live service was changed during this implementation.

The update adds protocol, typed-value, invalid-response and no-write-replay tests,
real SQLite transaction rollback and atomic-batch checks, immediate account-change
authorization checks and database-outage response checks. The complete application
suite can run against both SDK queries and the native-query fixture. The compiled
Worker suite covers authentication, compression/error parsing and the existing R2
upload, metadata and copy path.
