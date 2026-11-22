# R2 upload finalization in Workers

The supplied backend's Wrangler build selected the AWS SDK browser XML parser.
That parser requires DOMParser, which Workers does not provide. This was reproduced
while parsing CopyObject's successful XML response, after HEAD and audio reads had
already succeeded. The same storage operations passed after selecting the SDK's
CommonJS XML implementation, without adding a DOM polyfill.

Cloudflare documents this fix:
https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/

The update pins @aws-sdk/xml-builder 3.972.43 as a direct dependency and adds this
root-level Wrangler alias:

```json
"alias": {
  "@aws-sdk/xml-builder": "@aws-sdk/xml-builder/dist-cjs/index.js"
}
```

The ZIP contains wrangler.jsonc, package.json, package-lock.json, two Worker test
files, and these instructions. These configuration/dependency files come from the
supplied backend project. Preserve any later custom changes you made to those files
when applying this update. The ZIP contains no credentials, database, migrations,
password-validation source, or administrator/account update.

Stop Wrangler with Ctrl+C, extract into C:\Karaoke\backend, and run:

```powershell
cd C:\Karaoke\backend
npm ci
npm run check
npm run dev:worker
```

Keep Wrangler running. In a second PowerShell window:

```powershell
cd C:\Karaoke\backend
node --env-file=.dev.vars scripts/test-backend-e2e.mjs
```

Use the current administrator password. Share only PASS/FAIL output.
The failed practice draft remains available for inspection. The full test creates
another clearly marked practice song; it does not reset credentials or re-import
the database.

Verification uses the actual Wrangler-built storage code in Miniflare with fake
credentials and an in-memory transport. It covers successful conditional copy,
content-type preservation, reads, cleanup, HTTP 403 XML errors, and HTTP 200 XML
error bodies. The main application bundle is also checked for the unwanted DOMParser
implementation. Full backend checks run locally; real Turso/R2 validation still
requires the end-to-end command on your machine. Nothing has been deployed.
