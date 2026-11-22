# Apply the approved Romantic Album hashing approach to Karaoke

This update uses Web Crypto HMAC-SHA256 with a dedicated Karaoke pepper, followed
by PBKDF2-HMAC-SHA256 with 12,000 iterations, a random 32-byte salt, and a 32-byte
result. The stored format is `$pbkdf2-sha256$12000$<salt hex>$<result hex>`.
It is distinct from the original unpeppered `pbkdf2-sha256$600000$...` format.
The Worker never tries to derive that old 600,000-iteration hash.

This is the user's explicit November 17, 2026 decision after comparing Romantic
Album's implementation. It is a lower work factor with additional secret pepper
protection, not equivalent to the original password-storage configuration.
Real deployed CPU measurements still determine Workers Free suitability.

## Install on the existing Windows project

Installer v2 corrects two preparation issues from v1. The read-only login
diagnostic now uses the bundled live-auth credential reader, so it does not
require a newer `test-backend-e2e.mjs` export. The file-backed SQLite test runs
in a child process that exits before temporary files are removed, allowing
Windows to release native database handles. These changes do not skip checks
or alter the approved password hashing parameters.

If v1 stopped at `Migration and diagnostic checks failed`, it had not reached
pepper setup, account migration, secret upload or deployment. Extract v2 and
run the installer again using the same current password.

Stop local development servers before extracting the update into
`C:\Karaoke\backend`. Keep `.dev.vars`, existing database files and account data.
This update does not contain or replace `.dev.vars`, `wrangler.jsonc`, npm
dependency files, or `RegisterRequest.ts`; your production origin, XML parser
alias, existing credentials and edited 8-character password policy remain intact.
It installs source, diagnostic helpers, tests and documentation only.

Use the PowerShell window/account where Wrangler OAuth login succeeded:

```powershell
cd C:\Karaoke\backend
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-worker-auth.ps1
```

Enter `micaela` (or press Enter) and the **current** administrator password. The
password stays the same. The script:

1. Confirms the Worker name and currently allowed API origin, checks Cloudflare
   access, then runs `npm run check` plus the migration/diagnostic tests before changing remote credentials.
2. Generates a random 256-bit Karaoke pepper once and appends it to `.dev.vars`.
   A valid existing pepper is retained. If peppered accounts exist and the local
   pepper is missing, setup stops instead of silently generating a replacement.
3. Uses ordinary Node.js locally to verify the current legacy password, computes
   the new peppered verifier, and checks that it verifies the same password.
4. Saves the previous hash under `.local/auth-backups/<random-id>.json` before
   the database write. These backups contain password hashes and must stay private.
   They contain no plaintext password or pepper. They are not uploaded by this tool.
5. Atomically updates only the selected account's hash and deletes its sessions.
   An optimistic hash comparison prevents overwriting a concurrent password change.
   User ID, username, email, display name, role, active status, songs and media stay
   in place. No account is recreated and no SQL schema migration is required.
6. Uploads only `PASSWORD_PEPPER` from that private file as a production Worker
   secret, deploys `karaoke-backend-production`, and runs the live authentication
   check using the same credentials through stdin.

Success ends with `LIVE AUTH CHECK PASSED` and `WORKER AUTH UPDATE PASSED`.
Share only PASS/FAIL/INFO lines if anything fails, without credentials or backups.
No changes were deployed from the preparation workspace; running this installer
performs the database/secret/deployment actions above on your configured account.

The installer is designed for your current Worker name, account and API origin.
It uses your existing Turso and R2 settings. No Firebase, Render or additional
provider is introduced. It clears an overriding `CLOUDFLARE_API_TOKEN` only inside
the installer process and uses your established OAuth credentials.

## Failure and retry behavior

- A wrong current password makes no account changes and no hash backup.
- A valid already-migrated account with the matching pepper is verified without
  rehashing or revoking new sessions again. Rerunning the installer can repair an
  interrupted upload/deployment after a successful credential migration.
- If a migration commit reply is lost, the tool reports it as unconfirmed; retain
  the backup and rerun with the same pepper and current password. Do not restore
  or delete records based only on a lost response.
- If deployment fails after migration, keep `.dev.vars` and the hash backup.
  Correct the reported deployment problem, then rerun the installer. Do not run
  `admin:create` for an existing account, re-import the DB, or generate a new pepper.
- Keep the pepper backed up privately. Losing or rotating it makes existing
  peppered hashes unverifiable. The original hash backup is an operator recovery
  record, not a runtime fallback; restoring it requires an appropriate local
  recovery procedure and is not done automatically by this update.

For another pre-existing account, run the same script with `-MigrateOnly` and that
account's current password. That mode performs the credential migration but does
not upload secrets or redeploy. Newly created accounts use the new scheme directly.

Advanced read-only migration checks accept credential JSON via stdin:

```text
node --import tsx scripts/worker-auth-migration.mjs migrate
```

`--apply` is required for a database write; `--require-admin` is used by the full
installer. Operator tools read `.dev.vars` explicitly, so inherited Turso/pepper
environment variables do not silently select another target. Ordinary `npm run
dev` and `admin:create` still use Node environment-file precedence; restart them
after setup and clear an overriding PASSWORD_PEPPER environment variable if needed.

## Verification boundary

Tests cover an independent HMAC/PBKDF2 known-answer comparison, random salts,
wrong/missing peppers, malformed hashes, an actual Wrangler-built hasher under a
simulated production iteration ceiling, legacy password migration, private backup
creation, wrong-password rejection, transaction rollback, concurrent updates,
lost commit replies, idempotent retries and prevention of accidental pepper
rotation. The backend checks and local HTTP diagnostic tests also run.

The Windows PowerShell 5.1 installer must be run on your Windows machine; this
Linux preparation workspace cannot execute it. Full browser authentication,
frontend integration, singing scores and real deployed CPU suitability remain
separate checks. The R2 upload/scoring contracts are unchanged.
