
// ── Health tab functions (CP6 dashboard viewer) ──────────────────────────────

let _hlLogs = [];
let _hlFilter = 'all';

function revealHealthTab() {
  const t = document.getElementById('healthNavTab');
  if (t) t.style.display = '';
}

function hlFilter(status, btn) {
  _hlFilter = status;
  document.querySelectorAll('.t-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  _hlRender();
}

function _hlToUAE(ts) {
  try {
    return new Date(ts).toLocaleString('en-GB', {
      timeZone: 'Asia/Dubai', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit'
    });
  } catch { return ts || '—'; }
}

function _hlBadge(status) {
  const map = {
    ok:       'background:#1a4a1a;color:#7dda7d',
    degraded: 'background:#4a3a0a;color:#f0c060',
    failed:   'background:#4a1a1a;color:#f07070'
  };
  const s = map[status] || 'background:var(--bg2);color:var(--text2)';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500;${s}">${status}</span>`;
}

function _hlRender() {
  const filtered = _hlFilter === 'all' ? _hlLogs : _hlLogs.filter(l => l.status === _hlFilter);
  const rows = [...filtered].reverse();
  if (!rows.length) {
    document.getElementById('healthBody').innerHTML =
      `<tr><td colspan="9" style="text-align:center;color:var(--text2);padding:30px;">No entries for this filter.</td></tr>`;
    return;
  }
  document.getElementById('healthBody').innerHTML = rows.map(l => {
    const c = l.checks || {};
    const missing = c.sectionsMissing && c.sectionsMissing.length
      ? `<div style="font-size:11px;color:var(--red);margin-top:2px;">missing: ${c.sectionsMissing.join(', ')}</div>` : '';
    const writeCell = c.writeOk === false
      ? `<span style="color:var(--red)">✗</span>`
      : `<span style="color:var(--accent2)">✓</span>`;
    const kb = c.contentLength ? Math.round(c.contentLength / 102.4) / 10 + 'k' : '—';
    const sects = c.sectionsFound ? c.sectionsFound.length + '/3' : '—';
    const unavail = c.totalSentinels || '—';
    return `<tr>
      <td style="font-family:var(--font-mono,monospace);font-size:11px;white-space:nowrap">${_hlToUAE(l.ts)}</td>
      <td style="font-size:12px">${l.type || '—'}</td>
      <td style="font-size:12px;color:var(--text2)">${l.nickname || 'rashed'}</td>
      <td>${_hlBadge(l.status)}</td>
      <td style="font-size:12px">${l.note || ''}${missing}</td>
      <td class="num" style="font-size:12px">${kb}</td>
      <td class="num" style="font-size:12px">${sects}</td>
      <td class="num" style="font-size:12px;${c.totalSentinels > 20 ? 'color:var(--red)' : c.totalSentinels > 0 ? 'color:var(--gold)' : ''}">${unavail}</td>
      <td class="num">${writeCell}</td>
    </tr>`;
  }).join('');
}

async function loadHealthLog() {
  const body = document.getElementById('healthBody');
  if (body) body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text2);padding:30px;">Loading...</td></tr>`;
  try {
    const r = await fetch(
      `https://raw.githubusercontent.com/ralyafei-source/theisilabs-portfolio/main/data/health-log.json?t=${Date.now()}`
    );
    if (!r.ok) throw new Error('fetch failed ' + r.status);
    _hlLogs = await r.json();

    // Summary cards
    const ok       = _hlLogs.filter(l => l.status === 'ok').length;
    const degraded = _hlLogs.filter(l => l.status === 'degraded').length;
    const failed   = _hlLogs.filter(l => l.status === 'failed').length;
    document.getElementById('hl-total').textContent    = _hlLogs.length;
    document.getElementById('hl-ok').textContent       = ok;
    document.getElementById('hl-degraded').textContent = degraded;
    document.getElementById('hl-failed').textContent   = failed;

    // Last run timestamp in subtitle
    if (_hlLogs.length) {
      const last = _hlLogs[_hlLogs.length - 1];
      const sub = document.getElementById('health-sub');
      if (sub) sub.textContent = `Last run: ${_hlToUAE(last.ts)} — ${_hlLogs.length} entries`;
    }

    _hlRender();
  } catch(e) {
    if (body) body.innerHTML =
      `<tr><td colspan="9" style="text-align:center;color:var(--red);padding:30px;">Could not load health log: ${e.message}</td></tr>`;
  }
}
