# API contract

Base URL locally: `http://localhost:8787/api`.

All unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`) require an `Origin` header exactly matching a configured frontend origin. Browser requests supply it automatically; CLI/API clients must set it. Cookie authentication is used. In the frontend use `credentials: 'include'`.

JSON request limit is 64 KB. Files upload directly to R2; do not POST media bytes to this API. Unknown JSON fields are rejected for validated request DTOs. IDs are UUID strings. Timestamps are Unix milliseconds. SQL/response field names are snake_case; request DTOs use camelCase as illustrated below.

## Endpoints

| Method               | Path                           | Access                 | Purpose                                        |
| -------------------- | ------------------------------ | ---------------------- | ---------------------------------------------- |
| GET                  | `/health`                      | Public                 | Health without a database query                |
| POST                 | `/auth/register`               | Public when enabled    | Create USER account and session                |
| POST                 | `/auth/login`                  | Public                 | Authenticate and set cookie                    |
| GET                  | `/auth/me`                     | Signed in              | Current user                                   |
| POST                 | `/auth/logout`                 | Any; cookie if present | Revoke current session                         |
| GET                  | `/songs`                       | Signed in              | Published song search and pagination           |
| GET                  | `/songs/:id`                   | Signed in              | Song details; drafts visible to administrators |
| POST                 | `/songs`                       | Admin                  | Create draft                                   |
| PATCH                | `/songs/:id`                   | Admin                  | Edit title, artist, genre, language            |
| POST                 | `/songs/:id/uploads`           | Admin                  | Reserve storage and sign a staging PUT         |
| POST                 | `/songs/:id/uploads/complete`  | Admin                  | Verify an uploaded asset                       |
| POST                 | `/songs/:id/publish`           | Admin                  | Publish a complete draft                       |
| POST                 | `/songs/:id/archive`           | Admin                  | Hide from catalog; retain existing history     |
| GET                  | `/songs/:id/download`          | Signed in              | Temporary URLs for complete song package       |
| GET / POST           | `/playlists`                   | Signed in              | List or create own playlists                   |
| GET / PATCH / DELETE | `/playlists/:id`               | Owner                  | Read, edit, delete playlist                    |
| POST                 | `/playlists/:id/songs`         | Owner                  | Add song once; body `{ "songId": "UUID" }`     |
| DELETE               | `/playlists/:id/songs/:songId` | Owner                  | Remove song                                    |
| GET                  | `/favorites`                   | Signed in              | Own favorites                                  |
| PUT / DELETE         | `/favorites/:songId`           | Signed in              | Add/remove favorite                            |
| POST                 | `/performances/sync`           | Signed in              | Save one device-reported performance           |
| GET                  | `/performances`                | Signed in              | Own score history                              |

List endpoints accept `page` (default 1) and `pageSize` (default 20, maximum 50). Song search accepts `search` (maximum 100 characters). Administrators may add `drafts=true` to include unpublished records. Playlist details are capped by a 500-song playlist limit; playlist reordering is not implemented.

## Examples

Registration (no client-provided role is accepted):

```json
{
  "username": "singer",
  "email": "singer@example.com",
  "displayName": "Singer",
  "password": "your own long unique password"
}
```

Login:

```json
{ "login": "singer", "password": "your own long unique password" }
```

Create a song:

```json
{
  "title": "My Practice Song",
  "artist": "Original Artist",
  "genre": "Acoustic",
  "language": "English",
  "durationMs": 4000
}
```

Request an upload:

```json
{ "kind": "audio", "contentType": "audio/mpeg", "byteSize": 1234567 }
```

Kinds: `audio`, `cover`, `package`. The response includes `uploadId`, `url`, `method`, `headers`, and `expiresIn`. Upload using exactly the returned URL and content type. Do not alter query parameters. PUT URLs expire after 5 minutes. Intents expire after 15 minutes; if an unused intent expires, request a new one. A failed signing request may reserve storage until expiration. Do not request multiple intents for the same song/kind while one is active.

Complete an upload:

```json
{ "uploadId": "the UUID returned by the upload endpoint" }
```

The server checks size/type and signatures; JSON packages also require ordered, non-overlapping lyric/note intervals within the declared duration. Only draft songs accept uploads. Expired/active upload state conflicts return 409. Permanent uploaded keys are generated by the server, not supplied by a client. Repeating a completed upload confirmation returns the current song without counting its bytes again.

See [sample-song-package.json](sample-song-package.json) for the package format. It contains a short invented exercise; it is not a real karaoke track. Prepare a matching 4-second audio file or replace the data with real, verified notes for your own track.

Performance upload:

```json
{
  "id": "7978eae5-fc64-4726-89c1-bc503a8b0304",
  "songId": "b19c9702-26c5-4af7-b70d-9ed0224c1192",
  "packageVersion": 1,
  "scoringVersion": "1.0.0",
  "pitch": 90,
  "timing": 84,
  "coverage": 80,
  "keyShift": 0,
  "tempo": 1,
  "startedAt": 1794873600000,
  "finishedAt": 1794873604000
}
```

Use actual times and a new ID for every attempt. The server attaches the signed-in user, recomputes the weighted total (60% pitch, 25% timing, 15% coverage), and stores a payload digest. This checks request consistency, not singing authenticity. Results identify `verification: "device-reported"`.

- First sync: HTTP 201.
- Same ID, same user, same validated contents: HTTP 200 with `created:false`.
- Same ID with a different user or contents: HTTP 409. Do not silently overwrite.
- Unknown package/scoring versions: HTTP 409/400 respectively; retain the local queue item for review.
- Previously downloaded archived songs may still sync; draft songs cannot.

## Error shape

```json
{ "error": { "code": "UNAUTHENTICATED", "message": "Sign in to continue" }, "requestId": "UUID" }
```

Validation errors include field paths and messages. Internal errors do not expose stacks or database details. Record the request ID when debugging. A 429 response includes `Retry-After: 60`.
