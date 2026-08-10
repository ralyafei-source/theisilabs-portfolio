// api/notes.js
// Per-user stock notes (investment thesis + price target + free note).
// Stored at data/notes-{nickname}.json in the GitHub repo — one file per user.
// GET  /api/notes                 → { notes: { SYM: {thesis,target,note,updatedAt}, ... } }
// POST /api/notes  body:
//   { sym, thesis?, target?, note? }   → upsert one ticker (fields omitted are left unchanged)
//   { sym, delete:true }               → remove one ticker
// Auth: Bearer session token (same as the rest of the app).

const https = require('https');
const { verifySession } = require('./_auth');

const REPO = 'ralyafei-source/theisilabs-portfolio';

// ── Validation caps ────────────────────────────────────────────────
const THESIS_CAP = 2000;
const NOTE_CAP   = 2000;
const SAVE_COOLDOWN_MS = 3000;

function ghGet(path, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${REPO}/contents/${path}`,
      headers: { 'Authorization': `token ${token}`, 'User-Agent': 'theisilabs-app' }
    };
    https.get(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.defineProperty(parsed, '_statusCode', { value: res.statusCode, enumerable: false });
          }
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function ghWrite(path, content, sha, token) {
  return new Promise((resolve, reject) => {
    const payload = {
      message: `${sha ? 'Update' : 'Create'} ${path}`,
      content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64')
    };
    if (sha) payload.sha = sha;
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${REPO}/contents/${path}`,
      method: 'PUT',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'theisilabs-app',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.defineProperty(parsed, '_statusCode', { value: res.statusCode, enumerable: false });
          }
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Normalize a POST body into an action. Returns {ok, sym, patch, del} or {ok:false, message}.
function validateBody(body) {
  if (!body || typeof body !== 'object') return { ok: false, message: 'Invalid body' };
  let sym = (body.sym || '').toString().toUpperCase().trim();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym)) return { ok: false, message: 'Invalid symbol' };

  if (body.delete === true) return { ok: true, sym, del: true };

  const patch = {};
  if ('thesis' in body) {
    if (body.thesis == null) patch.thesis = '';
    else if (typeof body.thesis !== 'string') return { ok: false, message: 'thesis must be text' };
    else patch.thesis = body.thesis.trim().slice(0, THESIS_CAP);
  }
  if ('note' in body) {
    if (body.note == null) patch.note = '';
    else if (typeof body.note !== 'string') return { ok: false, message: 'note must be text' };
    else patch.note = body.note.trim().slice(0, NOTE_CAP);
  }
  if ('target' in body) {
    if (body.target === '' || body.target == null) patch.target = null;
    else {
      const n = Number(body.target);
      if (!Number.isFinite(n) || n < 0 || n >= 1e9) return { ok: false, message: 'target must be a number 0–1,000,000,000' };
      patch.target = n;
    }
  }
  if (Object.keys(patch).length === 0) return { ok: false, message: 'Nothing to save' };
  return { ok: true, sym, patch };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const githubToken = process.env.GITHUB_TOKEN;

  let user;
  try {
    user = await verifySession(req, githubToken);
  } catch (e) {
    return res.status(500).json({ error: 'Auth check failed' });
  }
  if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

  const nick = (user.nickname || '').toLowerCase().trim();
  if (!nick) return res.status(400).json({ error: 'No nickname on account' });
  const filePath = `data/notes-${nick}.json`;

  // ── GET: return all notes for this user ──
  if (req.method === 'GET') {
    try {
      const f = await ghGet(filePath, githubToken);
      if (f && f.content) {
        const data = JSON.parse(Buffer.from(f.content, 'base64').toString());
        return res.status(200).json({ notes: data.notes || {} });
      }
      return res.status(200).json({ notes: {} });
    } catch (e) {
      return res.status(200).json({ notes: {} });
    }
  }

  // ── POST: upsert / delete one ticker (read-modify-write with SHA retry) ──
  if (req.method === 'POST') {
    const v = validateBody(req.body || {});
    if (!v.ok) return res.status(400).json({ ok: false, message: v.message, error: v.message });

    const MAX_RETRIES = 2;
    let lastCode = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // 1. Read fresh
      let existing = null;
      try { existing = await ghGet(filePath, githubToken); } catch (e) { existing = null; }
      let fileObj = { nickname: nick, notes: {}, lastUpdated: null };
      let sha = null;
      if (existing && existing.content) {
        try { fileObj = JSON.parse(Buffer.from(existing.content, 'base64').toString()); } catch (e) {}
        sha = existing.sha;
        if (!fileObj.notes || typeof fileObj.notes !== 'object') fileObj.notes = {};
      }

      // 2. Light rate limit
      if (fileObj.lastUpdated) {
        const elapsed = Date.now() - Date.parse(fileObj.lastUpdated);
        if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < SAVE_COOLDOWN_MS) {
          return res.status(429).json({ ok: false, message: 'Please wait a moment before saving again' });
        }
      }

      // 3. Apply
      const now = new Date().toISOString();
      if (v.del) {
        delete fileObj.notes[v.sym];
      } else {
        const prev = fileObj.notes[v.sym] || {};
        const merged = { ...prev, ...v.patch, updatedAt: now };
        // Drop the ticker entirely if everything is now empty
        const empty = (!merged.thesis) && (!merged.note) && (merged.target == null);
        if (empty) delete fileObj.notes[v.sym];
        else fileObj.notes[v.sym] = merged;
      }
      fileObj.nickname = nick;
      fileObj.lastUpdated = now;

      // 4. Write with optimistic lock
      const w = await ghWrite(filePath, fileObj, sha, githubToken);
      lastCode = w && w._statusCode;
      if (lastCode === 200 || lastCode === 201) {
        return res.status(200).json({ ok: true, notes: fileObj.notes });
      }
      if (lastCode === 409 || lastCode === 422) continue; // stale SHA / create race → retry
      break;
    }

    const failMsg = "Couldn't save — please try again";
    const code = (lastCode === 409 || lastCode === 422) ? 409 : 500;
    return res.status(code).json({ ok: false, message: failMsg, error: failMsg });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
