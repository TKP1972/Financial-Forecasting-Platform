$ErrorActionPreference = 'Stop'
$base = 'http://localhost:4000/api/v1'
$pass = 0; $fail = 0

function Check($name, $cond, $detail) {
  if ($cond) { $script:pass++; Write-Host ("  PASS  " + $name) -ForegroundColor Green }
  else { $script:fail++; Write-Host ("  FAIL  " + $name + "  -> " + $detail) -ForegroundColor Red }
}

# The login endpoint is deliberately rate-limited to 10/minute. Repeated smoke
# runs trip it, so back off and retry rather than reporting a false failure.
function Login($email, $password) {
  $body = @{ email = $email; password = $password } | ConvertTo-Json
  for ($attempt = 0; $attempt -lt 6; $attempt++) {
    try {
      return Invoke-RestMethod -Uri "$base/auth/login" -Method Post -Body $body -ContentType 'application/json'
    } catch {
      if ($_.Exception.Response.StatusCode.value__ -eq 429) {
        Write-Host "  ..  login rate-limited, waiting 15s" -ForegroundColor DarkGray
        Start-Sleep -Seconds 15
        continue
      }
      throw
    }
  }
  throw "login for $email kept hitting the rate limit"
}

function Bearer($token) { return @{ Authorization = "Bearer $token" } }

Write-Host "`n== Authentication ==" -ForegroundColor Cyan
$admin = Login 'admin@ffp.local' 'Adm1n!Local2026'
Check 'admin login returns access token' ($admin.accessToken.Length -gt 20) 'no token'
Check 'admin carries user:manage permission' ($admin.user.permissions -contains 'user:manage') 'missing'

$analyst = Login 'analyst@ffp.local' 'Analyst!Local26'
Check 'analyst login' ($analyst.accessToken.Length -gt 20) 'no token'
Check 'analyst LACKS budget:approve' (-not ($analyst.user.permissions -contains 'budget:approve')) 'analyst should not approve'

$cfo = Login 'cfo@ffp.local' 'Cfo!Local2026x'
$finmgr = Login 'finance.manager@ffp.local' 'FinMgr!Local26'
$owner = Login 'owner.mobile@ffp.local' 'Owner!Local26x'
Check 'finance manager HAS budget:approve' ($finmgr.user.permissions -contains 'budget:approve') 'missing'
Check 'finance manager LACKS budget:lock' (-not ($finmgr.user.permissions -contains 'budget:lock')) 'should not lock'
Check 'CFO HAS budget:lock' ($cfo.user.permissions -contains 'budget:lock') 'missing'

try { Login 'admin@ffp.local' 'wrong-password' | Out-Null; Check 'bad password rejected' $false 'accepted' }
catch { Check 'bad password rejected' ($_.Exception.Response.StatusCode.value__ -eq 401) "status $($_.Exception.Response.StatusCode.value__)" }

Write-Host "`n== Reference data ==" -ForegroundColor Cyan
$units = Invoke-RestMethod -Uri "$base/org/business-units" -Headers (Bearer $admin.accessToken)
Check 'business units returned' ($units.data.Count -ge 5) "got $($units.data.Count)"
$tree = Invoke-RestMethod -Uri "$base/org/business-units/tree" -Headers (Bearer $admin.accessToken)
Check 'unit hierarchy has a single root' ($tree.data.Count -eq 1) "roots $($tree.data.Count)"
Check 'root has children' ($tree.data[0].children.Count -eq 4) "children $($tree.data[0].children.Count)"

$accounts = Invoke-RestMethod -Uri "$base/org/accounts" -Headers (Bearer $admin.accessToken)
Check 'chart of accounts returned' ($accounts.data.Count -ge 14) "got $($accounts.data.Count)"

Write-Host "`n== Budget cycle and guideline pack ==" -ForegroundColor Cyan
$cycles = Invoke-RestMethod -Uri "$base/cycles" -Headers (Bearer $admin.accessToken)
Check 'cycle exists' ($cycles.data.Count -ge 1) 'none'
# Select the seeded FY2026 cycle by year rather than taking the first row: other
# suites create their own cycles, and ordering is by fiscal year descending.
$seeded = $cycles.data | Where-Object { $_.fiscalYear -eq 2026 } | Select-Object -First 1
if (-not $seeded) { $seeded = $cycles.data[0] }
$cycleId = $seeded.id
$pack = Invoke-RestMethod -Uri "$base/cycles/$cycleId/guidance-pack" -Headers (Bearer $admin.accessToken)
Check 'guidance pack has assumptions' ($pack.data.assumptions.Count -ge 7) "got $($pack.data.assumptions.Count)"
Check 'assumptions render as percentages' ($pack.data.assumptions[0].displayValue -match '%|\$') "got '$($pack.data.assumptions[0].displayValue)'"
Check 'pack has a 12-period calendar' ($pack.data.calendar.Count -eq 12) "got $($pack.data.calendar.Count)"
Check 'pack lists strategic objectives' ($pack.data.objectives.Count -eq 4) "got $($pack.data.objectives.Count)"

