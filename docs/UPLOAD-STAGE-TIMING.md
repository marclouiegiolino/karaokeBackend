# Upload finalization timing

This patch writes one JSON info log for each `POST /api/songs/:id/uploads/complete` operation. It records elapsed wall time in milliseconds for each measured stage and the whole service operation. It does not include song IDs, upload IDs, credentials, cookies, or signed URLs.

The stages include database lookup/claim/commit/reload, R2 metadata/read/promotion/cleanup, package validation or file-signature validation, and failure recovery when applicable.

## Apply and deploy

In PowerShell:

```powershell
cd C:\Karaoke\backend
Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\karaoke-upload-stage-timing.zip" -DestinationPath . -Force
npm run check
npm run deploy:production
```

This deploys the timing-only instrumentation to the existing production Worker. No database migration or Cloudflare binding change is required.

## View the measurements

Open Workers & Pages → `karaoke-backend-production` → Observability. Open an invocation for `POST /api/songs/.../uploads/complete` and find the custom log whose JSON contains `"event":"upload_completion_timing"`. The `stages` object contains the measurements; `totalWallMs` is the full service-operation elapsed time.

Cloudflare reports total invocation CPU separately on the invocation. These stage measurements are elapsed wall time, which includes waiting for Turso and R2. They are useful for identifying slow stages, but they are not per-stage CPU measurements and should not be added together as CPU time. Compare several audio and package completions because network and isolate variation can affect individual samples.
