# Smoke test for rolling-forecast cadence and multi-year (MTP) planning.
#
#   pwsh ./scripts/smoke-test-rolling.ps1
#
# Creates its own cycles - one to close periods on, one for the MTP checks - so
# it is idempotent and can run repeatedly against the same database. It used to
# close periods on the seeded FY2026 cycle and went red once it had spent them.
#
# The period-closing fixture is parked in PLANNING at the end: it is OPEN with
# actuals while the suite runs, which is precisely what the dashboard looks for
# when it decides which cycle is the live one.

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
    catch { if ($_.Exception.Response.StatusCode.value__ -eq 429) { Start-Sleep -Seconds 15; continue }; throw }
  }
  throw "login kept hitting the rate limit"
}
function Bearer($t) { return @{ Authorization = "Bearer $t" } }
function Send($method, $path, $token, $obj) {
  $args = @{ Uri = "$base$path"; Method = $method; Headers = (Bearer $token); ContentType = 'application/json' }
  if ($null -ne $obj) { $args.Body = ($obj | ConvertTo-Json -Depth 12) } else { $args.Body = '{}' }
  return Invoke-RestMethod @args
}

$cfo    = Login 'cfo@ffp.local' 'Cfo!Local2026x'
$finmgr = Login 'finance.manager@ffp.local' 'FinMgr!Local26'
$viewer = Login 'viewer@ffp.local' 'Viewer!Local26x'
$stamp  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

# --------------------------------------------------------------------------
# This suite provisions its own annual cycle.
#
# It used to close periods on the *seeded* FY2026 cycle - two per run, with an
# `exit 1` once fewer than two remained. So it ran about three times after a
# reset and then went red for a reason that was not a defect. A suite that
# reports a failure nobody should act on is a suite people learn to ignore, and
# it cost real diagnostic time twice before it was fixed rather than documented
# again.
#
# Closing a period is destructive by design - that is the control working. The
# only durable fix is for the suite to spend a cycle of its own each run instead
# of the one everything else depends on.
# --------------------------------------------------------------------------
$fy = 2031
$fixture = Send 'Post' '/cycles' $finmgr.accessToken @{
  name = "Rolling smoke FY$fy $stamp"; fiscalYear = $fy; periodType = 'MONTH'; status = 'OPEN'
  opensAt = '2030-09-01T00:00:00Z'; submissionDeadline = '2030-10-31T00:00:00Z'
  approvalDeadline = '2030-11-30T00:00:00Z'; baseCurrency = 'USD'
}
$cycleId = $fixture.data.id
Check 'fixture cycle is created open' ($fixture.data.status -eq 'OPEN') "got $($fixture.data.status)"

function PeriodKeyOf($n) { return "FY$fy-P" + ([string]$n).PadLeft(2, '0') }

$units    = Invoke-RestMethod -Uri "$base/org/business-units" -Headers (Bearer $finmgr.accessToken)
$accounts = Invoke-RestMethod -Uri "$base/org/accounts" -Headers (Bearer $finmgr.accessToken)
$unitId   = ($units.data | Where-Object { $_.code -eq 'MOB' }).id
$acctId   = ($accounts.data | Where-Object { $_.code -eq '6000' }).id

Write-Host "`n== Rolling horizon configuration ==" -ForegroundColor Cyan
# Rolling a cycle with nothing closed is refused 409, not answered with an
# empty roll: a forecast anchored on nothing is worse than no forecast. Only
# reachable on a fresh cycle, so the old suite could not cover it at all.
#
# This assertion was written as 400 first, on the assumption that the missing
# rolling horizon would be the complaint. The API checks the closed-period
# anchor first and says so. Probe, then assert.
try {
  Send 'Post' "/cycles/$cycleId/roll" $finmgr.accessToken @{ method = 'NAIVE' } | Out-Null
  Check 'roll refused before any period is closed' $false 'was allowed'
} catch { Check 'roll refused before any period is closed' ($_.Exception.Response.StatusCode.value__ -eq 409) "status $($_.Exception.Response.StatusCode.value__)" }

$hz = Send 'Patch' "/cycles/$cycleId/horizon" $finmgr.accessToken @{ horizonYears = 1; rollingHorizonPeriods = 12 }
Check 'rolling horizon is configurable' ($hz.data.rollingHorizonPeriods -eq 12) "got $($hz.data.rollingHorizonPeriods)"

$rf0 = Invoke-RestMethod -Uri "$base/cycles/$cycleId/rolling-forecast" -Headers (Bearer $finmgr.accessToken)
Check 'cycle exposes a rolling horizon' ($rf0.data.cycle.rollingHorizonPeriods -ge 1) "got $($rf0.data.cycle.rollingHorizonPeriods)"
Check 'cycle reports its closed-period boundary' ($null -ne $rf0.data.cycle.actualsThroughPeriod) 'missing'

