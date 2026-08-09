# Smoke test for effective-dated rate cards and pricing driven from them.
#
#   pwsh ./scripts/smoke-test-ratecards.ps1

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
  $a = @{ Uri = "$base$path"; Method = $method; Headers = (Bearer $token); ContentType = 'application/json' }
  if ($null -ne $obj) { $a.Body = ($obj | ConvertTo-Json -Depth 12) } else { $a.Body = '{}' }
  return Invoke-RestMethod @a
}

$finmgr  = Login 'finance.manager@ffp.local' 'FinMgr!Local26'
$analyst = Login 'analyst@ffp.local' 'Analyst!Local26'
$viewer  = Login 'viewer@ffp.local' 'Viewer!Local26x'
$stamp   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$t = $finmgr.accessToken

Write-Host "`n== Seeded card ==" -ForegroundColor Cyan
$cards = Invoke-RestMethod -Uri "$base/pricing/rate-cards" -Headers (Bearer $t)
# @() forces an array: PowerShell unwraps a single-element pipeline result, and
# .Count on a bare PSCustomObject is not what you expect.
$std = @($cards.data | Where-Object { $_.code -eq 'STD-DELIVERY' })
Check 'seeded rate card listed' ($std.Count -eq 1) "got $($std.Count)"
$cardId = $std[0].id

$card = Invoke-RestMethod -Uri "$base/pricing/rate-cards/$cardId" -Headers (Bearer $t)
Check 'card has entries' ($card.data.entries.Count -ge 20) "got $($card.data.entries.Count)"
Check 'seeded card is internally consistent' ($card.data.validation.valid -eq $true) "issues: $($card.data.validation.issues.Count)"
Check 'dimensions enumerated for the UI' ($card.data.dimensions.locations -contains 'Lagos' -and $card.data.dimensions.channels -contains 'Onsite') 'missing dimensions'

Write-Host "`n== Resolution and fallback ==" -ForegroundColor Cyan
# Network Engineer base 68.50; Lagos is 82% of that = 56.17
$def = Invoke-RestMethod -Uri "$base/pricing/rate-cards/$cardId/resolve?labourCategory=Network%20Engineer&asOf=2026-06-01" -Headers (Bearer $t)
Check 'resolves the unqualified default' ([math]::Abs([double]$def.data.rate - 68.50) -lt 0.001) "got $($def.data.rate)"
Check 'default match reports zero specificity' ($def.data.specificity -eq 0) "got $($def.data.specificity)"

$lagos = Invoke-RestMethod -Uri "$base/pricing/rate-cards/$cardId/resolve?labourCategory=Network%20Engineer&location=Lagos&asOf=2026-06-01" -Headers (Bearer $t)
Check 'resolves the location override' ([math]::Abs([double]$lagos.data.rate - 56.17) -lt 0.01) "got $($lagos.data.rate)"
Check 'location match is more specific' ($lagos.data.specificity -gt $def.data.specificity) "got $($lagos.data.specificity)"

# Nairobi has no entry, so it must fall back to the default and say so.
$fallback = Invoke-RestMethod -Uri "$base/pricing/rate-cards/$cardId/resolve?labourCategory=Network%20Engineer&location=Nairobi&asOf=2026-06-01" -Headers (Bearer $t)
Check 'falls back for an unlisted location' ([math]::Abs([double]$fallback.data.rate - 68.50) -lt 0.001) "got $($fallback.data.rate)"
Check 'fallback is reported, not silent' ($fallback.data.fellBackOn -contains 'location') "fellBackOn: $($fallback.data.fellBackOn)"
Check 'resolution explains itself' ($fallback.data.explanation.Length -gt 10) 'no explanation'

# Location outranks channel, deterministically.
$both = Invoke-RestMethod -Uri "$base/pricing/rate-cards/$cardId/resolve?labourCategory=Network%20Engineer&location=Lagos&channel=Onsite&asOf=2026-06-01" -Headers (Bearer $t)
Check 'location outranks channel' ([math]::Abs([double]$both.data.rate - 56.17) -lt 0.01) "got $($both.data.rate)"