$md = Invoke-WebRequest -Uri "$base/cycles/$cycleId/guidance-pack.md" -Headers (Bearer $admin.accessToken) -UseBasicParsing
Check 'markdown pack renders' ($md.Content -match '# FY2026 Budget Plan') 'no heading'
Check 'markdown pack documents separation of duties' ($md.Content -match 'Separation of duties') 'missing'

Write-Host "`n== Budget workflow and governance ==" -ForegroundColor Cyan
$budgets = Invoke-RestMethod -Uri "$base/budgets?pageSize=50" -Headers (Bearer $finmgr.accessToken)
Check 'budgets listed' ($budgets.data.Count -ge 4) "got $($budgets.data.Count)"

# Create budgets for this run rather than mutating seeded state, so the smoke
# test is idempotent and each governance control gets a purpose-built case.
$sharedUnitId = ($units.data | Where-Object { $_.code -eq 'SHR' }).id
$opexAccountId = ($accounts.data | Where-Object { $_.code -eq '6300' }).id
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

function New-Budget($token, $name, $perPeriod) {
  $amounts = @(); 1..12 | ForEach-Object { $amounts += $perPeriod }
  $body = @{
    cycleId = $cycleId; businessUnitId = $sharedUnitId; name = $name; currency = 'USD'
    lines = @(@{
      accountId = $opexAccountId; method = 'ZERO_BASED'; description = 'Smoke test line'
      periodAmounts = $amounts; alignment = 'DIRECT'
    })
  } | ConvertTo-Json -Depth 6
  return Invoke-RestMethod -Uri "$base/budgets" -Method Post -Body $body -ContentType 'application/json' -Headers (Bearer $token)
}

function Move-Budget($token, $id, $to) {
  $body = @{ to = $to } | ConvertTo-Json
  return Invoke-RestMethod -Uri "$base/budgets/$id/transition" -Method Post -Body $body -ContentType 'application/json' -Headers (Bearer $token)
}

# Realistic three-person flow: analyst prepares, budget owner submits, finance
# manager approves. Each step is a different role, which is the point.
$small = New-Budget $analyst.accessToken "Smoke small $stamp" '10000.0000'
Check 'analyst can create a budget' ($null -ne $small.data.id) 'not created'

# A separate budget left in DRAFT, purely to exercise the illegal-transition guard.
$draft = (New-Budget $analyst.accessToken "Smoke draft $stamp" '1000.0000').data

Move-Budget $analyst.accessToken $small.data.id 'IN_REVIEW' | Out-Null

# An analyst may prepare but not submit - that needs a budget owner.
try {
  Move-Budget $analyst.accessToken $small.data.id 'SUBMITTED' | Out-Null
  Check 'analyst cannot submit' $false 'was allowed'
} catch {
  Check 'analyst cannot submit' ($_.Exception.Response.StatusCode.value__ -eq 403) "status $($_.Exception.Response.StatusCode.value__)"
}

$sub = Move-Budget $owner.accessToken $small.data.id 'SUBMITTED'
Check 'budget owner submits the budget' ($sub.data.status -eq 'SUBMITTED') "status $($sub.data.status)"
$submitted = @{ id = $small.data.id }

# Illegal transition: DRAFT cannot jump straight to APPROVED
try {
  $b = @{ to = 'APPROVED' } | ConvertTo-Json
  Invoke-RestMethod -Uri "$base/budgets/$($draft.id)/transition" -Method Post -Body $b -ContentType 'application/json' -Headers (Bearer $finmgr.accessToken) | Out-Null
  Check 'illegal DRAFT->APPROVED refused' $false 'was allowed'
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Check 'illegal DRAFT->APPROVED refused' ($code -eq 409) "status $code"
}