Write-Host "`n== Period closing ==" -ForegroundColor Cyan
# A roll needs two closed periods of history before it can forecast anything,
# so the fixture supplies three and closes through the second.
$firstClose  = 2
$secondClose = 3

# Actuals for every period that will be closed, plus the one before them: the
# forecaster skips a series with fewer than two closed points of history.
Send 'Post' '/variance/actuals/import' $finmgr.accessToken @{
  cycleId = $cycleId
  entries = @(
    @{ businessUnitId = $unitId; accountId = $acctId; periodKey = (PeriodKeyOf 1); amount = '1025000.0000' },
    @{ businessUnitId = $unitId; accountId = $acctId; periodKey = (PeriodKeyOf 2); amount = '1050000.0000' },
    @{ businessUnitId = $unitId; accountId = $acctId; periodKey = (PeriodKeyOf 3); amount = '1075000.0000' }
  )
} | Out-Null

# A viewer must not be able to close a period.
try {
  Send 'Post' "/cycles/$cycleId/close-period" $viewer.accessToken @{ throughPeriod = $firstClose } | Out-Null
  Check 'viewer cannot close a period' $false 'was allowed'
} catch { Check 'viewer cannot close a period' ($_.Exception.Response.StatusCode.value__ -eq 403) "status $($_.Exception.Response.StatusCode.value__)" }

$closed = Send 'Post' "/cycles/$cycleId/close-period" $finmgr.accessToken @{ throughPeriod = $firstClose }
Check "closes periods through P$firstClose" ($closed.data.closedThroughPeriod -eq $firstClose) "got $($closed.data.closedThroughPeriod)"
Check 'reports the closed period key' ($closed.data.closedPeriodKey -eq (PeriodKeyOf $firstClose)) "got $($closed.data.closedPeriodKey)"
Check 'reports how many actuals were locked' ($closed.data.actualsLocked -gt 0) "got $($closed.data.actualsLocked)"

# Reopening must be refused: forecasts and variance reports depend on the anchor.
try {
  Send 'Post' "/cycles/$cycleId/close-period" $finmgr.accessToken @{ throughPeriod = $firstClose } | Out-Null
  Check 'closed periods cannot be reopened' $false 'was allowed'
} catch { Check 'closed periods cannot be reopened' ($_.Exception.Response.StatusCode.value__ -eq 409) "status $($_.Exception.Response.StatusCode.value__)" }

Write-Host "`n== Closed periods are locked against restatement ==" -ForegroundColor Cyan
try {
  Send 'Post' '/variance/actuals/import' $finmgr.accessToken @{
    cycleId = $cycleId
    entries = @(@{ businessUnitId = $unitId; accountId = $acctId; periodKey = (PeriodKeyOf $firstClose); amount = '999.0000' })
  } | Out-Null
  Check 'cannot restate a closed period' $false 'import into closed period was allowed'
} catch { Check 'cannot restate a closed period' ($_.Exception.Response.StatusCode.value__ -eq 423) "status $($_.Exception.Response.StatusCode.value__)" }

# An open period must still accept actuals.
$open = Send 'Post' '/variance/actuals/import' $finmgr.accessToken @{
  cycleId = $cycleId
  entries = @(@{ businessUnitId = $unitId; accountId = $acctId; periodKey = (PeriodKeyOf 12); amount = '123456.0000' })
}
Check 'open periods still accept actuals' ($open.success -eq $true) 'rejected'

Write-Host "`n== Rolling the forecast ==" -ForegroundColor Cyan
$roll1 = Send 'Post' "/cycles/$cycleId/roll" $finmgr.accessToken @{ method = 'NAIVE' }
Check 'roll produces forecast series' ($roll1.data.seriesRolled -ge 1) "got $($roll1.data.seriesRolled)"
Check 'roll anchors on the closed period' ($roll1.data.anchorPeriodKey -eq (PeriodKeyOf $firstClose)) "got $($roll1.data.anchorPeriodKey)"
Check 'a generation is recorded' ($roll1.data.generation -ge 1) "got $($roll1.data.generation)"

