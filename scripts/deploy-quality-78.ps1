param([ValidateSet('stage','activate','verify')][string]$Action='verify',[string]$Image='')
$ErrorActionPreference='Stop'
$taskGcloud='C:/Users/user/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.ps1'
$taskProject='chemistry-tutor-493405';$taskRegion='asia-northeast3';$taskService='science-inquiry-platform'
function Read-Service { $taskData=& $taskGcloud run services describe $taskService --region=$taskRegion --project=$taskProject --format=json; if($LASTEXITCODE){throw 'Service metadata unavailable'}; return ($taskData|ConvertFrom-Json) }
function Spec-Hash($taskValue) { $taskValue.spec.template.spec.containers[0].image=''; $taskText=$taskValue.spec.template.spec|ConvertTo-Json -Depth 50 -Compress;return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskText))) }
$taskCurrent=Read-Service
if($Action -eq 'stage'){
 if($Image -notmatch '^asia-northeast3-docker.pkg.dev/chemistry-tutor-493405/cloud-run-source-deploy/science-inquiry-platform@sha256:[a-f0-9]{64}$'){throw 'Unexpected image destination'}
 $taskBefore=[pscustomobject]@{revision=$taskCurrent.status.latestReadyRevisionName;specHash=(Spec-Hash $taskCurrent);image=$Image;checkedAt=[DateTime]::UtcNow.ToString('o')}
 $taskBefore|ConvertTo-Json|Set-Content output/test-infra/deploy-baseline-78.json
 & $taskGcloud run deploy $taskService --project=$taskProject --region=$taskRegion --image=$Image --no-traffic --tag=astra78 --quiet
 if($LASTEXITCODE){throw 'Staged deploy failed'}
}
if($Action -eq 'activate'){
 $taskSmoke=Get-Content output/test-infra/deploy-staged-smoke-78.json -Raw|ConvertFrom-Json
 if($taskSmoke.passed -ne 8){throw 'Staged smoke verification missing'}
 $taskBaseline=Get-Content output/test-infra/deploy-baseline-78.json -Raw|ConvertFrom-Json
 $taskStaged=Get-Content output/test-infra/deploy-stage-78.json -Raw|ConvertFrom-Json
 if($taskCurrent.status.latestReadyRevisionName -ne $taskStaged.revision -or $taskCurrent.spec.template.spec.containers[0].image -ne $taskBaseline.image){throw 'Deployment changed after staged verification'}
 if((Spec-Hash $taskCurrent) -ne $taskBaseline.specHash){throw 'Runtime configuration changed'}
 $taskRevision=$taskCurrent.status.latestReadyRevisionName
 if($taskRevision -eq $taskBaseline.revision){throw 'New ready revision missing'}
 & $taskGcloud run services update-traffic $taskService --project=$taskProject --region=$taskRegion --to-revisions="$taskRevision=100" --quiet
 if($LASTEXITCODE){throw 'Traffic switch failed'}
 & $taskGcloud run services update-traffic $taskService --project=$taskProject --region=$taskRegion --remove-tags=astra78 --quiet
 if($LASTEXITCODE){throw 'Temporary tag removal failed'}
}
$taskFinal=Read-Service
$taskBaseline=Get-Content output/test-infra/deploy-baseline-78.json -Raw|ConvertFrom-Json
$taskActualImage=$taskFinal.spec.template.spec.containers[0].image
if((Spec-Hash $taskFinal) -ne $taskBaseline.specHash){throw 'Runtime configuration changed'}
[pscustomobject]@{action=$Action;revision=$taskFinal.status.latestReadyRevisionName;ready=($taskFinal.status.conditions|Where-Object type -eq 'Ready').status;traffic=$taskFinal.status.traffic;image=$taskActualImage;runtimeUnchanged=$true;checkedAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Depth 8|Set-Content "output/test-infra/deploy-$Action-78.json"
Write-Output "Deployment $Action verified, runtime settings unchanged."