# Analyst cannot approve a submitted budget (role gate)
try {
  $b = @{ to = 'APPROVED' } | ConvertTo-Json
  Invoke-RestMethod -Uri "$base/budgets/$($submitted.id)/transition" -Method Post -Body $b -ContentType 'application/json' -Headers (Bearer $analyst.accessToken) | Out-Null
  Check 'analyst cannot approve' $false 'was allowed'
} catch {
  Check 'analyst cannot approve' ($_.Exception.Response.StatusCode.value__ -eq 403) "status $($_.Exception.Response.StatusCode.value__)"
}

# Finance manager cannot LOCK regardless of amount (role gate). LOCKED is not
# even reachable from SUBMITTED, so either 403 or 409 is a correct refusal.
try {
  $b = @{ to = 'LOCKED' } | ConvertTo-Json
  Invoke-RestMethod -Uri "$base/budgets/$($submitted.id)/transition" -Method Post -Body $b -ContentType 'application/json' -Headers (Bearer $finmgr.accessToken) | Out-Null
  Check 'finance manager cannot lock' $false 'was allowed'
} catch {
  Check 'finance manager cannot lock' ($_.Exception.Response.StatusCode.value__ -eq 409 -or $_.Exception.Response.StatusCode.value__ -eq 403) "status $($_.Exception.Response.StatusCode.value__)"
}

# 120,000 total is inside the finance manager's 2,000,000 limit, and they did
# not prepare or submit it, so this approval is legitimate.
$b = @{ to = 'APPROVED'; comment = 'Approved within delegated authority' } | ConvertTo-Json
$approved = Invoke-RestMethod -Uri "$base/budgets/$($submitted.id)/transition" -Method Post -Body $b -ContentType 'application/json' -Headers (Bearer $finmgr.accessToken)
Check 'finance manager approves within authority' ($approved.data.status -eq 'APPROVED') "status $($approved.data.status)"

# --- Separation of duties: prepare AND approve as the same person ---
$own = New-Budget $cfo.accessToken "Smoke self-approve $stamp" '5000.0000'
Move-Budget $cfo.accessToken $own.data.id 'IN_REVIEW' | Out-Null
Move-Budget $cfo.accessToken $own.data.id 'SUBMITTED' | Out-Null
try {
  Move-Budget $cfo.accessToken $own.data.id 'APPROVED' | Out-Null
  Check 'separation of duties blocks self-approval (even for CFO)' $false 'self-approval allowed'
} catch {
  Check 'separation of duties blocks self-approval (even for CFO)' ($_.Exception.Response.StatusCode.value__ -eq 403) "status $($_.Exception.Response.StatusCode.value__)"
}

# --- Delegated authority: an amount above the finance manager's limit ---
$big = New-Budget $analyst.accessToken "Smoke oversized $stamp" '500000.0000'   # 6,000,000 total
Move-Budget $analyst.accessToken $big.data.id 'IN_REVIEW' | Out-Null
Move-Budget $owner.accessToken $big.data.id 'SUBMITTED' | Out-Null
try {
  Move-Budget $finmgr.accessToken $big.data.id 'APPROVED' | Out-Null
  Check 'delegated authority limit enforced' $false 'approval above limit was allowed'
} catch {
  Check 'delegated authority limit enforced' ($_.Exception.Response.StatusCode.value__ -eq 403) "status $($_.Exception.Response.StatusCode.value__)"
}
# The CFO has no limit and did not prepare it, so the escalation succeeds.
$escalated = Move-Budget $cfo.accessToken $big.data.id 'APPROVED'
Check 'escalation to CFO clears the limit' ($escalated.data.status -eq 'APPROVED') "status $($escalated.data.status)"

# CFO locks the approved baseline; it then becomes terminal.
$b = @{ to = 'LOCKED'; comment = 'Baseline locked' } | ConvertTo-Json
$locked = Invoke-RestMethod -Uri "$base/budgets/$($submitted.id)/transition" -Method Post -Body $b -ContentType 'application/json' -Headers (Bearer $cfo.accessToken)
Check 'CFO locks the budget' ($locked.data.status -eq 'LOCKED') "status $($locked.data.status)"

try {
  $b = @{ to = 'IN_REVIEW' } | ConvertTo-Json
  Invoke-RestMethod -Uri "$base/budgets/$($submitted.id)/transition" -Method Post -Body $b -ContentType 'application/json' -Headers (Bearer $cfo.accessToken) | Out-Null
  Check 'LOCKED is terminal' $false 'reopened'
} catch {
  Check 'LOCKED is terminal' ($_.Exception.Response.StatusCode.value__ -eq 409) "status $($_.Exception.Response.StatusCode.value__)"
}