$rf1 = Invoke-RestMethod -Uri "$base/cycles/$cycleId/rolling-forecast" -Headers (Bearer $finmgr.accessToken)
Check 'rolling forecast retrievable' ($rf1.data.series.Count -ge 1) "got $($rf1.data.series.Count)"
$first = $rf1.data.series[0]
Check 'series blends actuals and forecast' (($first.points | Where-Object { $_.basis -eq 'ACTUAL' }).Count -ge 1 -and ($first.points | Where-Object { $_.basis -eq 'FORECAST' }).Count -ge 1) 'not blended'
Check 'outturn = actuals to date + forecast remainder' ([math]::Abs(([double]$first.actualToDate + [double]$first.forecastRemainder) - [double]$first.fullYearOutturn) -lt 0.01) "$($first.actualToDate) + $($first.forecastRemainder) != $($first.fullYearOutturn)"
Check 'consolidated position reported' ($null -ne $rf1.data.consolidated.fullYearOutturn) 'missing'
Check 'no actual point carries a prediction interval' (($first.points | Where-Object { $_.basis -eq 'ACTUAL' -and $null -ne $_.lower }).Count -eq 0) 'actuals have intervals'

Write-Host "`n== Re-anchoring and scoring the superseded generation ==" -ForegroundColor Cyan
$rf1Before = $rf1.data.series.Count
Send 'Post' "/cycles/$cycleId/close-period" $finmgr.accessToken @{ throughPeriod = $secondClose } | Out-Null
$roll2 = Send 'Post' "/cycles/$cycleId/roll" $finmgr.accessToken @{ method = 'NAIVE' }
Check 'second roll re-anchors forward' ($roll2.data.anchorPeriodKey -eq (PeriodKeyOf $secondClose)) "got $($roll2.data.anchorPeriodKey)"
Check 'generation increments' ($roll2.data.generation -gt $roll1.data.generation) "$($roll1.data.generation) -> $($roll2.data.generation)"
Check 'prior generation was scored' ($roll2.data.scored -ge 1) "scored $($roll2.data.scored)"

$rf2 = Invoke-RestMethod -Uri "$base/cycles/$cycleId/rolling-forecast" -Headers (Bearer $finmgr.accessToken)
Check 'only the current generation is returned' ($rf2.data.series.Count -eq $rf1Before) "got $($rf2.data.series.Count), expected $rf1Before"
Check 'superseded generations retained for audit' (((Invoke-RestMethod -Uri "$base/cycles/$cycleId/rolling-forecast?includeSuperseded=true" -Headers (Bearer $finmgr.accessToken)).data.series.Count) -gt $rf2.data.series.Count) 'not retained'

$acc = Invoke-RestMethod -Uri "$base/cycles/$cycleId/forecast-accuracy" -Headers (Bearer $finmgr.accessToken)
Check 'forecast accuracy reviews produced' ($acc.data.summary.generationsScored -ge 1) "got $($acc.data.summary.generationsScored)"
Check 'accuracy carries an interpretation' ($acc.data.summary.interpretation.Length -gt 20) 'missing'
Check 'verdict from the defined set' (@('ACCURATE','ACCEPTABLE','POOR') -contains $acc.data.reviews[0].review.verdict) "got $($acc.data.reviews[0].review.verdict)"

Write-Host "`n== Multi-year (MTP) ==" -ForegroundColor Cyan
$mtpBody = @{
  name = "MTP FY2030-32 $stamp"; fiscalYear = 2030; periodType = 'MONTH'; status = 'PLANNING'
  opensAt = '2029-09-01T00:00:00Z'; submissionDeadline = '2029-10-31T00:00:00Z'
  approvalDeadline = '2029-11-30T00:00:00Z'; baseCurrency = 'USD'
}
$mtp = Send 'Post' '/cycles' $finmgr.accessToken $mtpBody
$mtpId = $mtp.data.id
Check 'cycle created as single-year by default' ($mtp.data.horizonYears -eq 1) "got $($mtp.data.horizonYears)"

$horizon = Send 'Patch' "/cycles/$mtpId/horizon" $finmgr.accessToken @{ horizonYears = 3; rollingHorizonPeriods = 18 }
Check 'horizon extended to 3 years' ($horizon.data.horizonYears -eq 3) "got $($horizon.data.horizonYears)"
Check 'expected periods scales with the horizon' ($horizon.data.expectedPeriods -eq 36) "got $($horizon.data.expectedPeriods)"

# A budget on an MTP cycle must supply an amount for all 36 periods.
$amounts12 = @(); 1..12 | ForEach-Object { $amounts12 += '1000.0000' }
try {
  Send 'Post' '/budgets' $finmgr.accessToken @{
    cycleId = $mtpId; businessUnitId = $unitId; name = "Too short $stamp"; currency = 'USD'
    lines = @(@{ accountId = $acctId; method = 'ZERO_BASED'; periodAmounts = $amounts12; alignment = 'DIRECT' })
  } | Out-Null
  Check 'MTP rejects a 12-period budget line' $false 'accepted'
} catch { Check 'MTP rejects a 12-period budget line' ($_.Exception.Response.StatusCode.value__ -eq 400) "status $($_.Exception.Response.StatusCode.value__)" }

