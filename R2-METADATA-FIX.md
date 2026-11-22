# R2 upload metadata correction

The first live test passed signed PUT, CORS preflight, and cleanup, but rejected the stored size/type. That output did not distinguish the two metadata fields, so the exact remote mismatch remains unconfirmed.

This patch makes two changes:

- `R2FileStorage.uploadUrl()` explicitly includes `content-type` in the signed request headers while preserving signed Content-Length and existing validation. The installed AWS SDK otherwise omits Content-Type from signed headers by default.
- `scripts/test-r2.mjs` prints safe expected/received metadata and reports type and size errors separately. It checks that the corrected storage adapter is loaded, and displays `R2 test: metadata-v2`.

The SDK option is documented at https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/ .

## Apply on Windows

The ZIP replaces these four files and adds this guide:

- `src/Modules/Services/R2FileStorage.ts`
- `scripts/test-r2.mjs`
- `tests/backend.test.ts`
- `tests/r2-connection.test.mjs`

If you have made your own changes to these files, copy them aside before applying the patch. Your `.dev.vars`, database files, and credentials are not included and are not replaced.

Stop the backend with Ctrl+C. If the ZIP is in Downloads:

```powershell
Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\karaoke-r2-metadata-fix.zip" -DestinationPath "C:\Karaoke\backend" -Force
cd C:\Karaoke\backend
node --env-file=.dev.vars --import tsx scripts/test-r2.mjs
```

Do not change your credentials based solely on the earlier metadata failure: signed upload and authenticated cleanup already succeeded. The new run will show the actual mismatch if it persists.

The script uploads only its generated temporary JSON, reads/copies it, and attempts cleanup. It keeps strict size/type checks; failures are not bypassed. It does not access Turso or modify existing songs. Signed URLs and credentials are never printed.

Successful completion ends with `R2 CONNECTION TEST PASSED`. If it fails, share the PASS/FAIL output and the `Upload metadata:` line. This line contains only byte counts, JavaScript value type, and MIME types.

Local verification includes the backend API/type/build/runtime checks plus seven test-script checks, including separate size/type mismatch handling and cleanup. The signature regression test verifies that generated upload URLs sign BOTH Content-Type and Content-Length. The updated patch has not been run against your real R2 account by the assistant.