$detail = Invoke-RestMethod -Uri "$base/budgets/$($submitted.id)" -Headers (Bearer $cfo.accessToken)
Check 'version snapshots recorded' ($detail.data.versions.Count -ge 3) "got $($detail.data.versions.Count)"
Check 'approval records written' ($detail.data.approvals.Count -ge 1) "got $($detail.data.approvals.Count)"

Write-Host "`n== Strategic alignment ==" -ForegroundColor Cyan
$align = Invoke-RestMethod -Uri "$base/budgets/$($submitted.id)/alignment" -Headers (Bearer $finmgr.accessToken)
Check 'alignment score in [0,1]' ($align.data.alignmentScore -ge 0 -and $align.data.alignmentScore -le 1) "score $($align.data.alignmentScore)"
Check 'alignment covers all 3 horizons' ($align.data.byHorizon.Count -eq 3) "got $($align.data.byHorizon.Count)"

Write-Host "`n== Forecasting ==" -ForegroundColor Cyan
# Pick a unit and a COST account that actually carry seeded actuals.
$mobileId = ($units.data | Where-Object { $_.code -eq 'MOB' }).id
$salariesId = ($accounts.data | Where-Object { $_.code -eq '6000' }).id
$hist = Invoke-RestMethod -Uri "$base/forecasts/history?businessUnitId=$mobileId&accountId=$salariesId" -Headers (Bearer $analyst.accessToken)
Check 'actuals history retrievable for forecasting' ($hist.data.Count -ge 24) "got $($hist.data.Count) points"
$fc = @{ method = 'AUTO'; horizon = 6; seasonLength = 12; history = $hist.data } | ConvertTo-Json -Depth 6
$forecast = Invoke-RestMethod -Uri "$base/forecasts/run" -Method Post -Body $fc -ContentType 'application/json' -Headers (Bearer $analyst.accessToken)
Check 'AUTO forecast returns points' ($forecast.data.point.Count -eq 6) "got $($forecast.data.point.Count)"
Check 'forecast produced a prediction interval' ($null -ne $forecast.data.interval) 'none'
Check 'forecast reports backtest candidates' ($forecast.data.candidates.Count -ge 3) "got $($forecast.data.candidates.Count)"
Check 'forecast labels future periods' ($forecast.data.periodKeys.Count -eq 6) "got $($forecast.data.periodKeys.Count)"
Check 'candidates sorted best-first' ($forecast.data.candidates[0].score -le $forecast.data.candidates[1].score) 'unsorted'

Write-Host "`n== Pricing ==" -ForegroundColor Cyan
$pursuits = Invoke-RestMethod -Uri "$base/pricing/pursuits" -Headers (Bearer $analyst.accessToken)
Check 'pursuit seeded' ($pursuits.data.Count -ge 1) 'none'
Check 'pursuit has a priced model' ($null -ne $pursuits.data[0].latestPrice) 'no price'

# Margin redaction: analyst lacks pricing:view_margin
$model = @{
  name = 'Smoke model'; contractType = 'FIRM_FIXED_PRICE'; years = 1
  labour = @(@{ labourCategory = 'Engineer'; hoursByYear = @(1000); baseRate = '100.00' })
  directCosts = @(); burdens = @(@{ pool = 'FRINGE'; ratesByYear = @('0.30') }); feeRate = '0.10'
} | ConvertTo-Json -Depth 6
$asAnalyst = Invoke-RestMethod -Uri "$base/pricing/calculate" -Method Post -Body $model -ContentType 'application/json' -Headers (Bearer $analyst.accessToken)
Check 'analyst sees cost but not margin' ($null -eq $asAnalyst.data.margin.grossMargin) "margin leaked: $($asAnalyst.data.margin.grossMargin)"
Check 'analyst still sees total price' ($asAnalyst.data.totals.price -ne $null) 'no price'

$asMgr = Invoke-RestMethod -Uri "$base/pricing/calculate" -Method Post -Body $model -ContentType 'application/json' -Headers (Bearer $finmgr.accessToken)
Check 'finance manager sees margin' ($null -ne $asMgr.data.margin.grossMargin) 'redacted'
# 1000h x 100 = 100000 labour; fringe 30% = 30000; cost 130000; fee 10% = 13000; price 143000
Check 'pricing arithmetic exact' ($asMgr.data.totals.price -eq '143000.0000') "got $($asMgr.data.totals.price)"
Check 'burden base correct' ($asMgr.data.years[0].totalBurden -eq '30000.0000') "got $($asMgr.data.years[0].totalBurden)"