$amounts36 = @(); 1..36 | ForEach-Object { $amounts36 += '1000.0000' }
$mtpBudget = Send 'Post' '/budgets' $finmgr.accessToken @{
  cycleId = $mtpId; businessUnitId = $unitId; name = "MTP budget $stamp"; currency = 'USD'
  lines = @(@{ accountId = $acctId; method = 'ZERO_BASED'; periodAmounts = $amounts36; alignment = 'DIRECT' })
}
Check 'MTP accepts a 36-period budget line' ($null -ne $mtpBudget.data.id) 'rejected'

$view = Invoke-RestMethod -Uri "$base/cycles/$mtpId/mtp" -Headers (Bearer $finmgr.accessToken)
Check 'MTP view flags a multi-year plan' ($view.data.cycle.isMediumTermPlan -eq $true) 'not flagged'
Check 'MTP collapses to three fiscal years' ($view.data.byFiscalYear.Count -eq 3) "got $($view.data.byFiscalYear.Count)"
Check 'each year totals 12,000' ([math]::Abs([double]$view.data.byFiscalYear[0].total - 12000) -lt 0.01) "got $($view.data.byFiscalYear[0].total)"
Check 'first year has no prior-year growth' ($null -eq $view.data.byFiscalYear[0].growthOnPriorYear) "got $($view.data.byFiscalYear[0].growthOnPriorYear)"
Check 'flat plan shows zero growth in later years' ([math]::Abs($view.data.byFiscalYear[1].growthOnPriorYear) -lt 1e-9) "got $($view.data.byFiscalYear[1].growthOnPriorYear)"
Check 'fiscal years are consecutive' ($view.data.byFiscalYear[0].fiscalYear -eq 2030 -and $view.data.byFiscalYear[2].fiscalYear -eq 2032) "got $($view.data.byFiscalYear[0].fiscalYear)..$($view.data.byFiscalYear[2].fiscalYear)"

# The horizon must not be shortened underneath existing budgets.
try {
  Send 'Patch' "/cycles/$mtpId/horizon" $finmgr.accessToken @{ horizonYears = 1 } | Out-Null
  Check 'horizon cannot be shortened under existing budgets' $false 'was allowed'
} catch { Check 'horizon cannot be shortened under existing budgets' ($_.Exception.Response.StatusCode.value__ -eq 409) "status $($_.Exception.Response.StatusCode.value__)" }

Write-Host "`n== Governance ==" -ForegroundColor Cyan
$audit = Invoke-RestMethod -Uri "$base/governance/audit?pageSize=40" -Headers (Bearer $finmgr.accessToken)
Check 'period closing is audited' (($audit.data | Where-Object { $_.summary -match 'Closed periods through' }).Count -ge 1) 'not audited'
Check 'rolling is audited' (($audit.data | Where-Object { $_.summary -match 'Rolled the forecast' }).Count -ge 1) 'not audited'
$verify = Send 'Post' '/governance/audit/verify' $cfo.accessToken $null
Check 'audit chain still intact after all of this' ($verify.data.valid -eq $true) "reason: $($verify.data.reason)"

Write-Host "`n== Housekeeping ==" -ForegroundColor Cyan
# Park the fixture out of the states that mean "in execution".
#
# GET /reports/dashboard answers "where are we now?" by taking the newest
# OPEN or CONSOLIDATING cycle *that has actuals* - deliberately, so that next
# year's empty cycle does not displace the live one. This fixture is OPEN,
# has actuals and sits years in the future, so it satisfies that test better
# than the real cycle does and the dashboard starts reporting a test fixture:
# 3.27m of spend against a budget of zero. journey-operations caught it as an
# implausible headline figure, which is exactly its job.
#
# CLOSED would be the faithful end of a cycle's life, but closing is refused
# while budgets are in flight and this suite leaves some there on purpose.
# PLANNING is reachable, carries no preconditions, and is honest: a fixture
# is not a cycle anyone is executing.
$park = Send 'Patch' "/cycles/$cycleId/status" $finmgr.accessToken @{ status = 'PLANNING' }
Check 'fixture cycle is parked so it cannot pose as the live cycle' ($park.data.status -eq 'PLANNING') "got $($park.data.status)"

Write-Host "`n=====================================" -ForegroundColor Cyan
Write-Host ("  PASSED: $pass    FAILED: $fail") -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "=====================================`n" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
