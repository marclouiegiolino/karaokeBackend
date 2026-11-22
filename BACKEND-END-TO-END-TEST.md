# Verify the complete karaoke backend flow

This add-on exercises the running local Express API, your connected Turso database, and your R2 bucket together. It requires the existing backend and all R2 fixes already applied. No new dependencies or migration are needed.

## What it creates

One four-second original practice song named `[TEST] C-D-E practice ...`, with generated WAV audio and a matching timed lyrics/reference-note JSON package. These are the musical notes C4, D4 and E4, with short pauses between them. This is an instrumental test exercise, not a commercial recording.

The song remains published so it can appear in your future frontend and provide a known reference for pitch/scoring development. Its two small canonical files remain in R2 and are counted by the application's storage budget. A new run creates a new clearly marked test song, so avoid repeatedly rerunning after a successful test.

The helper does not create simulated performance scores, playlists or favorites. It does not alter existing songs or administrator credentials. It creates an ordinary temporary login session and logs it out before completion.

## Install and run

Extract the ZIP directly into `C:\Karaoke\backend`. It adds:

- `scripts/test-backend-e2e.mjs`
- `tests/backend-e2e-script.test.mjs`
- `BACKEND-END-TO-END-TEST.md`

In the first PowerShell window, start the backend:

```powershell
cd C:\Karaoke\backend
npm run dev
```

Keep this window open. In a second PowerShell window:

```powershell
cd C:\Karaoke\backend
node --env-file=.dev.vars scripts/test-backend-e2e.mjs
```

Enter your existing administrator username/email and password. Password input is hidden: no characters or asterisks appear. Type normally and press Enter. The helper sends credentials only to the local API, never to R2, and does not print them. It does not accept a password as a command-line argument or place it in command history.

Your backend should run at `http://localhost:8787/api` with `APP_ENV=development`. If needed, set `KARAOKE_TEST_BASE_URL` to another local address ending in `/api` (no trailing slash). The helper intentionally refuses remote API hosts so this diagnostic cannot accidentally send administrator credentials to a different service.

The Origin header comes from the first entry in `FRONTEND_ORIGINS`, defaulting to `http://localhost:3000`. The backend's allowed origins must match. The frontend does not need to be running yet.

## Expected checks

1. Public API health.
2. Administrator login, HttpOnly-cookie receipt, and authenticated session lookup.
3. Draft creation in Turso.
4. Signed audio upload to R2 and completion/verification through Express.
5. Signed melody-package upload and completion/verification.
6. Publication and discovery in the song catalog.
7. Signed downloads with exact byte comparisons for both published files.
8. Byte-range access to the published WAV.
9. Logout of the test session.

A successful run ends with:

```text
BACKEND END-TO-END TEST PASSED
```

It prints the song ID and saves a local playback copy under `.local\e2e\<song-id>.wav`, along with its JSON package. You can open the WAV in your normal audio player to hear the practice notes. Signed playback URLs are deliberately not printed or saved.

## Failures

- Connection failure before health: ensure the first PowerShell window still shows the backend running.
- `INVALID_CREDENTIALS`: use the administrator account imported into Turso, with its original password.
- Non-administrator account: sign in with the original administrator, not a newly registered USER account.
- `ORIGIN_DENIED`/`ORIGIN_REQUIRED`: verify `FRONTEND_ORIGINS` and restart the backend after configuration changes.
- An upload/metadata error: ensure the `metadata-v3` R2 storage fix was applied and your standalone R2 test passes.
- `UPLOAD_STATE` or `SONG_STATE`: inspect the printed test-song ID and the backend terminal. Incomplete intents can retain reservations until expiration/maintenance. Do not bypass accounting or overwrite existing files.
- If any later step fails, the test song may remain as a draft or published record for inspection. The helper reports its ID and still attempts logout. It does not issue direct SQL or destructive cleanup against Turso.

Share PASS/FAIL output and the API request ID from your backend logs when relevant. Do not share passwords, cookies, `.dev.vars`, database tokens or signed URLs.

## What success does and does not prove

This verifies the local backend connected to real storage/database when you run it. It does not deploy the backend, verify Workers Free CPU limits, implement a Next.js PWA, capture microphone audio, calculate real singing scores, or test offline browser storage.

Six local tests verify generated WAV/package consistency, complete helper orchestration, credential isolation, failed-login behavior, logout after upload/download failures, and rejection of remote API destinations. They use controlled fake API/R2 responses. The existing TypeScript/API/SDK/Workers checks also pass after adding the helper. Your real integration run happens on your computer with your credentials.
