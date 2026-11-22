param([switch]$MigrateOnly)
$ErrorActionPreference = 'Stop'
$originalLocation = Get-Location
$previousEncoding = $OutputEncoding
$securePassword = $null
$credentialPayload = $null
$pepperPayload = $null
$exitCode = 1
function Assert-Success([string]$Step) {
    if ($LASTEXITCODE -ne 0) { throw "$Step failed. Stop here and share the PASS/FAIL output." }
}
try {
    Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
    Write-Host 'Karaoke Worker auth installer v2'
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    if (-not $MigrateOnly) {
        # Use the OAuth login already established for this account, in this process only.
        Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
        $env:WRANGLER_LOG = 'info'
        $env:CLOUDFLARE_ACCOUNT_ID = '9c440e422ba1fde78de0dd2e1c6a8514'
        & node --import tsx scripts/worker-auth-migration.mjs check-target
        Assert-Success 'Karaoke production target check'
        & npx wrangler secret list --env production
        Assert-Success 'Cloudflare access check'
        & npm run check
        Assert-Success 'Backend checks'
        & node --import tsx --test tests/worker-auth-migration.test.mjs tests/login-check.test.mjs tests/live-auth-check.test.mjs
        Assert-Success 'Migration and diagnostic checks'
    }
    & node --import tsx scripts/worker-auth-migration.mjs prepare
    Assert-Success 'Dedicated pepper setup'
    $login = Read-Host 'Existing administrator username/email [micaela]'
    if ([string]::IsNullOrWhiteSpace($login)) { $login = 'micaela' }
    $securePassword = Read-Host 'CURRENT password (the password will stay the same)' -AsSecureString
    $credentialPayload = @{
        login = $login
        password = ([pscredential]::new('migration', $securePassword)).GetNetworkCredential().Password
    } | ConvertTo-Json -Compress
    if ($MigrateOnly) {
        $credentialPayload | & node --import tsx scripts/worker-auth-migration.mjs migrate --apply
    } else {
        $credentialPayload | & node --import tsx scripts/worker-auth-migration.mjs migrate --apply --require-admin
    }
    Assert-Success 'Verified account password migration'
    if (-not $MigrateOnly) {
        $pepperPayload = & node --import tsx scripts/worker-auth-migration.mjs payload
        Assert-Success 'Pepper upload preparation'
        $pepperPayload | & npx wrangler secret bulk --env production
        Assert-Success 'Production pepper upload'
        $pepperPayload = $null
        # npm run check passed above, before any remote credential change.
        & npx wrangler deploy --env production
        Assert-Success 'Production deployment'
        $credentialPayload | & node scripts/test-live-auth.mjs
        Assert-Success 'Live authentication verification'
        Write-Host 'WORKER AUTH UPDATE PASSED'
        Write-Host 'Next verify deployed CPU time; a successful login is not a CPU-budget guarantee.'
    }
    $exitCode = 0
}
finally {
    $credentialPayload = $null
    $pepperPayload = $null
    if ($null -ne $securePassword) { $securePassword.Dispose() }
    $OutputEncoding = $previousEncoding
    Set-Location -LiteralPath $originalLocation.Path
}
exit $exitCode
