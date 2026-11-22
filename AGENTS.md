# Project conventions

This project intentionally follows the Medical Booking API folder layout.

- Controllers handle HTTP; services enforce permissions/business rules; repositories use parameterized SQL.
- Runtime entry is src/index.ts (Cloudflare adapter); local development entry is src/local.ts.
- Use the web-compatible libSQL entry in Workers. Do not add filesystem-backed SQLite or native addons to the Worker bundle.
- Workers uses Main/TursoHttpDatabase.ts for individual execute calls. Keep batch and interactive transactions delegated to the official web-compatible libSQL client. Never replay an uncertain write or silently fall back to another client after an execute error.
- Normal authentication, authorization and rate-limit denials return their existing error JSON directly; unexpected database/runtime failures still go through ErrorHandler.
- Cloudflare bindings/settings are validated in Main/Configuration.ts and injected through Main/Dependencies.ts.
- Never run migrations on requests, login, startup, polling, or playback. Apply numbered SQL explicitly.
- Keep applied migrations immutable; use additional migrations.
- Never log passwords, cookies, Turso tokens, R2 credentials or signed URLs.
- On 2026-11-17 the user explicitly approved the Romantic Album pattern for Karaoke: 12,000 PBKDF2-SHA256 iterations after HMAC-SHA256 with a dedicated random pepper. This overrides the prior 600,000-iteration policy for this migration. Do not make further reductions or use an unpeppered fallback. Deployed CPU measurements still determine Free-plan suitability.
- Legacy password verification belongs only in the explicitly invoked local migration utility. Never derive the legacy 600,000-iteration hash in Worker request handling.
- Keep user roles server-controlled. Enforce playlist ownership and administrator permissions on the backend.
- Preserve duplicate-safe performance IDs and payload conflict checks. Device-reported results are not anti-cheat verified.
- Keep all microphone/pitch scoring in the frontend for offline support.
- Upload only to staging, validate, then conditionally copy to unique canonical keys. Avoid overwriting published media.
- Keep storage reservations transactional and account for uncertain upload completion until recovery.
- After code changes, run npm run check. Use Preview for real integration checks before Production.
