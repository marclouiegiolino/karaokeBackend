# Frontend offline contract

The backend does not need to run on the phone. Express remains online for authentication, catalog access, downloads and result syncing. Audio playback and scoring run on the device.

## Download

1. While signed in and online, request `GET /api/songs/:id/download`.
2. Fetch the audio, lyrics/melody JSON, and optional cover. R2 CORS must allow the frontend origin.
3. Store them under stable keys based on song ID, package version and asset kind. Do not use expiring signed URLs as permanent cache identities.
4. Store metadata in IndexedDB. Mark the song available offline only after all required files are saved successfully. On partial failure, clean up or resume the partial download.
5. Precache the app shell, scoring code, microphone worklet and offline routes in the Next.js PWA. Installing a PWA alone does not download songs.

The sample package uses MIDI note numbers and milliseconds. The first scoring version uses pitch 60%, timing 25%, coverage 15%. The frontend needs to implement pitch detection, confidence gating, silence handling, timing calibration, note matching, and consistent key/tempo adjustments. These are not implemented by this backend. Neither a lyrics file nor a backing track alone supplies a reference vocal melody.

## Score locally

Use the microphone input exposed by the browser. Process audio on the device, preferably using an AudioWorklet. Keep the captured microphone stream separate from backing-track playback so that the scoring engine analyzes the singer's input. Test wired headset, built-in and supported external microphones. Browser permission and device routing still apply; physical microphone connection alone does not guarantee browser access.

Use a playback clock tied to the actual media position. Pause/resume, seeking, buffering, key shifts, tempo changes and input latency must be reflected in score matching. Avoid awarding points for silence/noise. Save only completed, locally calculated summaries by default, not raw microphone audio.

## Queue results and sync

- Generate a performance UUID once, before saving the local result.
- Store the owning local account ID with the queued item; partition downloads/results appropriately if multiple people use one device.
- Offline play must not call `/auth/me` as a prerequisite. A cached local profile is a display convenience, not a server authorization grant.
- When the app is online and open again, require the original account to sign in, then POST the queued result to `/performances/sync` with `credentials: 'include'`.
- Remove a queue item only after HTTP 200/201 confirms the matching performance ID. Repeat failed network requests with the same ID and same payload.
- A 401 means sign in; a 409 needs review. Never change IDs just to make a conflict disappear.
- Trigger sync on launch, on an online event, and with a manual retry button. Background Sync is optional; do not rely on it working everywhere or while the app is closed.

Browser storage can be evicted or cleared. Provide download management and pending-sync status. Request persistent storage where supported, but do not promise permanent storage. Playback from fully downloaded files should be tested in airplane mode after closing/reopening the app.

## Trust

Local scoring supports offline use and low hosting costs. The server cannot treat uploaded summaries as tamper-proof. Do not use these scores for prizes, paid contests or trusted competitive rankings without a separate verification design.
