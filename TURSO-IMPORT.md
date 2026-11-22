# Import your local karaoke database into an empty Turso database

This add-on uses the dependencies already installed in the karaoke backend. It works from Windows PowerShell with your existing Node installation. No WSL, Turso CLI, or new npm package is required.

It copies the original karaoke schema, indexes, migration history, users/password hashes, and other rows. It never drops or overwrites destination tables, and does not modify local data. It verifies each table's complete contents and foreign keys before committing. If the destination already has any application schema objects, it refuses the import, even if those tables are empty.

## 1. Extract into your backend

The ZIP contains:

- `scripts/import-local-to-turso.mjs`
- `tests/turso-import.test.mjs`
- `TURSO-IMPORT.md`

Extract them directly into `C:\Karaoke\backend`, so the script is at `C:\Karaoke\backend\scripts\import-local-to-turso.mjs`. The existing backend files do not need replacement.

## 2. Stop the backend and choose the cloud destination

Stop `npm run dev` with Ctrl+C. Run:

```powershell
cd C:\Karaoke\backend
notepad .dev.vars
```

Change only the Turso connection entries to your cloud database's actual URL and a database token with read/write permission:

```env
TURSO_DATABASE_URL=libsql://YOUR-CLOUD-DATABASE-URL
TURSO_AUTH_TOKEN=YOUR-DATABASE-TOKEN
```

Keep credentials in this file, not in chat, source code, or Git. Leave `APP_ENV=development` while running locally.

The local source is always `.local/karaoke.db` by default, independent of the newly configured remote URL. The script prints the source path and destination hostname before operating. Node environment variables already set in the PowerShell session take precedence over the file; open a fresh terminal if an old target is being selected.

Do not run `db:migrate` or `admin:create` against this destination before importing. The helper brings across both your existing schema and administrator account. If those commands have already created remote tables, the helper stops without overwriting them. Inspect the existing database rather than deleting it to bypass the guard.

## 3. Check without changing the destination

```powershell
node --env-file=.dev.vars scripts/import-local-to-turso.mjs --dry-run
```

The check reads your local database and remote schema. It lists only table names and row counts, never password hashes, session tokens or database credentials. It checks that the source is the original karaoke schema, passes integrity and foreign-key checks, and the destination is empty.

## 4. Import

If the check passes and the displayed destination is the database you intend to use:

```powershell
node --env-file=.dev.vars scripts/import-local-to-turso.mjs --apply
```

Success prints:

```text
Import committed. Row contents and foreign keys verified. Local database retained.
```

The source file remains at `C:\Karaoke\backend\.local\karaoke.db`. There is no need to create the administrator again; sign in with the same username and password.

## 5. Start the backend

```powershell
npm run dev
```

The backend will use the remote database because `.dev.vars` now points to it. R2 configuration and testing are separate; no audio/media objects are uploaded by this database helper. Copying song metadata alone does not copy existing R2 files.

For future schema changes, add a new migration and use the project's migration command. Imported migration checksums remain intact, so do not edit a migration that was already applied locally.

## Important behavior

- The destination must be empty. This helper does not merge, overwrite, delete, or recreate a remote database.
- A successful import cannot be repeated into the same destination. A repeat attempt safely refuses existing tables.
- If connectivity fails during commit, the server may already have committed. Inspect the remote tables before retrying; the script intentionally refuses to overwrite them.
- This helper is scoped to the original small karaoke project: at most 50 MB source file and 100,000 total rows. Large databases need a dedicated migration process.
- Only tables and indexes from the original backend are supported. Custom views, triggers, virtual tables or schema changes require review.
- It uses database row reads/writes and therefore counts toward the Turso allowance.

## Verification

Six local importer tests pass: read-only dry run; administrator/hash/migration-history preservation; nonempty destination protection; repeat-import protection; complete rollback when copied data does not match; and rejection of unrelated databases. Tests use isolated local databases, not your account. Actual remote transfer is not performed until you run the command with your own credentials.

Run the included tests from the backend root:

```powershell
node --test tests/turso-import.test.mjs
```

Official alternatives: Turso's [create-from-file command](https://docs.turso.tech/cli/db/create) creates a new cloud database; its [CLI installation guide](https://docs.turso.tech/cli/installation) documents WSL for the Cloud CLI on Windows. This add-on instead uses the project's existing libSQL client to populate an already-created empty destination.