$ptw = @{ model = ($model | ConvertFrom-Json); target = @{ kind = 'MARGIN'; value = '0.25' } } | ConvertTo-Json -Depth 8
$solved = Invoke-RestMethod -Uri "$base/pricing/price-to-win" -Method Post -Body $ptw -ContentType 'application/json' -Headers (Bearer $finmgr.accessToken)
Check 'price-to-win converged' ($solved.data.converged -eq $true) 'did not converge'
Check 'price-to-win hits 25% margin' ([math]::Abs($solved.data.result.margin.grossMargin - 0.25) -lt 1e-6) "got $($solved.data.result.margin.grossMargin)"

Write-Host "`n== Risk and Monte Carlo ==" -ForegroundColor Cyan
$reg = Invoke-RestMethod -Uri "$base/risk/register" -Headers (Bearer $analyst.accessToken)
Check 'risk register scored' ($reg.data.risks.Count -ge 7) "got $($reg.data.risks.Count)"
Check 'heat map is 5x5' ($reg.data.heatMap.Count -eq 5) "got $($reg.data.heatMap.Count)"
Check 'escalations identified' ($reg.data.escalations.Count -ge 1) 'none'
Check 'mitigation reduces exposure' ([double]$reg.data.totalResidualExposure -lt [double]$reg.data.totalInherentExposure) 'residual not lower'

$sim = @{
  name = 'Smoke simulation'; iterations = 10000; seed = 42; baseValue = '1000000'
  inputs = @(
    @{ code = 'energy'; label = 'Energy cost'; distribution = 'PERT'; min = 80000; mode = 120000; max = 260000 },
    @{ code = 'labour'; label = 'Labour overrun'; distribution = 'TRIANGULAR'; min = 0; mode = 40000; max = 90000 }
  )
  confidenceLevels = @(0.1, 0.5, 0.8, 0.9)
} | ConvertTo-Json -Depth 6
$s1 = Invoke-RestMethod -Uri "$base/risk/simulate" -Method Post -Body $sim -ContentType 'application/json' -Headers (Bearer $analyst.accessToken)
$s2 = Invoke-RestMethod -Uri "$base/risk/simulate" -Method Post -Body $sim -ContentType 'application/json' -Headers (Bearer $analyst.accessToken)
Check 'simulation is reproducible for a fixed seed' ($s1.data.mean -eq $s2.data.mean -and $s1.data.contingency -eq $s2.data.contingency) "means $($s1.data.mean) vs $($s2.data.mean)"
Check 'percentiles monotonic' ([double]$s1.data.percentiles[0].value -le [double]$s1.data.percentiles[3].value) 'not monotonic'
Check 'sensitivity ranks inputs' ($s1.data.sensitivity.Count -eq 2) "got $($s1.data.sensitivity.Count)"
Check 'histogram sums to iterations' ((($s1.data.histogram | Measure-Object -Property count -Sum).Sum) -eq 10000) 'bad histogram'

Write-Host "`n== Variance and projection ==" -ForegroundColor Cyan
$var = Invoke-RestMethod -Uri "$base/variance/report?cycleId=$cycleId&throughPeriod=7&groupBy=BUSINESS_UNIT" -Headers (Bearer $finmgr.accessToken)
Check 'variance report has lines' ($var.data.lines.Count -ge 1) "got $($var.data.lines.Count)"
Check 'variance grouped' ($var.data.groups.Count -ge 1) 'no groups'
Check 'exceptions surfaced' ($null -ne $var.data.exceptions) 'missing'

$proj = Invoke-RestMethod -Uri "$base/variance/projection?cycleId=$cycleId&periodsElapsed=7&basis=RUN_RATE" -Headers (Bearer $finmgr.accessToken)
Check 'outturn projection produced' ($proj.data.lines.Count -ge 1) "got $($proj.data.lines.Count)"
Check 'projection states its basis' ($proj.data.meta.basisExplanation.Length -gt 20) 'no explanation'

