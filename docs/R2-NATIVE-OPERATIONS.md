# Native R2 operations for upload finalization

This update uses the Cloudflare Worker R2 binding for internal object metadata reads, package/audio reads, ranged prefix reads, and deletion. It keeps the existing S3-compatible client for presigned direct uploads/downloads and conditional server-side `CopyObject` promotion. The promotion still checks the staging object ETag, so audio bytes are not streamed through the Worker to promote them.

The production Wrangler environment binds `MEDIA_BUCKET` to the existing `karaoke-media` bucket. Preview and local environments continue using the existing S3 adapter until a separate preview bucket is selected. The existing R2 account/access-key secrets remain required for presigned URLs.

## Apply and verify

```powershell
cd C:\Karaoke\backend
Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\karaoke-native-r2-operations.zip" -DestinationPath . -Force
npm run check
npx wrangler deploy --dry-run --env production
```

Confirm the dry-run lists `env.MEDIA_BUCKET (karaoke-media)` as an R2 Bucket. Then deploy:

```powershell
npm run deploy:production
```

After deployment, run `scripts/check-live-draft-package-first.ps1` and compare several `upload_completion_timing` records with each invocation's Cloudflare CPU time. Stage values remain wall time, not per-stage CPU; this change is an optimization candidate, not a guarantee that every completion falls below 10 ms CPU.
