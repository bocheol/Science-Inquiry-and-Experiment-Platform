param([ValidateSet('start', 'stop', 'status')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/test-infra'))
$taskBin = Join-Path $taskRoot 'postgres16/pgsql/bin'
$taskData = Join-Path $taskRoot 'data16'
$taskPassword = Join-Path $taskRoot 'local-postgres-password.txt'
$taskMarker = Join-Path $taskRoot 'local-postgres-marker.txt'
$taskLog = Join-Path $taskRoot 'postgres16.log'
if (-not (Test-Path -LiteralPath (Join-Path $taskBin 'pg_ctl.exe'))) { throw 'Extract official PostgreSQL 16 binaries into output/test-infra/postgres16 first.' }
if ($Action -eq 'start' -and -not (Test-Path -LiteralPath $taskData)) {
  if (Test-Path -LiteralPath $taskPassword) { throw 'Existing password without a cluster: inspect the local validation folder before initialization.' }
  [IO.File]::WriteAllText($taskPassword, [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)), [Text.UTF8Encoding]::new($false))
  & (Join-Path $taskBin 'initdb.exe') '-D' $taskData '-U' 'codex_local' "--pwfile=$taskPassword" '--auth=scram-sha-256' '--encoding=UTF8' '--locale=C'
  if ($LASTEXITCODE -ne 0) { throw 'Local validation cluster initialization failed.' }
  [IO.File]::WriteAllText($taskMarker, 'science-inquiry-disposable-postgres16', [Text.UTF8Encoding]::new($false))
}
if (-not (Test-Path -LiteralPath $taskMarker) -or [IO.File]::ReadAllText($taskMarker) -ne 'science-inquiry-disposable-postgres16') { throw 'The disposable cluster marker is missing or incorrect.' }
if ([IO.File]::ReadAllText((Join-Path $taskData 'PG_VERSION')).Trim() -ne '16') { throw 'Expected a PostgreSQL 16 validation cluster.' }
if ($Action -eq 'status') {
  & (Join-Path $taskBin 'pg_ctl.exe') 'status' '-D' $taskData
  exit $LASTEXITCODE
}
$taskArgs = if ($Action -eq 'start') {
  @('start', '-D', ('"' + $taskData + '"'), '-l', ('"' + $taskLog + '"'), '-o', '"-h 127.0.0.1 -p 55416 -c max_connections=30 -c shared_buffers=32MB"', '-w', '-t', '30')
} else {
  @('stop', '-D', ('"' + $taskData + '"'), '-m', 'fast', '-w', '-t', '30')
}
$taskProcess = Start-Process -FilePath (Join-Path $taskBin 'pg_ctl.exe') -ArgumentList $taskArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRoot 'pg-ctl-out.log') -RedirectStandardError (Join-Path $taskRoot 'pg-ctl-error.log')
# Retain the native handle before waiting; Windows PowerShell can otherwise
# report a null ExitCode after the short-lived pg_ctl process has exited.
$null = $taskProcess.Handle
# Wait for pg_ctl itself, not its long-lived postgres descendant process tree.
if (-not $taskProcess.WaitForExit(35000)) { throw 'pg_ctl observation timed out; check status before starting again.' }
if ($taskProcess.ExitCode -ne 0) { throw "Local PostgreSQL $Action failed; inspect output/test-infra/postgres16.log." }
Write-Output "Local validation PostgreSQL: $Action succeeded (127.0.0.1:55416)."
