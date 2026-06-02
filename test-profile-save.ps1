<#
  test-profile-save.ps1
  End-to-end tests for the profile-save feature in api/user-portfolio.js (Phase 2).

  Tests:
    SEED    add stocks + profile so later tests have something to preserve
    TEST 1  profile-only save -> 200, and the existing stocks survive (overwrite-bug fix)
    TEST 2  stocks-only save  -> 200, and the existing profile survives
    TEST 3  two profile saves within 5s -> first 200, second 429 (rate limit)
    TEST 4  bad enum value     -> 400 (validation rejects the whole save)

  WARNING: this hits PRODUCTION (Vercel -> GitHub-as-DB). It writes to the
  per-user file of whoever you log in as. Use a DISPOSABLE account ("tester").

  Usage:
    .\test-profile-save.ps1                 # prompts for the PIN
    .\test-profile-save.ps1 -Pin 1234
    .\test-profile-save.ps1 -BaseUrl "https://theisilabs.vercel.app" -Nickname tester -Pin 1234
#>

param(
  [string]$BaseUrl  = "https://theisilabs.vercel.app",
  [string]$Nickname = "tester",
  [string]$Pin      = $(Read-Host "Enter PIN for '$($Nickname)'"),
  [string]$Salt     = "theisilabs2026salt"
)

$ErrorActionPreference = "Stop"
$script:Pass = 0
$script:Fail = 0
$CooldownSeconds = 6   # > the server's 5s SAVE_COOLDOWN_MS

function Write-Header($text) {
  Write-Host ""
  Write-Host "==== $text ====" -ForegroundColor Cyan
}

function Check($name, [bool]$cond, $detail) {
  if ($cond) {
    Write-Host ("PASS: {0}" -f $name) -ForegroundColor Green
    $script:Pass++
  } else {
    Write-Host ("FAIL: {0} -- {1}" -f $name, $detail) -ForegroundColor Red
    $script:Fail++
  }
}

# HTTP helper that returns { Status = <int>; Body = <string> } and never throws
# on 4xx/5xx, on both Windows PowerShell 5.1 and PowerShell 7+.
function Invoke-Api {
  param(
    [string]$Method,
    [string]$Url,
    [hashtable]$Headers = @{},
    [string]$Body = $null
  )
  $params = @{
    Method          = $Method
    Uri             = $Url
    Headers         = $Headers
    ContentType     = 'application/json'
    UseBasicParsing = $true
  }
  if ($Body) { $params.Body = $Body }

  if ($PSVersionTable.PSVersion.Major -ge 6) {
    $params.SkipHttpErrorCheck = $true
    $resp = Invoke-WebRequest @params
    return @{ Status = [int]$resp.StatusCode; Body = [string]$resp.Content }
  } else {
    try {
      $resp = Invoke-WebRequest @params -ErrorAction Stop
      return @{ Status = [int]$resp.StatusCode; Body = [string]$resp.Content }
    } catch {
      $webResp = $_.Exception.Response
      if ($null -ne $webResp) {
        $code = [int]$webResp.StatusCode
        $content = ''
        try {
          $stream = $webResp.GetResponseStream()
          $reader = New-Object System.IO.StreamReader($stream)
          $content = $reader.ReadToEnd()
          $reader.Close()
        } catch { }
        return @{ Status = $code; Body = $content }
      }
      return @{ Status = 0; Body = $_.Exception.Message }
    }
  }
}

function Get-Portfolio($headers) {
  $r = Invoke-Api -Method GET -Url "$BaseUrl/api/user-portfolio" -Headers $headers
  if ($r.Status -ne 200) { return $null }
  return ($r.Body | ConvertFrom-Json).portfolio
}

# ── Step 0: compute pinHash = SHA-256(pin + salt), lowercase hex ──────────────
$bytes = [System.Text.Encoding]::UTF8.GetBytes($Pin + $Salt)
$sha   = [System.Security.Cryptography.SHA256]::Create()
$pinHash = ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-","").ToLower()

Write-Host ""
Write-Host "Target : $BaseUrl" -ForegroundColor Yellow
Write-Host "User   : $Nickname  (PRODUCTION data will be modified)" -ForegroundColor Yellow

# ── Step 1: login ────────────────────────────────────────────────────────────
Write-Header "LOGIN"
$loginBody = @{ nickname = $Nickname; pinHash = $pinHash } | ConvertTo-Json -Compress
$login = Invoke-Api -Method POST -Url "$BaseUrl/api/auth?action=login" -Body $loginBody
if ($login.Status -ne 200) {
  Write-Host "Login failed [$($login.Status)]: $($login.Body)" -ForegroundColor Red
  exit 1
}
$token = ($login.Body | ConvertFrom-Json).token
if (-not $token) {
  Write-Host "Login returned no token: $($login.Body)" -ForegroundColor Red
  exit 1
}
$H = @{ Authorization = "Bearer $token" }
Write-Host "Got session token ($($token.Length) chars)." -ForegroundColor Green

