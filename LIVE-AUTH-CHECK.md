# Check deployed administrator authentication

This helper tests only the deployed API at:
https://karaoke-backend-production.marclouiegi-olino.workers.dev

It checks health, logs in with the entered administrator credentials, checks the
session, logs out, and verifies that the old session no longer authorizes requests.
The login and logout create/delete the test session normally. It does not reset
passwords, change accounts, upload songs, deploy code, or modify configuration.

Extract into C:\Karaoke\backend, then run:

```powershell
cd C:\Karaoke\backend
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-live-auth.ps1
```

Press Enter to use micaela or enter the administrator username/email. Enter the
current password at PowerShell's masked prompt. The script file keeps try/finally
together and prevents subsequent pasted commands from becoming password input.
Node sends the JSON request; no additional packages, reinstall, or deployment is
required. Credentials are passed through stdin, never as command-line arguments.
Redirects are rejected, and the target HTTPS origin is fixed in the script.

Share only the PASS, FAIL, INFO, and LIVE AUTH CHECK lines. Diagnostics show the
HTTP status, response classification, recognized API code, validation field names,
and safe request identifiers when available. They never print passwords, cookies,
request/response bodies, hashes, or credentials from .dev.vars. This helper does
not need to read .dev.vars.

A non-JSON response does not by itself prove Cloudflare blocked the request or
that the backend is faulty. A validation error does not prove the password is
wrong. The diagnostics distinguish these cases before making backend changes.

Automated tests exercise HTTP/JSON errors, HTML errors, restricted credential
destinations, production cookie requirements, cleanup after failures, session
revocation, split Unicode stdin, and a real local HTTP transport with UTF-8 input
and matching Content-Length. The Windows PowerShell 5.1 wrapper must be run on
your Windows machine; it cannot be executed in this Linux workspace.

A successful test confirms this authentication exchange only. Use Cloudflare's
invocation CPU metrics and target-browser checks separately before concluding
that the app consistently fits Workers Free or that browser sign-in is ready.
