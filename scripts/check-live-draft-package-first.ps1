$ErrorActionPreference = 'Stop'
$originalLocation = Get-Location
$previousEncoding = $OutputEncoding
$securePassword = $null
$payload = $null
$exitCode = 1
try {
    Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $login = Read-Host 'Administrator username/email [micaela]'
    if ([string]::IsNullOrWhiteSpace($login)) { $login = 'micaela' }
    $securePassword = Read-Host 'Administrator password' -AsSecureString
    $payload = @{
        login = $login
        password = ([pscredential]::new('live-check', $securePassword)).GetNetworkCredential().Password
    } | ConvertTo-Json -Compress
    $payload | & node scripts/check-live-draft-package-first.mjs
    $exitCode = $LASTEXITCODE
}
finally {
    $payload = $null
    if ($null -ne $securePassword) { $securePassword.Dispose() }
    $OutputEncoding = $previousEncoding
    Set-Location -LiteralPath $originalLocation.Path
}
exit $exitCode
