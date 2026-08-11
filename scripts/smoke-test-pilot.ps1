# Smoke test for the pilot-readiness features: notifications, deadline
# reminders, password reset and reference-data import.
#
#   pwsh ./scripts/smoke-test-pilot.ps1
#
# Idempotent, and in the strong sense: repeated runs leave the database in the
# same shape, not merely without errors. Reference data uses fixed codes so a
# second run updates rather than accumulates, and everything it does create
# hangs below the level that smoke-test.ps1 asserts on.
#
# The password-reset section needs PASSWORD_RESET_EXPOSE_TOKEN=true, since there
# is no mailbox to read here. It skips itself, loudly, when that is not set.

$ErrorActionPreference = 'Stop'
$base = if ($env:FFP_API_URL) { $env:FFP_API_URL } else { 'http://localhost:4000/api/v1' }
$pass = 0; $fail = 0; $skip = 0

function Check($name, $cond, $detail) {
  if ($cond) { $script:pass++; Write-Host ("  PASS  " + $name) -ForegroundColor Green }
  else { $script:fail++; Write-Host ("  FAIL  " + $name + "  -> " + $detail) -ForegroundColor Red }
}
function Skip($name, $why) {
  $script:skip++; Write-Host ("  SKIP  " + $name + "  -> " + $why) -ForegroundColor Yellow
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
function Status($block) {
  try { & $block | Out-Null; return 0 } catch { return $_.Exception.Response.StatusCode.value__ }
}

# The seeded admin password is configurable (SEED_ADMIN_PASSWORD) and
# scripts/init-env.mjs generates a random one, so this must not be hardcoded -
# following the documented setup would otherwise break every run. run-e2e.mjs
# loads .env before invoking the suites; the fallback is the shipped default for
# anyone running this script directly.
$adminPassword = if ($env:SEED_ADMIN_PASSWORD) { $env:SEED_ADMIN_PASSWORD } else { 'Adm1n!Local2026' }
$admin   = Login 'admin@ffp.local' $adminPassword
$finmgr  = Login 'finance.manager@ffp.local' 'FinMgr!Local26'
$owner   = Login 'owner.mobile@ffp.local' 'Owner!Local26x'
$viewer  = Login 'viewer@ffp.local' 'Viewer!Local26x'
$stamp   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$t  = $admin.accessToken
$fm = $finmgr.accessToken

# ---------------------------------------------------------------------------
# Fixed codes, not stamped ones.
#
# Reference data is never deleted by design, so a run-unique code would leave a
# unit behind on every run - and those accumulate until they break the base
# suite's assertions about the shape of the seeded hierarchy. Fixed codes mean
# the first run creates and every later run is a no-op update, which is also a
# far better test of the idempotency the import actually promises.
#
# Everything the suite writes hangs under SHR, so the seeded top two levels that
# smoke-test.ps1 asserts on are untouched.
$ZBU = 'ZZ-SMOKE'
$ZBUC = 'ZZ-SMOKE-CHILD'
$ZACC = '9999'

Write-Host "`n== Reference-data import: dry run ==" -ForegroundColor Cyan

$buCsv = @"
code,name,parentCode,costCentre,currency,isActive
$ZBU,Smoke Test Unit,SHR,CC-SMOKE,USD,true
$ZBUC,Smoke Test Sub-unit,$ZBU,CC-SMOKE-1,USD,true
"@

$dry = Send 'Post' '/import/business-units' $t @{ csv = $buCsv }
Check 'dry run is not applied' ($dry.applied -eq $false) "applied=$($dry.applied)"
Check 'dry run has no issues' ($dry.issues.Count -eq 0) "issues=$($dry.issues.Count)"
Check 'dry run accounts for both rows' (($dry.created + $dry.updated + $dry.unchanged) -eq 2) `
  "c=$($dry.created) u=$($dry.updated) n=$($dry.unchanged)"

# A code that certainly does not exist, so "the dry run wrote nothing" is a real
# assertion. Dry-run only, so nothing is left behind.
$ghost = "ZZ-GHOST-$stamp"
$dryGhost = Send 'Post' '/import/business-units' $t @{ csv = "code,name,parentCode`n$ghost,Ghost,SHR`n" }
Check 'dry run reports the new code as a create' ($dryGhost.created -eq 1) "created=$($dryGhost.created)"
$unitsBefore = Invoke-RestMethod -Uri "$base/org/business-units" -Headers (Bearer $t)
Check 'dry run wrote nothing to the database' `
  (@($unitsBefore.data | Where-Object { $_.code -eq $ghost }).Count -eq 0) 'the ghost unit was created'

Write-Host "`n== Reference-data import: apply ==" -ForegroundColor Cyan
$applied = Send 'Post' '/import/business-units?apply=true' $t @{ csv = $buCsv }
Check 'apply reports applied' ($applied.applied -eq $true) "applied=$($applied.applied)"

$unitsAfter = Invoke-RestMethod -Uri "$base/org/business-units" -Headers (Bearer $t)
$parent = @($unitsAfter.data | Where-Object { $_.code -eq $ZBU })
$child = @($unitsAfter.data | Where-Object { $_.code -eq $ZBUC })
$shared = @($unitsAfter.data | Where-Object { $_.code -eq 'SHR' })
Check 'imported unit exists' ($parent.Count -eq 1) "found $($parent.Count)"
Check 'imported sub-unit exists' ($child.Count -eq 1) "found $($child.Count)"
Check 'sub-unit is linked to its parent' ($child[0].parentId -eq $parent[0].id) "parentId=$($child[0].parentId)"
Check 'a parent already in the database resolves' ($parent[0].parentId -eq $shared[0].id) "parentId=$($parent[0].parentId)"

Write-Host "`n== Import is idempotent ==" -ForegroundColor Cyan
$again = Send 'Post' '/import/business-units?apply=true' $t @{ csv = $buCsv }
Check 're-import creates nothing' ($again.created -eq 0) "created=$($again.created)"
Check 're-import updates nothing' ($again.updated -eq 0) "updated=$($again.updated)"
Check 're-import reports both unchanged' ($again.unchanged -eq 2) "unchanged=$($again.unchanged)"

# Dry run only, so the name is never actually changed and the next run sees the
# same starting state.
$renamed = $buCsv.Replace('Smoke Test Unit', 'Renamed Smoke Unit')
$diff = Send 'Post' '/import/business-units' $t @{ csv = $renamed }
Check 'a changed name is detected as an update' ($diff.updated -eq 1) "updated=$($diff.updated)"
Check 'the changed field is named' ($diff.preview[0].changed -contains 'name') "changed=$($diff.preview[0].changed)"

Write-Host "`n== Import validation ==" -ForegroundColor Cyan
# apply=true deliberately: an import carrying issues must write nothing even
# when the caller asked it to.
$bad = Send 'Post' '/import/business-units?apply=true' $t @{
  csv = "code,name,parentCode`nZZ-BAD-$stamp,Bad,ZZ-GHOST-$stamp`n"
}
Check 'unresolvable parent is an issue' ($bad.issues.Count -ge 1) "issues=$($bad.issues.Count)"
Check 'an import with issues is never applied' ($bad.applied -eq $false) "applied=$($bad.applied)"
$afterBad = Invoke-RestMethod -Uri "$base/org/business-units" -Headers (Bearer $t)
Check 'and really wrote nothing' (@($afterBad.data | Where-Object { $_.code -eq "ZZ-BAD-$stamp" }).Count -eq 0) 'the bad row was written'

$dupe = Send 'Post' '/import/business-units' $t @{
  csv = "code,name`nZZ-DUP,One`nZZ-DUP,Two`n"
}
Check 'duplicate code within a file is rejected' (@($dupe.issues | Where-Object { $_.message -match 'Duplicate code' }).Count -ge 1) 'not flagged'

$cycleCheck = Send 'Post' '/import/business-units' $t @{
  csv = "code,name,parentCode`nZZ-A,A,ZZ-B`nZZ-B,B,ZZ-A`n"
}
Check 'a hierarchy cycle is rejected' (@($cycleCheck.issues | Where-Object { $_.message -match 'Hierarchy cycle' }).Count -ge 1) 'not flagged'

$acctBad = Send 'Post' '/import/accounts' $t @{
  csv = "code,name,type,costBehaviour,variableShare`nZZ-ACC,Energy,OPEX,SEMI_VARIABLE,35`n"
}
Check 'percentage variable share is rejected' (@($acctBad.issues | Where-Object { $_.message -match 'fractions, not percentages' }).Count -ge 1) 'not flagged'

$acctOk = Send 'Post' '/import/accounts?apply=true' $t @{
  csv = "code,name,type,category,parentCode,spendCategory,costBehaviour,variableShare,isActive`n$ZACC,Smoke Test Energy,OPEX,INDIRECT,,FACILITIES,SEMI_VARIABLE,0.35,true`n"
}
Check 'a valid account import applies' ($acctOk.applied -eq $true) "applied=$($acctOk.applied)"
$acctAgain = Send 'Post' '/import/accounts?apply=true' $t @{
  csv = "code,name,type,category,parentCode,spendCategory,costBehaviour,variableShare,isActive`n$ZACC,Smoke Test Energy,OPEX,INDIRECT,,FACILITIES,SEMI_VARIABLE,0.35,true`n"
}
# 0.35 stored as numeric(18,8) must read back as an unchanged value, not churn.
Check 'a re-imported account is unchanged, decimal scale and all' ($acctAgain.unchanged -eq 1) "unchanged=$($acctAgain.unchanged)"

Write-Host "`n== Import permissions and templates ==" -ForegroundColor Cyan
Check 'viewer cannot import' ((Status { Send 'Post' '/import/business-units' $viewer.accessToken @{ csv = "code,name`nX,Y`n" } }) -eq 403) 'was allowed'
Check 'finance manager cannot import reference data' ((Status { Send 'Post' '/import/accounts' $fm @{ csv = "code,name,type`nX,Y,OPEX`n" } }) -eq 403) 'was allowed'

$tpl = Invoke-WebRequest -UseBasicParsing -Uri "$base/import/templates/accounts" -Headers (Bearer $t)
Check 'account template is served as CSV' ($tpl.Headers['Content-Type'] -match 'text/csv') "type=$($tpl.Headers['Content-Type'])"
Check 'template names the required columns' ($tpl.Content -match 'code,name,type') 'header missing'

$auditImport = Invoke-RestMethod -Uri "$base/governance/audit?pageSize=20&action=IMPORT" -Headers (Bearer $t)
Check 'imports are audited' ($auditImport.data.Count -ge 1) "got $($auditImport.data.Count)"

# ---------------------------------------------------------------------------
Write-Host "`n== Notification preferences ==" -ForegroundColor Cyan

$prefs = Invoke-RestMethod -Uri "$base/notifications/preferences" -Headers (Bearer $fm)
Check 'every type is listed' ($prefs.data.Count -eq 10) "got $($prefs.data.Count)"
$rejected = @($prefs.data | Where-Object { $_.type -eq 'BUDGET_REJECTED' })
Check 'rejection notices are marked non-mutable' ($rejected[0].mutable -eq $false) "mutable=$($rejected[0].mutable)"

Check 'a non-mutable type cannot be muted' ((Status { Send 'Put' '/notifications/preferences' $fm @{ type = 'BUDGET_REJECTED'; muted = $true } }) -eq 400) 'was allowed'

$muteOk = Send 'Put' '/notifications/preferences' $fm @{ type = 'PERIOD_CLOSED'; muted = $true }
Check 'a mutable type can be muted' ($muteOk.muted -eq $true) 'not muted'
$unmuteOk = Send 'Put' '/notifications/preferences' $fm @{ type = 'PERIOD_CLOSED'; muted = $false }
Check 'and unmuted again' ($unmuteOk.muted -eq $false) 'still muted'

# ---------------------------------------------------------------------------
Write-Host "`n== Notifications from the budget workflow ==" -ForegroundColor Cyan

# Own cycle and unit, so the run mutates nothing seeded.
$cycle = Send 'Post' '/cycles' $fm @{
  name = "Pilot Smoke $stamp"; fiscalYear = 2029; periodType = 'MONTH'
  opensAt = '2028-01-01'; submissionDeadline = '2028-03-01'; approvalDeadline = '2028-04-01'
  baseCurrency = 'USD'
}
$cycleId = $cycle.data.id
Send 'Patch' "/cycles/$cycleId/status" $fm @{ status = 'OPEN' } | Out-Null

$unit = @((Invoke-RestMethod -Uri "$base/org/business-units" -Headers (Bearer $fm)).data | Where-Object { $_.code -eq 'MOB' })[0]
$accounts = (Invoke-RestMethod -Uri "$base/org/accounts" -Headers (Bearer $fm)).data
$acct = @($accounts | Where-Object { $_.type -eq 'OPEX' })[0]

$budget = Send 'Post' '/budgets' $owner.accessToken @{
  cycleId = $cycleId; businessUnitId = $unit.id; name = "Pilot Budget $stamp"; currency = 'USD'
  lines = @(@{ accountId = $acct.id; description = 'Smoke line'; periodAmounts = @(1..12 | ForEach-Object { '10000.0000' }) })
}
$budgetId = $budget.data.id

$inboxBefore = Invoke-RestMethod -Uri "$base/notifications?pageSize=1" -Headers (Bearer $fm)
$unreadBefore = $inboxBefore.unread

# The workflow is DRAFT -> IN_REVIEW -> SUBMITTED; there is no direct jump.
Send 'Post' "/budgets/$budgetId/transition" $owner.accessToken @{ to = 'IN_REVIEW' } | Out-Null
Send 'Post' "/budgets/$budgetId/transition" $owner.accessToken @{ to = 'SUBMITTED'; comment = 'Pilot smoke submission' } | Out-Null

$inboxAfter = Invoke-RestMethod -Uri "$base/notifications?pageSize=50" -Headers (Bearer $fm)
$approvalMsg = @($inboxAfter.data | Where-Object { $_.entityId -eq $budgetId -and $_.type -eq 'BUDGET_SUBMITTED' })
Check 'submission notifies an eligible approver' ($approvalMsg.Count -eq 1) "got $($approvalMsg.Count)"
Check 'unread count went up' ($inboxAfter.unread -gt $unreadBefore) "before=$unreadBefore after=$($inboxAfter.unread)"
Check 'the message carries the amount' ($approvalMsg[0].subject -match '120000') "subject=$($approvalMsg[0].subject)"
Check 'and explains why they were chosen' ($approvalMsg[0].body -match 'within your delegated authority') 'no explanation'

# Separation of duties: the submitter must never be asked to approve their own.
$ownerInbox = Invoke-RestMethod -Uri "$base/notifications?pageSize=50" -Headers (Bearer $owner.accessToken)
$selfAsk = @($ownerInbox.data | Where-Object { $_.entityId -eq $budgetId -and $_.type -eq 'BUDGET_SUBMITTED' })
Check 'the submitter is not asked to approve their own budget' ($selfAsk.Count -eq 0) "got $($selfAsk.Count)"

Write-Host "`n== Rejection notifies the preparer ==" -ForegroundColor Cyan
Send 'Post' "/budgets/$budgetId/transition" $fm @{ to = 'REJECTED'; comment = 'Energy escalation looks understated.' } | Out-Null
$ownerInbox2 = Invoke-RestMethod -Uri "$base/notifications?pageSize=50" -Headers (Bearer $owner.accessToken)
$reject = @($ownerInbox2.data | Where-Object { $_.entityId -eq $budgetId -and $_.type -eq 'BUDGET_REJECTED' })
Check 'the preparer is told it was returned' ($reject.Count -eq 1) "got $($reject.Count)"
Check 'the reason is carried through' ($reject[0].body -match 'Energy escalation looks understated') 'reason missing'

Write-Host "`n== Inbox actions ==" -ForegroundColor Cyan
$read = Send 'Post' "/notifications/$($reject[0].id)/read" $owner.accessToken $null
Check 'a notification can be marked read' ($read.updated -eq 1) "updated=$($read.updated)"
$readAgain = Send 'Post' "/notifications/$($reject[0].id)/read" $owner.accessToken $null
Check 'marking it read twice is harmless' ($readAgain.updated -eq 0) "updated=$($readAgain.updated)"

# Someone else's notification must be untouchable, and indistinguishable from
# one that does not exist.
$crossRead = Send 'Post' "/notifications/$($approvalMsg[0].id)/read" $owner.accessToken $null
Check 'another user cannot mark my notification read' ($crossRead.updated -eq 0) "updated=$($crossRead.updated)"

$unreadOnly = Invoke-RestMethod -Uri "$base/notifications?unreadOnly=true&pageSize=50" -Headers (Bearer $owner.accessToken)
$stillThere = @($unreadOnly.data | Where-Object { $_.id -eq $reject[0].id })
Check 'unreadOnly=true actually filters' ($stillThere.Count -eq 0) 'read message still listed'
# The query-string boolean trap: "false" must mean false.
$unreadFalse = Invoke-RestMethod -Uri "$base/notifications?unreadOnly=false&pageSize=50" -Headers (Bearer $owner.accessToken)
$backAgain = @($unreadFalse.data | Where-Object { $_.id -eq $reject[0].id })
Check 'unreadOnly=false is honoured, not read as truthy' ($backAgain.Count -eq 1) 'read message hidden'

Write-Host "`n== Dispatch ==" -ForegroundColor Cyan
$dispatch = Send 'Post' '/notifications/dispatch' $t $null
Check 'dispatcher runs' ($null -ne $dispatch.sent) 'no result'
Check 'dispatcher sent something' ($dispatch.sent -ge 1) "sent=$($dispatch.sent)"
Check 'nothing failed to dispatch' ($dispatch.failed -eq 0) "failed=$($dispatch.failed)"
Check 'viewer cannot run the dispatcher' ((Status { Send 'Post' '/notifications/dispatch' $viewer.accessToken $null }) -eq 403) 'was allowed'

$afterDispatch = Invoke-RestMethod -Uri "$base/notifications?pageSize=50" -Headers (Bearer $owner.accessToken)
$sentOne = @($afterDispatch.data | Where-Object { $_.id -eq $reject[0].id })
Check 'a dispatched notification is marked SENT' ($sentOne[0].status -eq 'SENT') "status=$($sentOne[0].status)"

Write-Host "`n== Deadline scan ==" -ForegroundColor Cyan
$scan = Send 'Post' '/notifications/scan-deadlines' $t $null
Check 'the scan runs' ($null -ne $scan.cyclesScanned) 'no result'
Check 'it scanned at least our cycle' ($scan.cyclesScanned -ge 1) "cycles=$($scan.cyclesScanned)"
$scanTwice = Send 'Post' '/notifications/scan-deadlines' $t $null
Check 'a second scan on the same day queues nothing new' ($scanTwice.queued -eq 0) "queued=$($scanTwice.queued)"

# ---------------------------------------------------------------------------
Write-Host "`n== Password reset ==" -ForegroundColor Cyan

# Unknown addresses must be indistinguishable from real ones.
$unknown = Invoke-RestMethod -Uri "$base/auth/forgot-password" -Method Post -ContentType 'application/json' `
  -Body (@{ email = "nobody-$stamp@ffp.local" } | ConvertTo-Json)
Check 'unknown address returns the standard message' ($unknown.message -match 'If that address has an account') "msg=$($unknown.message)"
Check 'unknown address yields no token' ($null -eq $unknown.devToken) 'token leaked for an unknown address'

# Reset a user the rest of this suite does not depend on.
$target = 'analyst@ffp.local'
$known = Invoke-RestMethod -Uri "$base/auth/forgot-password" -Method Post -ContentType 'application/json' `
  -Body (@{ email = $target } | ConvertTo-Json)
Check 'known address returns the identical message' ($known.message -eq $unknown.message) 'responses differ - enumeration oracle'

if ($null -eq $known.devToken) {
  Skip 'password reset completion' 'PASSWORD_RESET_EXPOSE_TOKEN is not enabled; no mailbox to read'
}
else {
  $analystSession = Login $target 'Analyst!Local26'
  $newPassword = "Reset!Pilot$stamp"

  $reset = Invoke-RestMethod -Uri "$base/auth/reset-password" -Method Post -ContentType 'application/json' `
    -Body (@{ token = $known.devToken; newPassword = $newPassword } | ConvertTo-Json)
  Check 'reset succeeds' ($reset.success -eq $true) 'failed'
  Check 'existing sessions were revoked' ($reset.sessionsRevoked -ge 1) "revoked=$($reset.sessionsRevoked)"

  # The old refresh token must be dead: that is the whole point of a reset.
  $refreshStatus = Status {
    Invoke-RestMethod -Uri "$base/auth/refresh" -Method Post -ContentType 'application/json' `
      -Body (@{ refreshToken = $analystSession.refreshToken } | ConvertTo-Json)
  }
  Check 'the old refresh token no longer works' ($refreshStatus -eq 401) "status=$refreshStatus"

  $reuse = Status {
    Invoke-RestMethod -Uri "$base/auth/reset-password" -Method Post -ContentType 'application/json' `
      -Body (@{ token = $known.devToken; newPassword = "Other!Pilot$stamp" } | ConvertTo-Json)
  }
  Check 'the reset token is single use' ($reuse -eq 401) "status=$reuse"

  $newLogin = Login $target $newPassword
  Check 'the new password works' ($null -ne $newLogin.accessToken) 'login failed'

  $oldLogin = Status { Login $target 'Analyst!Local26' }
  Check 'the old password does not' ($oldLogin -eq 401) "status=$oldLogin"

  # Put it back, so the suite is repeatable and the other scripts still work.
  $restoreToken = (Invoke-RestMethod -Uri "$base/auth/forgot-password" -Method Post -ContentType 'application/json' `
      -Body (@{ email = $target } | ConvertTo-Json)).devToken
  Invoke-RestMethod -Uri "$base/auth/reset-password" -Method Post -ContentType 'application/json' `
    -Body (@{ token = $restoreToken; newPassword = 'Analyst!Local26' } | ConvertTo-Json) | Out-Null
  $restored = Status { Login $target 'Analyst!Local26' }
  Check 'the original password is restored for the next run' ($restored -eq 0) "status=$restored"
}

$badToken = Status {
  Invoke-RestMethod -Uri "$base/auth/reset-password" -Method Post -ContentType 'application/json' `
    -Body (@{ token = 'not-a-real-token'; newPassword = "Whatever!$stamp" } | ConvertTo-Json)
}
Check 'a bogus reset token is refused' ($badToken -eq 401) "status=$badToken"

# ---------------------------------------------------------------------------
Write-Host "`n== Audit chain still intact after all of the above ==" -ForegroundColor Cyan
$verify = Send 'Post' '/governance/audit/verify' $t $null
Check 'audit chain verifies' ($verify.data.valid -eq $true) "broken at $($verify.data.brokenAt)"

Write-Host "`n=====================================" -ForegroundColor Cyan
Write-Host ("  PASSED: $pass    FAILED: $fail    SKIPPED: $skip") -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "=====================================`n" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
