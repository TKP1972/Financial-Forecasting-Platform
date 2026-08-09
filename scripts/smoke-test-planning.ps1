# Smoke test for the connected-planning, workforce, cost-behaviour and
# planning-bias capabilities added against the Agentic AI framework spec.
#
#   pwsh ./scripts/smoke-test-planning.ps1

$ErrorActionPreference = 'Stop'
$base = if ($env:FFP_API_URL) { $env:FFP_API_URL } else { 'http://localhost:4000/api/v1' }
$pass = 0; $fail = 0

function Check($name, $cond, $detail) {
  if ($cond) { $script:pass++; Write-Host ("  PASS  " + $name) -ForegroundColor Green }
  else { $script:fail++; Write-Host ("  FAIL  " + $name + "  -> " + $detail) -ForegroundColor Red }
}
function Login($email, $password) {
  $body = @{ email = $email; password = $password } | ConvertTo-Json
  for ($i = 0; $i -lt 6; $i++) {
    try { return Invoke-RestMethod -Uri "$base/auth/login" -Method Post -Body $body -ContentType 'application/json' }
    catch {
      if ($_.Exception.Response.StatusCode.value__ -eq 429) { Start-Sleep -Seconds 15; continue }
      throw
    }
  }
  throw "login kept hitting the rate limit"
}
function Bearer($t) { return @{ Authorization = "Bearer $t" } }
function PostJson($path, $token, $obj) {
  return Invoke-RestMethod -Uri "$base$path" -Method Post -ContentType 'application/json' `
    -Body ($obj | ConvertTo-Json -Depth 12) -Headers (Bearer $token)
}

$analyst = Login 'analyst@ffp.local' 'Analyst!Local26'
$finmgr  = Login 'finance.manager@ffp.local' 'FinMgr!Local26'
$t = $analyst.accessToken

Write-Host "`n== Vocabulary ==" -ForegroundColor Cyan
$vocab = Invoke-RestMethod -Uri "$base/planning/vocabulary" -Headers (Bearer $t)
Check 'operations exposed' ($vocab.data.operations.Count -ge 6) "got $($vocab.data.operations.Count)"
Check 'seven telecom spend categories' ($vocab.data.spendCategories.Count -eq 7) "got $($vocab.data.spendCategories.Count)"
Check 'three cost behaviours' ($vocab.data.costBehaviours.Count -eq 3) "got $($vocab.data.costBehaviours.Count)"

Write-Host "`n== Connected planning ==" -ForegroundColor Cyan
# churn -> subscribers -> revenue
$graph = @{
  name = 'Connected plan'; periodCount = 4
  nodes = @(
    @{ code='gross_adds'; name='Gross additions'; kind='INPUT'; values=@(1000,1000,1000,1000) },
    @{ code='churn_rate'; name='Churn'; kind='INPUT'; values=@('0.02','0.02','0.02','0.02') },
    @{ code='subscribers'; name='Subscribers'; kind='BALANCE'; operation='BALANCE_WITH_CHURN'
       inputs=@(
         @{ as='opening'; from='subscribers'; lag=1; initial=10000 },
         @{ as='adds'; from='gross_adds' },
         @{ as='churn'; from='churn_rate' }) },
    @{ code='arpu'; name='ARPU'; kind='INPUT'; isMonetary=$true; values=@('25.00','25.00','25.00','25.00') },
    @{ code='revenue'; name='Revenue'; kind='FORMULA'; isMonetary=$true; operation='PRODUCT'
       inputs=@(@{ as='subs'; from='subscribers' }, @{ as='arpu'; from='arpu' }) }
  )
}

$valid = PostJson '/planning/graph/validate' $t $graph
Check 'graph validates' ($valid.data.valid -eq $true) 'invalid'
Check 'dependencies ordered before dependents' ([array]::IndexOf($valid.data.evaluationOrder,'subscribers') -lt [array]::IndexOf($valid.data.evaluationOrder,'revenue')) 'bad order'

$evald = PostJson '/planning/graph/evaluate' $t $graph
# P1: 10000 - 200 + 1000 = 10800 ; revenue 10800 x 25 = 270,000
Check 'balance carries forward correctly' ([math]::Abs([double]$evald.data.byCode.subscribers[0] - 10800) -lt 0.01) "got $($evald.data.byCode.subscribers[0])"
Check 'downstream revenue computed' ([math]::Abs([double]$evald.data.byCode.revenue[0] - 270000) -lt 0.01) "got $($evald.data.byCode.revenue[0])"

# A cycle must be rejected, not looped on
$cyclic = @{ name='Cyclic'; periodCount=2; nodes=@(
  @{ code='a'; name='A'; kind='FORMULA'; operation='SUM'; inputs=@(@{ as='x'; from='b' }) },
  @{ code='b'; name='B'; kind='FORMULA'; operation='SUM'; inputs=@(@{ as='x'; from='a' }) }) }
try { PostJson '/planning/graph/validate' $t $cyclic | Out-Null; Check 'circular dependency rejected' $false 'accepted' }
catch { Check 'circular dependency rejected' ($_.Exception.Response.StatusCode.value__ -eq 422) "status $($_.Exception.Response.StatusCode.value__)" }

# The headline capability: change churn, see everything downstream move
$impact = PostJson '/planning/graph/impact' $t @{ graph = $graph; change = @{ nodeCode='churn_rate'; factor='2' } }
Check 'churn change propagates to subscribers' ($impact.data.affectedNodes -contains 'subscribers') 'not propagated'
Check 'churn change propagates to revenue' ($impact.data.affectedNodes -contains 'revenue') 'not propagated'
Check 'unrelated node untouched' (-not ($impact.data.affectedNodes -contains 'arpu')) 'arpu moved'
$revDelta = ($impact.data.deltas | Where-Object { $_.code -eq 'revenue' }).delta
Check 'higher churn reduces revenue' ([double]$revDelta -lt 0) "delta $revDelta"

Write-Host "`n== Workforce (AHT / occupancy / shrinkage) ==" -ForegroundColor Cyan
$wf = PostJson '/planning/workforce' $t @{
  code='CS'; name='Customer service'; volumes=@(100000)
  averageHandleTimeSeconds=300; occupancy=0.8; shrinkage=0.3
  hoursPerFtePerPeriod=160; costPerFtePerPeriod='5000.00'
}
# workload 8333.33h ; productive 160 x 0.7 x 0.8 = 89.6h ; FTE = 93.006
Check 'productive hours per FTE correct' ([math]::Abs([double]$wf.data.periods[0].productiveHoursPerFte - 89.6) -lt 0.001) "got $($wf.data.periods[0].productiveHoursPerFte)"
Check 'required FTE derived correctly' ([math]::Abs([double]$wf.data.periods[0].requiredFte - 93.006) -lt 0.01) "got $($wf.data.periods[0].requiredFte)"
Check 'cost per contact reported' ($null -ne $wf.data.periods[0].costPerUnit) 'missing'

$wfRamp = PostJson '/planning/workforce' $t @{
  code='CS'; name='CS'; volumes=@(100000,100000); averageHandleTimeSeconds=300
  occupancy=0.8; shrinkage=0.3; hoursPerFtePerPeriod=160; costPerFtePerPeriod='5000.00'
  ramp=@{ leadTimePeriods=1; rampPeriods=1; rampProductivity=0.5 }
}
Check 'staffing ramp returned' ($null -ne $wfRamp.data.ramp) 'missing'
Check 'ramp needs more hires than the bare requirement' ([double]$wfRamp.data.ramp.periods[0].hiredFte -gt [double]$wfRamp.data.periods[0].requiredFte) 'no uplift'

try {
  PostJson '/planning/workforce' $t @{ code='X'; name='X'; volumes=@(1); averageHandleTimeSeconds=300; occupancy=0.8; shrinkage=1.5; costPerFtePerPeriod='1' } | Out-Null
  Check 'impossible shrinkage rejected' $false 'accepted'
} catch { Check 'impossible shrinkage rejected' ($_.Exception.Response.StatusCode.value__ -eq 400) "status $($_.Exception.Response.StatusCode.value__)" }

Write-Host "`n== Cost behaviour and contribution ==" -ForegroundColor Cyan
$lines = @(
  @{ key='a'; label='Access'; amount='400000'; spendCategory='ACCESS'; behaviour='VARIABLE' },
  @{ key='b'; label='Site power'; amount='300000'; spendCategory='FACILITIES'; behaviour='FIXED' },
  @{ key='c'; label='Field labour'; amount='200000'; spendCategory='LABOUR'; behaviour='SEMI_VARIABLE'; variableShare=0.6 }
)
$cb = PostJson '/planning/cost-behaviour' $t @{ lines = $lines }
# fixed 300,000 + 80,000 = 380,000 ; variable 400,000 + 120,000 = 520,000
Check 'fixed total correct' ($cb.data.totalFixed -eq '380000.0000') "got $($cb.data.totalFixed)"
Check 'variable total correct' ($cb.data.totalVariable -eq '520000.0000') "got $($cb.data.totalVariable)"
Check 'fixed + variable sum to total' ([math]::Abs(([double]$cb.data.totalFixed + [double]$cb.data.totalVariable) - [double]$cb.data.total) -lt 0.01) 'does not foot'

$contrib = PostJson '/planning/contribution' $t @{ revenue='1000000'; lines=$lines }
# contribution 480,000 -> margin 0.48 ; operating profit 100,000 ; leverage 4.8x
Check 'contribution correct' ($contrib.data.contribution -eq '480000.0000') "got $($contrib.data.contribution)"
Check 'contribution margin correct' ([math]::Abs($contrib.data.contributionMargin - 0.48) -lt 1e-9) "got $($contrib.data.contributionMargin)"
Check 'operating leverage correct' ([math]::Abs($contrib.data.operatingLeverage - 4.8) -lt 1e-6) "got $($contrib.data.operatingLeverage)"
Check 'break-even reported' ($null -ne $contrib.data.breakEvenRevenue) 'missing'

$flex = PostJson '/planning/flex-budget' $t @{ lines=$lines; budgetedVolume=1000; actualVolume=1200 }
# fixed 380,000 + variable 520,000 x 1.2 = 1,004,000
Check 'flexed budget flexes only the variable element' ($flex.data.flexedBudget -eq '1004000.0000') "got $($flex.data.flexedBudget)"

Write-Host "`n== Cost behaviour on a real budget ==" -ForegroundColor Cyan
$budgets = Invoke-RestMethod -Uri "$base/budgets?pageSize=5" -Headers (Bearer $finmgr.accessToken)
$budgetId = $budgets.data[0].id
$real = Invoke-RestMethod -Uri "$base/planning/budgets/$budgetId/cost-behaviour" -Headers (Bearer $finmgr.accessToken)
Check 'real budget classified' ($real.data.lines.Count -ge 1) "got $($real.data.lines.Count)"
Check 'fixed ratio computed from seeded classification' ($null -ne $real.data.fixedRatio) 'null'
Check 'classification inherited from accounts, not assumed' ($real.data.assumedLineCount -eq 0) "assumed $($real.data.assumedLineCount)"

Write-Host "`n== Planning bias ==" -ForegroundColor Cyan
$bias = Invoke-RestMethod -Uri "$base/planning/planning-bias?groupBy=BUSINESS_UNIT" -Headers (Bearer $finmgr.accessToken)
Check 'bias report returns subjects' ($bias.data.subjects.Count -ge 1) "got $($bias.data.subjects.Count)"
Check 'each subject carries a verdict' ($null -ne $bias.data.subjects[0].verdict) 'missing'
Check 'report explains itself' ($bias.data.observations.Count -ge 1) 'no observations'
Check 'observation count reported' ($bias.data.meta.observationCount -ge 1) "got $($bias.data.meta.observationCount)"

$biasAcct = Invoke-RestMethod -Uri "$base/planning/planning-bias?groupBy=ACCOUNT&minimumObservations=1" -Headers (Bearer $finmgr.accessToken)
Check 'bias by account works' ($biasAcct.data.subjects.Count -ge 1) "got $($biasAcct.data.subjects.Count)"
Check 'verdicts drawn from the defined set' (@('SYSTEMATIC_OVERSTATEMENT','SYSTEMATIC_UNDERSTATEMENT','INCONSISTENT','WELL_CALIBRATED','INSUFFICIENT_DATA') -contains $biasAcct.data.subjects[0].verdict) "got $($biasAcct.data.subjects[0].verdict)"

Write-Host "`n== Permissions ==" -ForegroundColor Cyan
$viewer = Login 'viewer@ffp.local' 'Viewer!Local26x'
try {
  PostJson '/planning/graph/evaluate' $viewer.accessToken $graph | Out-Null
  Check 'viewer cannot run a plan graph' $false 'was allowed'
} catch { Check 'viewer cannot run a plan graph' ($_.Exception.Response.StatusCode.value__ -eq 403) "status $($_.Exception.Response.StatusCode.value__)" }

Write-Host "`n=====================================" -ForegroundColor Cyan
Write-Host ("  PASSED: $pass    FAILED: $fail") -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "=====================================`n" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
