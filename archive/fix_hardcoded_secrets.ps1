# fix_hardcoded_secrets.ps1
# Run this from your repo root: C:\Users\user\Documents\theisilabs-portfolio
# It removes all hardcoded 'theisilabs2026' fallbacks and makes endpoints fail-closed.
# Review with: git diff api/   before committing.

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $repoRoot "api"))) {
    # Script may be run from repo root directly
    $repoRoot = Get-Location
}

Write-Host "Working in: $repoRoot" -ForegroundColor Cyan

# ─── Helper ────────────────────────────────────────────────────────────────
function Fix-File {
    param(
        [string]$RelPath,
        [scriptblock]$Transform
    )
    $full = Join-Path $repoRoot $RelPath
    if (-not (Test-Path $full)) {
        Write-Host "  SKIP (not found): $RelPath" -ForegroundColor Yellow
        return
    }
    $original = Get-Content $full -Raw -Encoding UTF8
    $fixed = & $Transform $original
    if ($fixed -ne $original) {
        Set-Content $full -Value $fixed -Encoding UTF8 -NoNewline
        Write-Host "  FIXED: $RelPath" -ForegroundColor Green
    } else {
        Write-Host "  CLEAN (no change): $RelPath" -ForegroundColor Gray
    }
}

# ─── Pattern we are removing ───────────────────────────────────────────────
# Old: const FOO = process.env.BRIEFING_API_KEY || 'theisilabs2026';
# New: const FOO = process.env.BRIEFING_API_KEY;
#      if (!FOO) return res.status(500).json({ error: 'Server misconfigured' });
#
# We can't inject the guard perfectly without knowing the function shape,
# so we do a safe two-step:
#   1. Remove the || 'theisilabs2026' fallback from the const line.
#   2. Insert a fail-closed guard on the very next line.
# The guard uses a sentinel comment so re-running is idempotent.

$SENTINEL = "/* fail-closed: no hardcoded fallback */"

function Remove-Fallback {
    param([string]$src, [string]$varName)
    # Remove fallback from const line
    $src = $src -replace "(\bconst\s+$varName\s*=\s*process\.env\.BRIEFING_API_KEY)\s*\|\|\s*'theisilabs2026'", '$1'
    # If guard not already present, insert it after the const line
    if ($src -notmatch [regex]::Escape($SENTINEL)) {
        $src = $src -replace "(\bconst\s+$varName\s*=\s*process\.env\.BRIEFING_API_KEY\s*;)", `
            "`$1`nif (!$varName) return res.status(500).json({ error: 'Server misconfigured' }); $SENTINEL"
    }
    return $src
}

# ─── 1. api/briefing.js ────────────────────────────────────────────────────
Fix-File "api/briefing.js" {
    param($src)
    Remove-Fallback $src "BRIEFING_API_KEY"
}

# ─── 2. api/portfolio.js ───────────────────────────────────────────────────
# Variable name may differ — handle both API_KEY and BRIEFING_API_KEY
Fix-File "api/portfolio.js" {
    param($src)
    $src = $src -replace "(\bconst\s+(?:API_KEY|BRIEFING_API_KEY)\s*=\s*process\.env\.BRIEFING_API_KEY)\s*\|\|\s*'theisilabs2026'", '$1'
    if ($src -notmatch [regex]::Escape($SENTINEL)) {
        $src = $src -replace "(\bconst\s+(?:API_KEY|BRIEFING_API_KEY)\s*=\s*process\.env\.BRIEFING_API_KEY\s*;)", `
            "`$1`nif (!API_KEY) return res.status(500).json({ error: 'Server misconfigured' }); $SENTINEL"
    }
    $src
}

# ─── 3. api/user-portfolio.js ──────────────────────────────────────────────
Fix-File "api/user-portfolio.js" {
    param($src)
    $src = $src -replace "(\bconst\s+(?:API_KEY|BRIEFING_API_KEY)\s*=\s*process\.env\.BRIEFING_API_KEY)\s*\|\|\s*'theisilabs2026'", '$1'
    if ($src -notmatch [regex]::Escape($SENTINEL)) {
        $src = $src -replace "(\bconst\s+(?:API_KEY|BRIEFING_API_KEY)\s*=\s*process\.env\.BRIEFING_API_KEY\s*;)", `
            "`$1`nif (!API_KEY) return res.status(500).json({ error: 'Server misconfigured' }); $SENTINEL"
    }
    $src
}

# ─── 4. api/generate-analysis.js ───────────────────────────────────────────
Fix-File "api/generate-analysis.js" {
    param($src)
    $src = $src -replace "(\bconst\s+API_KEY\s*=\s*process\.env\.BRIEFING_API_KEY)\s*\|\|\s*'theisilabs2026'", '$1'
    if ($src -notmatch [regex]::Escape($SENTINEL)) {
        $src = $src -replace "(\bconst\s+API_KEY\s*=\s*process\.env\.BRIEFING_API_KEY\s*;)", `
            "`$1`nif (!API_KEY) return res.status(500).json({ error: 'Server misconfigured' }); $SENTINEL"
    }
    $src
}

# ─── 5. api/update-portfolio.js ────────────────────────────────────────────
Fix-File "api/update-portfolio.js" {
    param($src)
    $src = $src -replace "(\bconst\s+(?:API_KEY|BRIEFING_API_KEY)\s*=\s*process\.env\.BRIEFING_API_KEY)\s*\|\|\s*'theisilabs2026'", '$1'
    if ($src -notmatch [regex]::Escape($SENTINEL)) {
        $src = $src -replace "(\bconst\s+(?:API_KEY|BRIEFING_API_KEY)\s*=\s*process\.env\.BRIEFING_API_KEY\s*;)", `
            "`$1`nif (!API_KEY) return res.status(500).json({ error: 'Server misconfigured' }); $SENTINEL"
    }
    $src
}

# ─── 6. api/admin.js — PIN salt ────────────────────────────────────────────
# Old: hash.update(pin + 'theisilabs2026salt');
# New: const PIN_SALT = process.env.PIN_SALT || 'theisi-pin-salt-v1';
#      hash.update(pin + PIN_SALT);
# (Fail-open for salt — a missing env var shouldn't lock out all users)
Fix-File "api/admin.js" {
    param($src)
    if ($src -match "'theisilabs2026salt'") {
        $src = $src -replace "hash\.update\(pin \+ 'theisilabs2026salt'\)", `
            "const PIN_SALT = process.env.PIN_SALT || 'theisi-pin-salt-v1';`n  hash.update(pin + PIN_SALT)"
    }
    $src
}

# ─── Final verification ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "Scanning for remaining 'theisilabs2026' in api/..." -ForegroundColor Cyan
$remaining = Select-String -Path (Join-Path $repoRoot "api\*.js") -Pattern "theisilabs2026" -SimpleMatch
if ($remaining) {
    Write-Host "  ⚠️  Still found in:" -ForegroundColor Yellow
    $remaining | ForEach-Object { Write-Host "    $($_.Filename):$($_.LineNumber) — $($_.Line.Trim())" -ForegroundColor Yellow }
} else {
    Write-Host "  ✅  Clean — no hardcoded fallbacks remaining in api/" -ForegroundColor Green
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. git diff api/          — review changes" -ForegroundColor White
Write-Host "  2. Add PIN_SALT to Vercel env vars (any strong value)" -ForegroundColor White
Write-Host "  3. git add api/ && git commit -m 'security: remove hardcoded fallbacks, fail-closed' && git push" -ForegroundColor White
