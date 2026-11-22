# Upload CPU Optimization Patch (`karaoke-upload-cpu-optimization`)

## Included Files
- `src/index.ts` — Pre-warm `TursoHttpDatabase` (`await db.prewarm()`) and `R2FileStorage` (`await storage.prewarm()`) at Worker module evaluation time and use a single `TextEncoder.encode()` pass in `res.json()` to set `Content-Length` and construct the `Response` body without redundant UTF-8 scans.
- `src/Main/TursoHttpDatabase.ts` — Replace dynamic `await import('@libsql/client/web')` with a static top-level import and implement `await db.prewarm()` to warm both native `TursoHttpDatabase.execute()` (`encode`, `decode`, `queryResult`) and official `@libsql/client/web` `batch(..., 'write')` (`HttpClient.batch`, `executeHranaBatch`, `SqlCache`, `HttpStream`, Hrana JSON encoder/decoder) at module startup using an in-memory synthetic response with zero network I/O.
- `src/Modules/Services/R2FileStorage.ts` — Use synchronous `node:crypto` (`NodeCryptoSha256`) with a bounded cache for string-secret credential-derivation HMACs, cache the R2 hostname and bucket path prefix, add a regex fast path (`SAFE_S3_KEY_RE`) for ASCII staging/canonical object keys before falling back to `extendedEncodeURIComponent`, bypass per-call `getSignedUrl` and `CopyObjectCommand` Smithy middleware/XML-parser overhead in `uploadUrl()`, `downloadUrl()`, and `promote()` by signing `HttpRequest` directly with `S3RequestPresigner` (`presigner.presign` / `presigner.signer.sign`) while validating `<CopyObjectResult>` and `<Error><Code>` responses, and implement `await storage.prewarm()` to warm `uploadUrl()`, `downloadUrl()`, and `promote()` at startup with zero network I/O.
- `src/Modules/Song/SongRepository.ts` — Use single-statement `UPDATE ... RETURNING` with 3 bindings and 10 columns via native `TursoHttpDatabase.execute()` in `claimForCompletion`, skip the 5-statement reservation write batch on invalid assets while using `RETURNING final_key` (1 column instead of 10) and positional `?1`/`?2` bindings in `reserveForSong`, and reduce `complete` bindings to 1 argument on statements `[0]` and `[2]`.
- `src/Modules/Services/SongService.ts` — Use `claimForCompletion`, `reserveForSong`, module-level `TextDecoder`, byte-slice media signature checks (`isValidMediaSignature`), and `parseSongPackage`, skipping redundant `get()` / `song_reload` roundtrips on normal paths.
- `src/Modules/Song/SongPackage.ts` — Add single-pass strict structural & interval validator (`parseSongPackage`) with exact Zod fallback on invalid packages.
- `src/DTOs/Song/UploadSongRequest.ts` — Add `_fastParse` fast-path validator matching `uploadSongSchema` constraints.
- `src/Controllers/SongController.ts` — Add fast-path UUID/strict-object validation (`parseCompleteUploadBody`) with `completeUploadBodySchema` fallback.
- `scripts/profile-worker.mjs` — Upload-specific local `workerd`/Miniflare profiler measuring Worker startup prewarming (asserting zero startup network I/O) and 60 warmed iterations each of `POST /api/songs/:id/uploads` (reservation), audio `POST /api/songs/:id/uploads/complete`, and package `POST /api/songs/:id/uploads/complete` across `0 ms` and `20 ms` simulated I/O delays, reporting owned-`workerd`-PID OS CPU, V8 CDP sample ticks (`50 µs` interval), source-mapped V8 hotspots, wall time, and stubbed I/O wait time separately.
- `tests/upload-optimization.test.ts` — Unit regression tests for `R2FileStorage` signing equivalence, special-character key encoding parity, direct `promote()` error handling (`412 PreconditionFailed`, `403 AccessDenied`, and `200` embedded `<Error>`), `R2FileStorage.prewarm()` and `TursoHttpDatabase.prewarm()` zero-network startup warmup, atomic reservation/claim/completion precedence & budget invariants, `_fastParse`/`parseSongPackage` Zod parity, and all media signature checks.
- `tests/worker-smoke.test.mjs` — `workerd` integration test exercising `MEDIA_BUCKET` R2 binding + conditional S3 `CopyObject` ETag precondition checks for audio and package uploads.

## Apply & Verify (from `C:\Karaoke\backend`)
```powershell
Expand-Archive -Path "$env:USERPROFILE\Downloads\karaoke-upload-cpu-optimization.zip" -DestinationPath C:\Karaoke\backend -Force
npm run format:check
npm run check
npx wrangler deploy --dry-run --env production
node scripts/profile-worker.mjs
```
(If untouched existing files in your tree fail `format:check`, run `npm run format` first and re-run `npm run format:check`.)