Write-Host "`n== Effective dating ==" -ForegroundColor Cyan
$y1 = Invoke-RestMethod -Uri "$base/pricing/rate-cards/$cardId/resolve?labourCategory=Field%20Technician&asOf=2026-06-01" -Headers (Bearer $t)
$y2 = Invoke-RestMethod -Uri "$base/pricing/rate-cards/$cardId/resolve?labourCategory=Field%20Technician&asOf=2027-06-01" -Headers (Bearer $t)
# 41.20 -> 41.20 x 1.055 = 43.47
Check 'year 1 rate correct' ([math]::Abs([double]$y1.data.rate - 41.20) -lt 0.001) "got $($y1.data.rate)"
Check 'year 2 picks up the later version' ([math]::Abs([double]$y2.data.rate - 43.47) -lt 0.01) "got $($y2.data.rate)"
Check 'the two versions differ' ($y1.data.rate -ne $y2.data.rate) 'identical'

try {
  Invoke-RestMethod -Uri "$base/pricing/rate-cards/$cardId/resolve?labourCategory=Field%20Technician&asOf=2020-01-01" -Headers (Bearer $t) | Out-Null
  Check 'refuses a date the card does not cover' $false 'returned a rate'
} catch { Check 'refuses a date the card does not cover' ($_.Exception.Response.StatusCode.value__ -eq 422) "status $($_.Exception.Response.StatusCode.value__)" }

try {
  Invoke-RestMethod -Uri "$base/pricing/rate-cards/$cardId/resolve?labourCategory=Astronaut&asOf=2026-06-01" -Headers (Bearer $t) | Out-Null
  Check 'refuses an unknown labour category' $false 'returned a rate'
} catch { Check 'refuses an unknown labour category' ($_.Exception.Response.StatusCode.value__ -eq 422) "status $($_.Exception.Response.StatusCode.value__)" }

Write-Host "`n== Multi-year schedule crossing a rate change ==" -ForegroundColor Cyan
$sched = Send 'Post' "/pricing/rate-cards/$cardId/schedule" $t @{
  labourCategory = 'Field Technician'; startDate = '2026-01-01'; years = 3
}
Check 'schedule has one rate per year' ($sched.data.ratesByYear.Count -eq 3) "got $($sched.data.ratesByYear.Count)"
Check 'year 1 from the first version' ([math]::Abs([double]$sched.data.ratesByYear[0] - 41.20) -lt 0.001) "got $($sched.data.ratesByYear[0])"
Check 'year 2 picks up the rate change' ([math]::Abs([double]$sched.data.ratesByYear[1] - 43.47) -lt 0.01) "got $($sched.data.ratesByYear[1])"
Check 'the change is flagged' ($sched.data.entries[1].changed -eq $true) 'not flagged'
Check 'schedule warns that the rate moves mid-term' (($sched.data.warnings -join ' ') -match 'rate changes') "warnings: $($sched.data.warnings -join '; ')"
Check 'every year names its source' ($sched.data.entries[0].source -eq 'RATE_CARD') "got $($sched.data.entries[0].source)"

Write-Host "`n== Pricing straight from the card ==" -ForegroundColor Cyan
$priced = Send 'Post' "/pricing/rate-cards/$cardId/price-labour" $t @{
  startDate = '2026-01-01'; years = 3
  lines = @(
    @{ labourCategory = 'Field Technician'; location = 'Lagos'; hoursByYear = @(2000, 2000, 2000) },
    @{ labourCategory = 'Network Engineer'; hoursByYear = @(1000, 1000, 1000) }
  )
}
Check 'labour lines returned ready to price' ($priced.data.labour.Count -eq 2) "got $($priced.data.labour.Count)"
Check 'each line carries a rate schedule' ($priced.data.labour[0].ratesByYear.Count -eq 3) "got $($priced.data.labour[0].ratesByYear.Count)"
Check 'each year has an explanation' ($priced.data.labour[0].rateExplanations.Count -eq 3) 'missing'

