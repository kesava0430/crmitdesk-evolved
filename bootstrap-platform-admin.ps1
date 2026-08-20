<#
  bootstrap-platform-admin.ps1

  One-time utility: creates (or promotes) the single cross-org PLATFORM_ADMIN
  login for the CRMITdesk Evolved server, by calling
  POST /api/platform/bootstrap (server/src/modules/platform-admin).

  Requires PLATFORM_BOOTSTRAP_SECRET to be set as an env var on the live
  server (Render -> crm-itdesk-server -> Environment) — the endpoint 404s
  if it isn't set.

  SECURITY: never write the real secret or password into this file — it is
  committed to git, and anything committed must be treated as public. The
  script reads them from environment variables instead; set them for the
  current PowerShell session only, then run:

      $env:PLATFORM_BOOTSTRAP_SECRET = "<the secret from Render>"
      $env:PLATFORM_ADMIN_EMAIL      = "you@example.com"
      $env:PLATFORM_ADMIN_PASSWORD   = "<a strong password>"
      $env:PLATFORM_ADMIN_NAME       = "Your Name"
      .\bootstrap-platform-admin.ps1

  Safe to re-run later (e.g. to reset the password) — it upserts by email
  rather than creating a duplicate account. Unset PLATFORM_BOOTSTRAP_SECRET
  on Render after use so the endpoint is disabled.
#>

$ServerUrl = if ($env:PLATFORM_SERVER_URL) { $env:PLATFORM_SERVER_URL } else { "https://crm-itdesk-server.onrender.com" }
$Secret    = $env:PLATFORM_BOOTSTRAP_SECRET
$Email     = $env:PLATFORM_ADMIN_EMAIL
$Password  = $env:PLATFORM_ADMIN_PASSWORD
$Name      = if ($env:PLATFORM_ADMIN_NAME) { $env:PLATFORM_ADMIN_NAME } else { "Platform Admin" }

if (-not $Secret -or -not $Email -or -not $Password) {
    Write-Host "Set PLATFORM_BOOTSTRAP_SECRET, PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD as env vars first — see the comment at the top of this script. Do NOT hardcode them into the file." -ForegroundColor Yellow
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