# ── Seed: stocks then profile ────────────────────────────────────────────────
Write-Header "SEED"
$seedStocks = @{ stocks = @(
  @{ sym='NVDA'; shares=2; cost=100 },
  @{ sym='MSFT'; shares=1; cost=400 }
) } | ConvertTo-Json -Compress -Depth 5
$s1 = Invoke-Api -Method POST -Url "$BaseUrl/api/user-portfolio" -Headers $H -Body $seedStocks
Check "seed stocks saved (200)" ($s1.Status -eq 200) "got [$($s1.Status)] $($s1.Body)"

Start-Sleep -Seconds $CooldownSeconds
$seedProfile = @{ profile = @{ riskTolerance='high'; goals='growth' } } | ConvertTo-Json -Compress -Depth 5
$s2 = Invoke-Api -Method POST -Url "$BaseUrl/api/user-portfolio" -Headers $H -Body $seedProfile
Check "seed profile saved (200)" ($s2.Status -eq 200) "got [$($s2.Status)] $($s2.Body)"

# ── TEST 1: profile-only save -> stocks survive ──────────────────────────────
Write-Header "TEST 1 - profile save, stocks survive"
Start-Sleep -Seconds $CooldownSeconds
$t1Body = @{ profile = @{ riskTolerance='medium'; cashToInvest=25000 } } | ConvertTo-Json -Compress -Depth 5
$t1 = Invoke-Api -Method POST -Url "$BaseUrl/api/user-portfolio" -Headers $H -Body $t1Body
Check "T1 profile save returns 200" ($t1.Status -eq 200) "got [$($t1.Status)] $($t1.Body)"

$p = Get-Portfolio $H
$stockCount = @($p.stocks).Count
Check "T1 stocks survived (count = 2)" ($stockCount -eq 2) "stocks count = $stockCount"
Check "T1 profile updated (riskTolerance = medium)" ($p.profile.riskTolerance -eq 'medium') "riskTolerance = $($p.profile.riskTolerance)"
Check "T1 profile field merged (cashToInvest = 25000)" ([double]$p.profile.cashToInvest -eq 25000) "cashToInvest = $($p.profile.cashToInvest)"
Check "T1 seed profile field preserved (goals = growth)" ($p.profile.goals -eq 'growth') "goals = $($p.profile.goals)"

# ── TEST 2: stocks-only save -> profile survives ─────────────────────────────
Write-Header "TEST 2 - stocks save, profile survives"
$t2Body = @{ stocks = @( @{ sym='AMZN'; shares=3; cost=170 } ) } | ConvertTo-Json -Compress -Depth 5
$t2 = Invoke-Api -Method POST -Url "$BaseUrl/api/user-portfolio" -Headers $H -Body $t2Body
Check "T2 stocks save returns 200 (not rate-limited)" ($t2.Status -eq 200) "got [$($t2.Status)] $($t2.Body)"

$p = Get-Portfolio $H
$stockCount = @($p.stocks).Count
$firstSym   = @($p.stocks)[0].sym
Check "T2 stocks replaced (count = 1, AMZN)" (($stockCount -eq 1) -and ($firstSym -eq 'AMZN')) "count = $stockCount, first = $firstSym"
Check "T2 profile survived (riskTolerance = medium)" ($p.profile.riskTolerance -eq 'medium') "riskTolerance = $($p.profile.riskTolerance)"
Check "T2 profile cash survived (cashToInvest = 25000)" ([double]$p.profile.cashToInvest -eq 25000) "cashToInvest = $($p.profile.cashToInvest)"

# ── TEST 3: two rapid profile saves -> second 429 ────────────────────────────
Write-Header "TEST 3 - rapid double profile save -> 429"
Start-Sleep -Seconds $CooldownSeconds
$t3a = @{ profile = @{ notes='first' } }  | ConvertTo-Json -Compress -Depth 5
$t3b = @{ profile = @{ notes='second' } } | ConvertTo-Json -Compress -Depth 5
$r3a = Invoke-Api -Method POST -Url "$BaseUrl/api/user-portfolio" -Headers $H -Body $t3a
$r3b = Invoke-Api -Method POST -Url "$BaseUrl/api/user-portfolio" -Headers $H -Body $t3b
Check "T3 first save returns 200" ($r3a.Status -eq 200) "got [$($r3a.Status)] $($r3a.Body)"
Check "T3 second save returns 429" ($r3b.Status -eq 429) "got [$($r3b.Status)] $($r3b.Body)"

# ── TEST 4: bad enum -> 400 ──────────────────────────────────────────────────
Write-Header "TEST 4 - bad enum -> 400"
# Validation runs before the rate-limit check, so cooldown does not matter here.
$t4 = @{ profile = @{ riskTolerance='aggressive' } } | ConvertTo-Json -Compress -Depth 5
$r4 = Invoke-Api -Method POST -Url "$BaseUrl/api/user-portfolio" -Headers $H -Body $t4
Check "T4 bad enum rejected (400)" ($r4.Status -eq 400) "got [$($r4.Status)] $($r4.Body)"

# ── Summary ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
$resultColor = 'Green'
if ($script:Fail -gt 0) { $resultColor = 'Red' }
Write-Host ("RESULT: {0} passed, {1} failed" -f $script:Pass, $script:Fail) -ForegroundColor $resultColor
Write-Host "=====================================" -ForegroundColor Cyan
if ($script:Fail -gt 0) { exit 1 } else { exit 0 }