# Feed straight into the pricing model and check the arithmetic.
$model = @{
  name = "Rate card priced $stamp"; contractType = 'TIME_AND_MATERIALS'; years = 3
  labour = @($priced.data.labour | ForEach-Object {
    @{ labourCategory = $_.labourCategory; hoursByYear = $_.hoursByYear; baseRate = $_.baseRate; ratesByYear = $_.ratesByYear }
  })
  directCosts = @(); burdens = @(); feeRate = '0'
}
$calc = Send 'Post' '/pricing/calculate' $t $model

# The seed stores rates rounded to 2dp, so the expectation uses the stored rates
# rather than the unrounded products.
# Field Technician Lagos: 41.20 x 0.82 = 33.784 -> stored 33.78 (y1)
#                         x 1.055       = 35.642 -> stored 35.64 (y2, y3)
#   2000 x (33.78 + 35.64 + 35.64) = 2000 x 105.06 = 210,120
# Network Engineer:       68.50 (y1); 68.50 x 1.055 = 72.2675 -> stored 72.27 (y2, y3)
#   1000 x (68.50 + 72.27 + 72.27) = 213,040
#   total direct labour = 423,160
Check 'pricing model consumes the schedule' ($calc.data.totals.directLabour -eq '423160.0000') "got $($calc.data.totals.directLabour)"
Check 'year 1 costs less than year 3' ([double]$calc.data.years[0].directLabour -lt [double]$calc.data.years[2].directLabour) 'no uplift across the term'

Write-Host "`n== Overlapping versions are rejected ==" -ForegroundColor Cyan
try {
  Send 'Post' '/pricing/rate-cards' $t @{
    code = "BAD$stamp"; name = 'Overlapping'; currency = 'USD'
    entries = @(
      @{ labourCategory = 'Tech'; rate = '40.00'; effectiveFrom = '2026-01-01'; effectiveTo = '2027-06-01' },
      @{ labourCategory = 'Tech'; rate = '44.00'; effectiveFrom = '2027-01-01' }
    )
  } | Out-Null
  Check 'overlapping effective ranges rejected' $false 'card was accepted'
} catch { Check 'overlapping effective ranges rejected' ($_.Exception.Response.StatusCode.value__ -eq 400) "status $($_.Exception.Response.StatusCode.value__)" }

# Abutting ranges are fine.
$good = Send 'Post' '/pricing/rate-cards' $t @{
  code = "OK$stamp"; name = 'Abutting'; currency = 'USD'
  entries = @(
    @{ labourCategory = 'Tech'; rate = '40.00'; effectiveFrom = '2026-01-01'; effectiveTo = '2027-01-01' },
    @{ labourCategory = 'Tech'; rate = '44.00'; effectiveFrom = '2027-01-01' }
  )
}
Check 'abutting ranges accepted' ($null -ne $good.data.id) 'rejected'

$replaced = Send 'Put' "/pricing/rate-cards/$($good.data.id)/entries" $t @{
  entries = @(@{ labourCategory = 'Tech'; rate = '50.00'; effectiveFrom = '2026-01-01' })
}
Check 'entries can be replaced wholesale' ($replaced.data.entryCount -eq 1) "got $($replaced.data.entryCount)"

Write-Host "`n== Permissions and governance ==" -ForegroundColor Cyan
try {
  Send 'Post' '/pricing/rate-cards' $viewer.accessToken @{ code = "V$stamp"; name = 'Viewer'; currency = 'USD'; entries = @() } | Out-Null
  Check 'viewer cannot create a rate card' $false 'was allowed'
} catch { Check 'viewer cannot create a rate card' ($_.Exception.Response.StatusCode.value__ -eq 403) "status $($_.Exception.Response.StatusCode.value__)" }

$analystRead = Invoke-RestMethod -Uri "$base/pricing/rate-cards" -Headers (Bearer $analyst.accessToken)
Check 'analyst can read rate cards' ($analystRead.data.Count -ge 1) 'denied'

$audit = Invoke-RestMethod -Uri "$base/governance/audit?pageSize=30&entityType=RateCard" -Headers (Bearer $t)
Check 'rate card changes are audited' ($audit.data.Count -ge 1) "got $($audit.data.Count)"

Write-Host "`n=====================================" -ForegroundColor Cyan
Write-Host ("  PASSED: $pass    FAILED: $fail") -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "=====================================`n" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