$dec = @{ lines = @(@{ label='Field hours'; budgetVolume='100'; budgetPrice='10'; actualVolume='120'; actualPrice='11' }) } | ConvertTo-Json -Depth 5
$d = Invoke-RestMethod -Uri "$base/variance/decompose" -Method Post -Body $dec -ContentType 'application/json' -Headers (Bearer $finmgr.accessToken)
# total 1320-1000=320; volume=20*10=200; price=1*100=100; joint=20*1=20
Check 'price/volume/joint decomposition exact' ($d.data.lines[0].volumeVariance -eq '200.0000' -and $d.data.lines[0].priceVariance -eq '100.0000' -and $d.data.lines[0].jointVariance -eq '20.0000') "got $($d.data.lines[0].volumeVariance)/$($d.data.lines[0].priceVariance)/$($d.data.lines[0].jointVariance)"

Write-Host "`n== Reporting ==" -ForegroundColor Cyan
$dash = Invoke-RestMethod -Uri "$base/reports/dashboard?cycleId=$cycleId" -Headers (Bearer $finmgr.accessToken)
Check 'dashboard returns cycle' ($null -ne $dash.data.cycle) 'none'
Check 'dashboard reports expenditure' ($null -ne $dash.data.expenditure.consumed) 'missing'
Check 'dashboard reports risk exposure' ($null -ne $dash.data.risk.totalExposure) 'missing'

$xlsx = Invoke-WebRequest -Uri "$base/reports/leadership-pack.xlsx?cycleId=$cycleId&throughPeriod=7" -Headers (Bearer $finmgr.accessToken) -UseBasicParsing
Check 'xlsx export returns a workbook' ($xlsx.Content.Length -gt 5000) "size $($xlsx.Content.Length)"
Check 'xlsx has spreadsheet content type' ($xlsx.Headers['Content-Type'] -match 'spreadsheetml') "got $($xlsx.Headers['Content-Type'])"

Write-Host "`n== Audit trail ==" -ForegroundColor Cyan
$audit = Invoke-RestMethod -Uri "$base/governance/audit?pageSize=10" -Headers (Bearer $finmgr.accessToken)
Check 'audit entries recorded' ($audit.data.Count -ge 5) "got $($audit.data.Count)"
Check 'audit entries carry hashes' ($audit.data[0].hash.Length -eq 64) "len $($audit.data[0].hash.Length)"
Check 'audit entries chain' ($audit.data[0].previousHash.Length -eq 64) 'no previousHash'

try {
  Invoke-RestMethod -Uri "$base/governance/audit/verify" -Method Post -Headers (Bearer $finmgr.accessToken) | Out-Null
  Check 'finance manager cannot verify chain' $false 'was allowed'
} catch {
  Check 'finance manager cannot verify chain' ($_.Exception.Response.StatusCode.value__ -eq 403) "status $($_.Exception.Response.StatusCode.value__)"
}

$verify = Invoke-RestMethod -Uri "$base/governance/audit/verify" -Method Post -Headers (Bearer $cfo.accessToken)
Check 'audit chain verifies intact' ($verify.data.valid -eq $true) "reason: $($verify.data.reason)"
Check 'chain verification checked all entries' ($verify.data.entriesChecked -ge 5) "checked $($verify.data.entriesChecked)"

$controls = Invoke-RestMethod -Uri "$base/governance/controls" -Headers (Bearer $cfo.accessToken)
Check 'control register exposed' ($controls.data.controls.Count -eq 5) "got $($controls.data.controls.Count)"

Write-Host "`n== Session handling ==" -ForegroundColor Cyan
$refreshBody = @{ refreshToken = $analyst.refreshToken } | ConvertTo-Json
$refreshed = Invoke-RestMethod -Uri "$base/auth/refresh" -Method Post -Body $refreshBody -ContentType 'application/json'
Check 'refresh issues a new token pair' ($refreshed.refreshToken -ne $analyst.refreshToken) 'token not rotated'
try {
  Invoke-RestMethod -Uri "$base/auth/refresh" -Method Post -Body $refreshBody -ContentType 'application/json' | Out-Null
  Check 'replayed refresh token rejected' $false 'replay accepted'
} catch {
  Check 'replayed refresh token rejected' ($_.Exception.Response.StatusCode.value__ -eq 401) "status $($_.Exception.Response.StatusCode.value__)"
}

try {
  Invoke-RestMethod -Uri "$base/budgets" | Out-Null
  Check 'unauthenticated request rejected' $false 'allowed'
} catch {
  Check 'unauthenticated request rejected' ($_.Exception.Response.StatusCode.value__ -eq 401) "status $($_.Exception.Response.StatusCode.value__)"
}

Write-Host "`n=====================================" -ForegroundColor Cyan
Write-Host ("  PASSED: $pass    FAILED: $fail") -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "=====================================`n" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
