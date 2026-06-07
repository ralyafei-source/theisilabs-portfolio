// api/analysis.js
// Supports 3 analysis types: daily, weekly, monthly
// Supports per-user analysis via optional nickname param
// GET: reads appropriate file based on type + date + nickname params
// POST: writes to appropriate file (with nickname prefix if provided)

const REPO  = 'ralyafei-source/theisilabs-portfolio';
const TOKEN = process.env.GITHUB_TOKEN;
const API_KEY = process.env.BRIEFING_API_KEY;

function getFilePath(type, date, week, month, nickname) {
  const nick = nickname ? `-${nickname}` : '';
  const safeDate = date || new Date().toISOString().slice(0, 10);
  if (type === 'market-data') return `data/market-data-${date}.json`;
  if (type === 'weekly')  return `data/analysis-weekly${nick}-${week || safeDate.slice(0,7)}.json`;
  if (type === 'monthly') return `data/analysis-monthly${nick}-${month || safeDate.slice(0,7)}.json`;
  return `data/analysis-daily${nick}-${safeDate}.json`;
}

async function readFile(path) {
  const r = await fetch(
    `https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`
  );
  if (!r.ok) return null;
  return await r.json();
}

async function writeFile(path, data) {
  const check = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${path}`,
    { headers: { Authorization: `token ${TOKEN}` } }
  );
  let sha = null;
  if (check.ok) {
    const existing = await check.json();
    sha = existing.sha;
  }
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = { message: `Update ${path}`, content, ...(sha && { sha }) };
  const r = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${path}`,
    {
      method: 'PUT',
      headers: { Authorization: `token ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
  return r.ok;
}

// ───────────────────────── CP6: Health check helpers ─────────────────────────

// Section keyword arrays MUST mirror the dashboard's parseAnalysisSections
// (index.html) so "section present" means the same to CP6 as to the UI.
const HEALTH_SECTIONS = {
  daily: [
    ['DAILY SIGNALS', 'إشارات اليوم', 'الإشارات اليومية'],
    ['EARNINGS & EVENTS', 'EARNINGS', 'الأرباح والأحداث'],
    ['MACRO TODAY', 'MACRO', 'ماكرو اليوم', 'الاقتصاد العالمي']
  ],
  weekly: [
    ['═══ RISK RADAR', 'RISK RADAR'],
    ['═══ FAIR VALUE', 'FAIR VALUE'],
    ['═══ MOMENTUM', 'MOMENTUM']
  ],
  monthly: [
    ['COMPETITIVE EDGE', 'الميزة التنافسية'],
    ['LONG VIEW', 'النظرة طويلة المدى'],
    ['PORTFOLIO HEALTH', 'صحة المحفظة']
  ]
};

// Sentinels that indicate a missing/failed data point in the analysis text.
const HEALTH_SENTINELS = ['غير متوفر', 'N/A', 'null', 'Error', 'Legacy', 'Too Many Requests'];

// Build the health object from the content we just saved.
// writeOk = result of writeFile(); type = run type.
function buildHealth(content, type, writeOk) {
  const text = typeof content === 'string' ? content : JSON.stringify(content || '');
  const runType = (type || 'daily').toLowerCase();
  const expected = HEALTH_SECTIONS[runType] || HEALTH_SECTIONS.daily;

  // Check A — sections present (any keyword variant counts as found)
  const sectionsFound = [];
  const sectionsMissing = [];
  for (const variants of expected) {
    const hit = variants.some(k => text.includes(k));
    (hit ? sectionsFound : sectionsMissing).push(variants[0]);
  }

  // Check A — scores present (X/10 format) + length floor
  const scoresFound = (text.match(/\b(?:10|[0-9])\s*\/\s*10\b/g) || []).length;
  const contentLength = text.length;

  // Check B — count sentinel hits (proxy until CP2's structured DATA_QUALITY block)
  const sentinelHits = {};
  let totalSentinels = 0;
  for (const s of HEALTH_SENTINELS) {
    const n = (text.match(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (n > 0) { sentinelHits[s] = n; totalSentinels += n; }
  }

  // Status roll-up.
  // failed: write failed, OR no sections at all, OR content clearly truncated.
  // degraded: some sections missing, OR notable sentinel count, OR no scores where expected.
  // ok: otherwise.
  // NOTE v1: per-system proportion thresholds (25%/60%) require per-stock field
  // parsing which the structured DATA_QUALITY block (CP2) will provide. Until then
  // we approximate with sentinel count + section completeness. Calibrate after 1 week.
  let status = 'ok';
  const scoringExpected = false; // v1: daily/weekly use recommendation labels, not X/10 scores. Re-enable per run-type once confirmed which emits X/10. See CP6 build doc.
  if (!writeOk) {
    status = 'failed';
  } else if (contentLength < 500 || sectionsFound.length === 0) {
    status = 'failed';
  } else if (sectionsMissing.length > 0 || totalSentinels > 8 || (scoringExpected && scoresFound === 0)) {
    status = 'degraded';
  }

  const summary =
    status === 'ok' ? 'all healthy' :
    [
      sectionsMissing.length ? `${sectionsMissing.length} section(s) missing` : null,
      totalSentinels ? `${totalSentinels} unavailable field(s)` : null,
      !writeOk ? 'write failed' : null,
      contentLength < 500 ? 'content too short' : null
    ].filter(Boolean).join('; ') || 'see checks';

  return {
    status, summary,
    checks: { writeOk, contentLength, scoresFound, sectionsFound, sectionsMissing, totalSentinels, sentinelHits }
  };
}

// Append the new entry to data/health-log.json, capped to last 30. Defensive:
// any failure here is swallowed so it can NEVER break the analysis save.
async function appendHealthLog(entry) {
  try {
    const log = (await readFile('data/health-log.json')) || [];
    const arr = Array.isArray(log) ? log : [];
    arr.push(entry);
    const capped = arr.slice(-30);
    await writeFile('data/health-log.json', capped);
  } catch (e) {
    // swallow — monitoring must never take down the thing it monitors
  }
}
// ──────────────────────── end CP6 helpers ────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: read analysis ──
  if (req.method === 'GET') {
    const { date, type, week, month, nickname } = req.query;
    const nick = nickname || null;

    // Specific type requested
    if (type) {
      // ── Multi-day fetch: ?type=daily&days=N returns last N daily analyses concatenated ──
      const days = parseInt(req.query.days);
      if (type === 'daily' && days > 1 && days <= 14) {
        const results = [];
        const baseDate = new Date(Date.now() + 4 * 3600 * 1000); // UAE time
        for (let i = 0; i < days; i++) {
          const d = new Date(baseDate.getTime() - i * 86400000);
          const dateStr = d.toISOString().slice(0, 10);
          const p = nick
            ? `data/analysis-daily-${nick}-${dateStr}.json`
            : `data/analysis-daily-rashed-${dateStr}.json`;
          const data = await readFile(p);
          if (data && data.content) {
            results.push(`═══ DAILY ANALYSIS — ${dateStr} ═══\n${data.content}\n═══ END ${dateStr} ═══`);
          }
        }
        if (!results.length) return res.json({ error: 'No daily analyses found' });
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(results.reverse().join('\n\n'));
      }

      // ── Single file fetch (existing behaviour) ──
      const path = getFilePath(type, date, week, month, nick);
      const data = await readFile(path);
      if (data) return res.json(data);
      if (nick) {
        const fallbackPath = getFilePath(type, date, week, month, null);
        const fallback = await readFile(fallbackPath);
        if (fallback) return res.json(fallback);
      }
      return res.json({ error: 'Not found' });
    }

    // Default: return all 3 types for dashboard
    const today = date || new Date().toISOString().slice(0, 10);

    // Daily — no fallback between users
    let dailyData = null;
    for (let i = 0; i <= 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const data = nick
        ? await readFile(`data/analysis-daily-${nick}-${dateStr}.json`)
        : await readFile(`data/analysis-daily-${dateStr}.json`);
      if (data) { dailyData = data; break; }
    }

    // Weekly — no fallback between users
    let weeklyData = null;
    for (let i = 0; i <= 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const w = d.toISOString().slice(0, 7);
      if (nick) {
        const data = await readFile(`data/analysis-weekly-${nick}-${w}.json`);
        if (data) { weeklyData = data; break; }
      } else {
        const data = await readFile(`data/analysis-weekly-${w}.json`);
        if (data) { weeklyData = data; break; }
      }
    }

    // Monthly — no fallback between users
    let monthlyData = null;
    for (let i = 0; i <= 2; i++) {
      const d = new Date(today);
      d.setMonth(d.getMonth() - i);
      const m = d.toISOString().slice(0, 7);
      if (nick) {
        const data = await readFile(`data/analysis-monthly-${nick}-${m}.json`);
        if (data) { monthlyData = data; break; }
      } else {
        const data = await readFile(`data/analysis-monthly-${m}.json`);
        if (data) { monthlyData = data; break; }
      }
    }

    return res.json({ daily: dailyData, weekly: weeklyData, monthly: monthlyData, date: today });
  }

  // ── POST: save analysis ──
  if (req.method === 'POST') {
    const authHeader = req.headers['authorization'];
    const key = authHeader?.replace('Bearer ', '') || req.body?.api_key;
    if (!API_KEY || key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });

    let { type, date, week, month, content, generated, nickname, scenario, scenarioTitle, dataQuality } = req.body;
    if (!content) return res.status(400).json({ error: 'No content' });

    // Sanitize content
    if (typeof content === 'string' && content.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(content);
        if (parsed.text) content = parsed.text;
        else if (parsed.content) content = parsed.content;
      } catch(e) { /* keep as is */ }
    }
    if (Array.isArray(content)) {
      content = content.map(c => c.text || c).join('');
    }

    // Content length guard — reject empty/garbage responses before they overwrite good analysis
    const contentStr = typeof content === 'string' ? content : String(content);
    if (contentStr.trim().length < 500) {
      try {
        await appendHealthLog({ ts: new Date().toISOString(), type: type || 'daily', nickname: nickname || null, status: 'failed', note: `rejected: content too short (${contentStr.trim().length} chars)`, checks: { writeOk: false, contentLength: contentStr.trim().length } });
      } catch(e) { /* never block the response */ }
      return res.status(422).json({
        success: false,
        reason: 'rejected: content too short',
        length: contentStr.trim().length
      });
    }
    content = contentStr;

    const nick = nickname || null;
    const path = getFilePath(type || 'daily', date, week, month, nick);
    const data = {
      type:      type || 'daily',
      date:      date || new Date().toISOString().slice(0, 10),
      nickname:  nick || null,
      content,
      generated: generated || new Date().toISOString(),
      ...(scenario      ? { scenario }      : {}),
      ...(scenarioTitle ? { scenarioTitle } : {}),
      ...(dataQuality   ? { dataQuality }   : {})
    };

    let ok = await writeFile(path, data);

    // ── CP4 — Write-back verification (Contents API — always fresh, no CDN cache) ──
    // Reads the file back via GitHub Contents API immediately after writeFile()
    // to confirm the write actually landed. If missing or empty → force ok=false
    // so CP6 reports 'failed' and Make.com alert fires.
    // Uses Contents API (not raw.githubusercontent.com) for guaranteed freshness.
    let writeVerified = false;
    try {
      const GITHUB_TOKEN = TOKEN;
      const REPO = 'ralyafei-source/theisilabs-portfolio';
      const contentsUrl = `https://api.github.com/repos/${REPO}/contents/${path}`;
      const vController = new AbortController();
      const vTimer = setTimeout(() => vController.abort(), 8000);
      const vRes = await fetch(contentsUrl, {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'theisilabs-portfolio'
        },
        signal: vController.signal
      });
      clearTimeout(vTimer);
      if (vRes.ok) {
        const vData = await vRes.json();
        // Contents API returns base64-encoded content — check it exists and has size
        writeVerified = !!(vData && vData.size > 10);
      }
    } catch { writeVerified = false; }

    // If writeFile reported success but read-back failed → something went wrong
    if (ok && !writeVerified) {
      ok = false;  // forces CP6 buildHealth to status='failed' → Make.com alert fires
    }

    // CP6 — evaluate health, log it, attach to response (defensive: never throw)
    let health = null;
    try {
      health = buildHealth(content, type, ok);
      await appendHealthLog({
        ts: new Date().toISOString(),
        type: type || 'daily',
        nickname: nick || null,
        status: health.status,
        checks: health.checks,
        note: health.summary,
        ...(scenario    ? { scenario }    : {}),
        ...(dataQuality ? { dataQuality } : {})
      });
    } catch (e) {
      health = { status: 'unknown', summary: 'health check error', checks: {} };
    }

    if (ok) return res.json({ success: true, path, health, nickname: nick });
    return res.status(500).json({ error: 'Failed to save', health });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
