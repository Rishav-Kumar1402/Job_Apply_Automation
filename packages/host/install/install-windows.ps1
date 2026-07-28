$ErrorActionPreference = "Stop"

$HostName = "com.jobautoapply.host"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostDir = Split-Path -Parent $ScriptDir
$HostPath = Join-Path $HostDir "install\host-launcher.bat"

Write-Host "Building host..."
Push-Location (Join-Path $HostDir "..\..")
npm run build -w @job-autoapply/host
Pop-Location

$ChromeDir = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\NativeMessagingHosts"
New-Item -ItemType Directory -Force -Path $ChromeDir | Out-Null

$ManifestPath = Join-Path $ChromeDir "$HostName.json"

$Manifest = @{
  name = $HostName
  description = "Job Auto-Apply Playwright automation host"
  path = $HostPath
  type = "stdio"
  allowed_origins = @("chrome-extension://REPLACE_WITH_EXTENSION_ID/")
} | ConvertTo-Json

$Manifest | Set-Content -Path $ManifestPath -Encoding UTF8

Write-Host "Installed to $ManifestPath"
Write-Host "Replace REPLACE_WITH_EXTENSION_ID with your extension ID."
