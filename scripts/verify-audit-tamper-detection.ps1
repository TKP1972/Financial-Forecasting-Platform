# Proves the audit trail is tamper-EVIDENT, not merely tamper-resistant.
#
# Verifying that an untouched chain passes is the easy half. The control is only
# worth anything if an edit made directly in the database - bypassing the
# application entirely - is detected. This script does exactly that, then puts
# the row back.
#
# Requires: the stack running, the Postgres container reachable, a CFO/ADMIN login.
#
#   pwsh ./scripts/verify-audit-tamper-detection.ps1

$ErrorActionPreference = 'Stop'
$base      = $env:FFP_API_URL;   if (-not $base)      { $base = 'http://localhost:4000/api/v1' }
$container = $env:FFP_PG_CONTAINER; if (-not $container) { $container = 'ffp-postgres' }
$dbUser    = $env:POSTGRES_USER; if (-not $dbUser)    { $dbUser = 'ffp' }
$dbName    = $env:POSTGRES_DB;   if (-not $dbName)    { $dbName = 'ffp' }
$email     = $env:FFP_CFO_EMAIL; if (-not $email)     { $email = 'cfo@ffp.local' }
$password  = $env:FFP_CFO_PASSWORD; if (-not $password) { $password = 'Cfo!Local2026x' }

$pass = 0; $fail = 0
function Check($name, $cond, $detail) {
  if ($cond) { $script:pass++; Write-Host ("  PASS  " + $name) -ForegroundColor Green }
  else { $script:fail++; Write-Host ("  FAIL  " + $name + "  -> " + $detail) -ForegroundColor Red }
}
# SQL goes in over stdin, not as a -c argument. Prisma's columns are camelCase
# and therefore need double quotes; passing those through PowerShell -> docker
# -> psql as arguments strips them, and Postgres then folds the name to
# lowercase and reports "column actorid does not exist".
function Psql($sql) { $sql | docker exec -i $container psql -U $dbUser -d $dbName -t -A }

Write-Host "`n== Audit chain tamper detection ==" -ForegroundColor Cyan

$login = Invoke-RestMethod -Uri "$base/auth/login" -Method Post -ContentType 'application/json' `
  -Body (@{ email = $email; password = $password } | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($login.accessToken)" }

# 1. Baseline: the chain must be intact before we touch anything.
$before = Invoke-RestMethod -Uri "$base/governance/audit/verify" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
Check 'chain is intact to begin with' ($before.data.valid -eq $true) "reason: $($before.data.reason)"
Write-Host ("        $($before.data.entriesChecked) entries verified") -ForegroundColor DarkGray

if ($before.data.entriesChecked -lt 3) {
  Write-Host "  Not enough audit history to tamper with. Run the smoke test first." -ForegroundColor Yellow
  exit 1
}

# This script deliberately corrupts the audit table, so every mutation is
# wrapped in try/finally. If a verification call fails part-way through - the API
# restarting, say - the row is still put back, rather than leaving the chain
# permanently broken and needing a manual repair.
$target = (Psql "SELECT sequence FROM audit_logs ORDER BY sequence ASC OFFSET 1 LIMIT 1").Trim()
$original = (Psql "SELECT summary FROM audit_logs WHERE sequence = $target").Trim()

try {
  # 2. Edit a row's content directly in the database, leaving its hash untouched.
  #    This is precisely what an attacker with database access would attempt.
  Write-Host ("        tampering with sequence $target") -ForegroundColor DarkGray
  Psql "UPDATE audit_logs SET summary = 'TAMPERED: approved by someone else' WHERE sequence = $target" | Out-Null

  $after = Invoke-RestMethod -Uri "$base/governance/audit/verify" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
  Check 'tampering is detected' ($after.data.valid -eq $false) 'edit went unnoticed'
  Check 'the tampered entry is identified' ($after.data.brokenAtSequence -eq $target) "reported $($after.data.brokenAtSequence), expected $target"
  Check 'the failure reason names a content change' ($after.data.reason -match 'modified after it was written') "reason: $($after.data.reason)"
}
finally {
  $escaped = $original.Replace("'", "''")
  Psql "UPDATE audit_logs SET summary = '$escaped' WHERE sequence = $target" | Out-Null
}

# 3. Confirm the chain reads as intact again, which also proves the detection was
#    genuinely about the content rather than an incidental side effect.
$restored = Invoke-RestMethod -Uri "$base/governance/audit/verify" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
Check 'chain verifies again once restored' ($restored.data.valid -eq $true) "reason: $($restored.data.reason)"

# 4. Removing an entry from the middle must break the chain, not renumber silently.
#    Capture a full re-INSERT statement first so the row can be put back exactly.
$victim = (Psql "SELECT sequence FROM audit_logs ORDER BY sequence ASC OFFSET 2 LIMIT 1").Trim()
$restoreSql = (Psql @"
SELECT format(
  'INSERT INTO audit_logs (id,sequence,"actorId","actorEmail",action,"entityType","entityId",summary,changes,"ipAddress","userAgent",hash,"previousHash","createdAt") VALUES (%L,%s,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L);',
  id, sequence, "actorId", "actorEmail", action::text, "entityType", "entityId",
  summary, changes, "ipAddress", "userAgent", hash, "previousHash", "createdAt")
FROM audit_logs WHERE sequence = $victim
"@).Trim()

try {
  Write-Host ("        deleting sequence $victim") -ForegroundColor DarkGray
  Psql "DELETE FROM audit_logs WHERE sequence = $victim" | Out-Null

  $gapped = Invoke-RestMethod -Uri "$base/governance/audit/verify" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
  Check 'deletion is detected' ($gapped.data.valid -eq $false) 'deletion went unnoticed'
  Check 'the gap is reported' ($gapped.data.reason -match 'deleted|Chain link mismatch') "reason: $($gapped.data.reason)"
}
finally {
  Psql $restoreSql | Out-Null
}

$final = Invoke-RestMethod -Uri "$base/governance/audit/verify" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
Check 'chain fully restored' ($final.data.valid -eq $true) "reason: $($final.data.reason)"

Write-Host "`n=====================================" -ForegroundColor Cyan
Write-Host ("  PASSED: $pass    FAILED: $fail") -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "=====================================`n" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
