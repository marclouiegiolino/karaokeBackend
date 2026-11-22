# R2 size metadata fix (metadata-v3)

The live result showed a successful signed upload with the expected content type, but the adapter reported 0 bytes. The old `head()` method used `ContentLength ?? 0`, so an unavailable Content-Length was indistinguishable from a truly empty object. The earlier Content-Type signing change did not fix this separate size-reading issue.

This patch:

- Keeps explicit Content-Type and Content-Length signing for uploads.
- Requests `Accept-Encoding: identity` in SDK transport requests, preserving object-size headers on compressible responses where supported.
- Treats unavailable size as unknown rather than zero.
- If HEAD omits length, requests exactly one byte with an ETag condition and reads the full size from a validated `Content-Range` header.
- Rejects missing/unverifiable sizes and missing ETags; it never substitutes the expected upload size.
- Retains actual zero-length metadata as zero, so a genuinely empty upload still fails the nonempty-file check.
- Downloads and verifies the actual uploaded bytes before asserting HEAD metadata in the test script. This distinguishes a real empty upload from metadata handling failure.

A reported R2 HEAD/compression behavior is documented by a firsthand client issue: https://github.com/async-aws/aws/issues/2077 . It is consistent with this symptom, but your exact raw response headers have not been observed. Requesting identity and the validated range fallback address missing size metadata without bypassing validation.

## Apply

Stop the backend with Ctrl+C. Download the patch into Downloads, then run:

```powershell
Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\karaoke-r2-size-fix.zip" -DestinationPath "C:\Karaoke\backend" -Force
cd C:\Karaoke\backend
node --env-file=.dev.vars --import tsx scripts/test-r2.mjs
```

The output should begin with `R2 test: metadata-v3`. If it does not, the new script was not extracted to the backend's scripts directory.

The ZIP replaces only the supplied storage interface/adapter, test script and associated tests. It adds this guide. It contains no `.dev.vars`, credentials or database, and makes no database or existing-media changes. If you have independently edited these source/test files, copy them aside before extraction.

## Expected checks

- CORS upload preflight
- Signed upload
- Signed download and exact byte verification
- Metadata (`sizeSource` is `head` or `range`; `actualBytes` should match `expectedBytes`)
- Byte-range download
- Conditional copy with preserved content type
- Temporary file cleanup

A successful run ends with `R2 CONNECTION TEST PASSED`. If it fails, share the new output and the `Upload metadata:` line. Keys and signed URLs are not printed.

## Verification

- 27 API/database/SDK tests passed, including 5 new tests using the actual AWS SDK and FetchHttpHandler with controlled HTTP responses.
- 2 Workers runtime smoke tests passed.
- 7 connection-test orchestration/error/cleanup tests passed.
- TypeScript checking and the Workers bundle passed.

The new SDK tests cover identity request headers, parsed HEAD length, missing length with validated one-byte fallback, genuine zero-length objects, invalid range metadata, and missing ETags. They preserve the existing strict size limits and ETag conditions. No real R2 credentials were available to the assistant; run the command to verify your account.
