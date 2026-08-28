param(
  [Parameter(Mandatory = $true)]
  [string]$BaseUrl,
  [Parameter(Mandatory = $true)]
  [string]$RosterPath
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$secretPath = Join-Path $projectRoot ".deployment-secrets.local.json"
$credentialsDir = Join-Path $projectRoot "tmp\pdfs"
$credentialsPath = Join-Path $credentialsDir "student-credentials.json"

if (Test-Path -LiteralPath $credentialsPath) {
  throw "학생 계정 발급 파일이 이미 있습니다. 중복 등록을 막기 위해 중단했습니다."
}

$secrets = Get-Content -LiteralPath $secretPath -Raw | ConvertFrom-Json
$loginBody = @{
  loginId = "teacher"
  password = [string]$secrets.BOOTSTRAP_TEACHER_PASSWORD
} | ConvertTo-Json -Compress

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$login = Invoke-RestMethod `
  -Uri "$BaseUrl/api/auth/login" `
  -Method Post `
  -ContentType "application/json" `
  -Body $loginBody `
  -WebSession $session `
  -TimeoutSec 180

$upload = Invoke-RestMethod `
  -Uri "$BaseUrl/api/teacher/roster" `
  -Method Post `
  -Form @{ file = Get-Item -LiteralPath $RosterPath } `
  -WebSession $session `
  -TimeoutSec 300

New-Item -ItemType Directory -Path $credentialsDir -Force | Out-Null
@{
  baseUrl = $BaseUrl
  issued = @($upload.issued)
} | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $credentialsPath -Encoding utf8NoBOM

$dashboard = Invoke-RestMethod `
  -Uri "$BaseUrl/api/teacher/roster" `
  -Method Get `
  -WebSession $session `
  -TimeoutSec 180

@{
  loginDestination = $login.destination
  sourceRows = $upload.total
  newAccounts = @($upload.issued).Count
  databaseStudents = $dashboard.counts.students
  databaseTeams = $dashboard.counts.teams
  credentialsSaved = $true
} | ConvertTo-Json -Compress
