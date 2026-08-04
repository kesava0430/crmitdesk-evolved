<#
  bootstrap-platform-admin.ps1

  One-time utility: creates (or promotes) the single cross-org PLATFORM_ADMIN
  login for the CRMITdesk Evolved server, by calling
  POST /api/platform/bootstrap (server/src/modules/platform-admin).

  Requires PLATFORM_BOOTSTRAP_SECRET to be set as an env var on the live
  server (Render -> crm-itdesk-server -> Environment) — the endpoint 404s
  if it isn't set. Fill in the four values below, then run:

      .\bootstrap-platform-admin.ps1

  Safe to re-run later (e.g. to reset the password) — it upserts by email
  rather than creating a duplicate account.
#>

# ── Fill these in ────────────────────────────────────────────────────────
$ServerUrl = "https://crm-itdesk-server.onrender.com"
$Secret    = "<paste your PLATFORM_BOOTSTRAP_SECRET here>"
$Email     = "kesava@quantiqsystems.com"
$Password  = "<a strong password>"
$Name      = "Kesava"
# ──────────────────────────────────────────────────────────────────────────

if ($Secret -eq "<paste your PLATFORM_BOOTSTRAP_SECRET here>") {
    Write-Host "Edit this script and fill in `$Secret (and the other values) before running it." -ForegroundColor Yellow
    exit 1
}

$body = @{ email = $Email; password = $Password; name = $Name } | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "$ServerUrl/api/platform/bootstrap" `
        -Method Post `
        -Headers @{ "x-platform-bootstrap-secret" = $Secret } `
        -ContentType "application/json" `
        -Body $body

    Write-Host "Platform admin account ready:" -ForegroundColor Green
    $response | Format-List
    Write-Host "Sign in at $ServerUrl -replace 'server','client' (or your app's login page) with the email/password above." -ForegroundColor Cyan
}
catch {
    Write-Host "Request failed:" -ForegroundColor Red
    if ($_.Exception.Response) {
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        Write-Host $reader.ReadToEnd()
    } else {
        Write-Host $_.Exception.Message
    }
}
