param(
  [string]$Project = 'chemistry-tutor-493405',
  [string]$Region = 'asia-northeast3',
  [string]$Service = 'science-inquiry-platform',
  [string]$ServiceUrl = 'https://science-inquiry-platform-mx3s6ovg6a-du.a.run.app',
  [string]$Gcloud = 'gcloud'
)
$ErrorActionPreference = 'Stop'
function Invoke-Cloud([string[]]$CloudArgs) {
  & $Gcloud @CloudArgs
  if ($LASTEXITCODE -ne 0) { throw "Cloud command failed: $($CloudArgs[0..2] -join ' ')" }
}
# Deploy the application with SUMMARY_SCHEDULER_EMAIL and SUMMARY_SCHEDULER_AUDIENCE
# first. This account can invoke only this service and has no database permissions.
$schedulerId = 'science-summary-scheduler'
$schedulerEmail = "$schedulerId@$Project.iam.gserviceaccount.com"
$jobId = 'science-daily-discussion-summaries'
Invoke-Cloud @('services','enable','cloudscheduler.googleapis.com',"--project=$Project",'--quiet')
$accounts = & $Gcloud iam service-accounts list "--project=$Project" "--filter=email:$schedulerEmail" '--format=value(email)'
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect service accounts.' }
if (-not ($accounts -contains $schedulerEmail)) {
  Invoke-Cloud @('iam','service-accounts','create',$schedulerId,"--project=$Project",'--display-name=Science daily discussion summary scheduler','--quiet')
}
Invoke-Cloud @('run','services','add-iam-policy-binding',$Service,"--project=$Project","--region=$Region","--member=serviceAccount:$schedulerEmail",'--role=roles/run.invoker','--quiet','--format=none')
$jobs = & $Gcloud scheduler jobs list "--project=$Project" "--location=$Region" '--format=value(name)'
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect scheduler jobs.' }
$operation = if (@($jobs | Where-Object { $_ -like "*/$jobId" }).Count) { 'update' } else { 'create' }
Invoke-Cloud @('scheduler','jobs',$operation,'http',$jobId,"--project=$Project","--location=$Region",'--schedule=*/5 * * * *','--time-zone=Asia/Seoul',"--uri=$ServiceUrl/api/internal/daily-summaries",'--http-method=POST',"--oidc-service-account-email=$schedulerEmail","--oidc-token-audience=$ServiceUrl",'--attempt-deadline=900s','--max-retry-attempts=2','--quiet','--format=value(name,state)')
