// ═══════════════════════════════════════════════════════════════
// EXTENDED BACKTEST UI — paste this into index.html
// Add AFTER the existing initBacktestPanel() function
// ═══════════════════════════════════════════════════════════════

// ─── Load existing extended results from GitHub ───────────────
async function loadExtendedResults() {
  try {
    const r = await fetch(
      `https://raw.githubusercontent.com/ralyafei-source/theisilabs-portfolio/main/data/backtest-extended.json?t=${Date.now()}`
    );
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ─── Render the extended backtest section ─────────────────────
async function renderExtendedBacktest() {
  const container = document.getElementById('bt-extended');
  if (!container) return;

  container.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text3);font-size:12px;">⏳ جاري تحميل النتائج السابقة...</div>`;

  const data = await loadExtendedResults();

  if (!data || !data.runs?.length) {
    container.innerHTML = `
      <div style="text-align:center;padding:20px;color:var(--text3);font-size:12px;">
        لا توجد نتائج بعد — اضغط الزر أعلاه لبدء الاختبار الموسّع
      </div>`;
    return;
  }

  renderExtendedCharts(container, data);
}

// ─── Render charts from stored data ───────────────────────────
function renderExtendedCharts(container, data) {
  const runs    = data.runs.filter(r => r.accuracy?.['1m']?.pct != null);
  const labels  = runs.map(r => r.date.slice(5)); // MM-DD
  const acc1w   = runs.map(r => r.accuracy?.['1w']?.pct ?? null);
  const acc2w   = runs.map(r => r.accuracy?.['2w']?.pct ?? null);
  const acc1m   = runs.map(r => r.accuracy?.['1m']?.pct ?? null);
  const acc3m   = runs.map(r => r.accuracy?.['3m']?.pct ?? null);
  const acc6m   = runs.map(r => r.accuracy?.['6m']?.pct ?? null);

  // Signal timing: for تراكم signals, avg days to +5%
  const buyTimings = [];
  const sellTimings = [];
  const HORIZONS = [
    { label: '1w', days: 7 },
    { label: '2w', days: 14 },
    { label: '1m', days: 30 },
    { label: '3m', days: 90 },
    { label: '6m', days: 180 }
  ];
  data.runs.forEach(run => {
    (run.signals || []).forEach(sig => {
      for (const h of HORIZONS) {
        const v = sig.horizons?.[h.label];
        if (v?.verdict === 'correct') {
          if (sig.rec === 'تراكم') buyTimings.push(h.days);
          if (sig.rec === 'بيع')   sellTimings.push(h.days);
          break; // first horizon where it's correct
        }
      }
    });
  });

  const avgBuyDays  = buyTimings.length  ? Math.round(buyTimings.reduce((a,b)=>a+b,0)  / buyTimings.length)  : null;
  const avgSellDays = sellTimings.length ? Math.round(sellTimings.reduce((a,b)=>a+b,0) / sellTimings.length) : null;

  // Overall stats
  const allJudged  = data.runs.flatMap(r => (r.signals||[]).filter(s => ['تراكم','بيع'].includes(s.rec)));
  const correct1m  = allJudged.filter(s => s.horizons?.['1m']?.verdict === 'correct').length;
  const total1m    = allJudged.filter(s => s.horizons?.['1m']?.verdict !== 'pending' && s.horizons?.['1m']?.verdict !== 'unknown').length;
  const overall1m  = total1m ? Math.round(correct1m / total1m * 100) : null;

  // Stock hit rate
  const stockStats = {};
  data.runs.forEach(run => {
    (run.signals||[]).forEach(sig => {
      if (!['تراكم','بيع'].includes(sig.rec)) return;
      if (!stockStats[sig.sym]) stockStats[sig.sym] = { correct: 0, total: 0 };
      const v = sig.horizons?.['1m']?.verdict;
      if (v === 'correct') { stockStats[sig.sym].correct++; stockStats[sig.sym].total++; }
      else if (v === 'wrong') { stockStats[sig.sym].total++; }
    });
  });
  const stockRates = Object.entries(stockStats)
    .filter(([,s]) => s.total >= 3)
    .map(([sym,s]) => ({ sym, pct: Math.round(s.correct/s.total*100), total: s.total }))
    .sort((a,b) => b.pct - a.pct);

  container.innerHTML = `
    <!-- ── Summary cards ── -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:24px;">
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px;text-align:center;">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px;">أسابيع مختبرة</div>
        <div style="font-size:28px;font-weight:700;color:var(--gold);">${data.totalRuns}</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px;text-align:center;">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px;">دقة شهر واحد</div>
        <div style="font-size:28px;font-weight:700;color:${overall1m >= 70 ? 'var(--green)' : overall1m >= 50 ? 'var(--gold)' : 'var(--rose)'};">${overall1m ?? '—'}%</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px;text-align:center;">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px;">متوسط أيام تراكم ✅</div>
        <div style="font-size:28px;font-weight:700;color:var(--green);">${avgBuyDays ?? '—'}</div>
        <div style="font-size:10px;color:var(--text3);">يوم حتى +5%</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px;text-align:center;">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px;">متوسط أيام بيع ✅</div>
        <div style="font-size:28px;font-weight:700;color:var(--rose);">${avgSellDays ?? '—'}</div>
        <div style="font-size:10px;color:var(--text3);">يوم حتى -5%</div>
      </div>
    </div>

    <!-- ── Accuracy trend chart ── -->
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px;">
      <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:12px;">📈 منحنى الدقة عبر الزمن</div>
      <div style="font-size:10px;color:var(--text3);margin-bottom:8px;">الدقة % لكل أسبوع مختبر — عند أفق 1 شهر</div>
      <canvas id="bt-trend-chart" height="200"></canvas>
    </div>

    <!-- ── Multi-horizon accuracy bars ── -->
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px;">
      <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:12px;">⏱️ الدقة حسب أفق الزمن</div>
      <div style="font-size:10px;color:var(--text3);margin-bottom:12px;">كلما طال الأفق — هل النظام أدق؟</div>
      <div id="bt-horizon-bars"></div>
    </div>

    <!-- ── Per-stock hit rate ── -->
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px;">
      <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:12px;">🎯 دقة النظام لكل سهم (أفق شهر)</div>
      <div style="font-size:10px;color:var(--text3);margin-bottom:12px;">الأسهم التي ظهرت 3 مرات أو أكثر فقط</div>
      <div id="bt-stock-rates"></div>
    </div>

    <!-- ── Raw data table ── -->
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px;">
      <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:12px;">📋 سجل الأسابيع المختبرة</div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:11px;direction:rtl;">
          <thead>
            <tr style="color:var(--text3);border-bottom:1px solid var(--border);">
              <th style="padding:6px 8px;text-align:right;">التاريخ</th>
              <th style="padding:6px 8px;text-align:center;">إشارات</th>
              <th style="padding:6px 8px;text-align:center;">1 أسبوع</th>
              <th style="padding:6px 8px;text-align:center;">2 أسبوع</th>
              <th style="padding:6px 8px;text-align:center;">1 شهر</th>
              <th style="padding:6px 8px;text-align:center;">3 أشهر</th>
              <th style="padding:6px 8px;text-align:center;">6 أشهر</th>
            </tr>
          </thead>
          <tbody>
            ${data.runs.map(run => {
              const a = run.accuracy || {};
              const cell = (h) => {
                const d = a[h];
                if (!d || d.pct == null) return '<td style="padding:6px 8px;text-align:center;color:var(--text3);">—</td>';
                const col = d.pct >= 70 ? 'var(--green)' : d.pct >= 50 ? 'var(--gold)' : 'var(--rose)';
                return `<td style="padding:6px 8px;text-align:center;color:${col};font-weight:600;">${d.pct}% <span style="color:var(--text3);font-weight:400;">(${d.correct}/${d.total})</span></td>`;
              };
              return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                <td style="padding:6px 8px;font-family:'IBM Plex Mono',monospace;">${run.date}</td>
                <td style="padding:6px 8px;text-align:center;color:var(--text2);">${run.signalCount || '—'}</td>
                ${cell('1w')}${cell('2w')}${cell('1m')}${cell('3m')}${cell('6m')}
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Draw trend line chart using Canvas
  setTimeout(() => {
    const canvas = document.getElementById('bt-trend-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.offsetWidth; canvas.width = W; canvas.height = 200;
    const pad = { top: 20, right: 20, bottom: 30, left: 40 };
    const w = W - pad.left - pad.right;
    const h = 200 - pad.top - pad.bottom;

    ctx.clearRect(0, 0, W, 200);

    // Grid lines
    [0,25,50,75,100].forEach(pct => {
      const y = pad.top + h - (pct/100)*h;
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left+w, y); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '9px monospace';
      ctx.fillText(pct+'%', 2, y+3);
    });

    // Draw each horizon line
    const horizons = [
      { data: acc1w,  color: 'rgba(99,179,237,0.5)',  label: '1w' },
      { data: acc2w,  color: 'rgba(129,140,248,0.5)', label: '2w' },
      { data: acc1m,  color: '#38BDF8',               label: '1m' },
      { data: acc3m,  color: '#34D399',               label: '3m' },
      { data: acc6m,  color: '#F59E0B',               label: '6m' }
    ];

    horizons.forEach(({ data: hData, color, label }) => {
      const pts = hData.map((v,i) => ({
        x: pad.left + (i/(labels.length-1||1))*w,
        y: v != null ? pad.top + h - (v/100)*h : null
      }));
      ctx.strokeStyle = color;
      ctx.lineWidth = label === '1m' ? 2.5 : 1.5;
      ctx.beginPath();
      let started = false;
      pts.forEach(p => {
        if (p.y == null) { started = false; return; }
        if (!started) { ctx.moveTo(p.x, p.y); started = true; }
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
      // Dots for 1m only
      if (label === '1m') {
        pts.forEach(p => {
          if (p.y == null) return;
          ctx.fillStyle = color;
          ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI*2); ctx.fill();
        });
      }
    });

    // X axis labels (every 4 weeks)
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '9px monospace';
    labels.forEach((l,i) => {
      if (i % 4 !== 0) return;
      const x = pad.left + (i/(labels.length-1||1))*w;
      ctx.fillText(l, x-10, 200-8);
    });

    // Legend
    const legendItems = [
      { color: 'rgba(99,179,237,0.7)', label: '1 أسبوع' },
      { color: '#38BDF8',              label: '1 شهر' },
      { color: '#34D399',              label: '3 أشهر' },
      { color: '#F59E0B',              label: '6 أشهر' }
    ];
    legendItems.forEach(({ color, label }, i) => {
      const lx = pad.left + i * 80;
      ctx.fillStyle = color;
      ctx.fillRect(lx, 5, 14, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '9px sans-serif';
      ctx.fillText(label, lx + 18, 9);
    });
  }, 100);

  // Horizon bars
  const hBars = document.getElementById('bt-horizon-bars');
  if (hBars) {
    const horizonAvg = {};
    ['1w','2w','1m','3m','6m'].forEach(h => {
      const vals = data.runs.map(r => r.accuracy?.[h]?.pct).filter(v => v != null);
      horizonAvg[h] = vals.length ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length) : null;
    });
    hBars.innerHTML = [
      { key: '1w', label: 'أسبوع واحد' },
      { key: '2w', label: 'أسبوعان' },
      { key: '1m', label: 'شهر واحد' },
      { key: '3m', label: '3 أشهر' },
      { key: '6m', label: '6 أشهر' }
    ].map(({ key, label }) => {
      const pct = horizonAvg[key];
      if (pct == null) return '';
      const col = pct >= 70 ? 'var(--green)' : pct >= 50 ? 'var(--gold)' : 'var(--rose)';
      return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <div style="width:70px;font-size:11px;color:var(--text2);text-align:right;">${label}</div>
        <div style="flex:1;background:rgba(255,255,255,0.06);border-radius:4px;height:20px;overflow:hidden;">
          <div style="width:${pct}%;background:${col};height:100%;border-radius:4px;transition:width 0.6s;"></div>
        </div>
        <div style="width:40px;font-size:12px;font-weight:700;color:${col};">${pct}%</div>
      </div>`;
    }).join('');
  }

  // Stock hit rate bars
  const sBars = document.getElementById('bt-stock-rates');
  if (sBars && stockRates.length) {
    sBars.innerHTML = stockRates.slice(0, 15).map(({ sym, pct, total }) => {
      const col = pct >= 70 ? 'var(--green)' : pct >= 50 ? 'var(--gold)' : 'var(--rose)';
      return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <div style="width:55px;font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--text);text-align:right;">${sym}</div>
        <div style="flex:1;background:rgba(255,255,255,0.06);border-radius:4px;height:16px;overflow:hidden;">
          <div style="width:${pct}%;background:${col};height:100%;border-radius:4px;"></div>
        </div>
        <div style="width:45px;font-size:11px;font-weight:600;color:${col};">${pct}% <span style="color:var(--text3);font-weight:400;">(${total}x)</span></div>
      </div>`;
    }).join('');
  }
}

// ─── Run the extended backtest ─────────────────────────────────
async function runExtendedBacktest() {
  const btn      = document.getElementById('bt-extended-btn');
  const progress = document.getElementById('bt-extended-progress');
  const container = document.getElementById('bt-extended');

  btn.disabled = true;
  btn.textContent = '⏳ جاري الاختبار...';
  progress.style.display = 'block';

  const weeks   = parseInt(document.getElementById('bt-weeks-input')?.value || '30');
  const endDate = document.getElementById('bt-end-date-input')?.value || null;

  const progressLog  = document.getElementById('bt-progress-log');
  const progressBar  = document.getElementById('bt-progress-fill');
  const progressText = document.getElementById('bt-progress-text');

  progressLog.innerHTML = '';

  try {
    const resp = await fetch('/api/backtest-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weeks, endDate, nickname: 'rashed' })
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));

          if (event.type === 'start') {
            progressText.textContent = `0 / ${event.total} أسبوع`;
          }
          else if (event.type === 'progress' || event.type === 'skip') {
            const pct = Math.round((event.index / event.total) * 100);
            progressBar.style.width = pct + '%';
            progressText.textContent = `${event.index} / ${event.total} أسبوع`;
            const statusText = event.type === 'skip' ? '(موجود مسبقاً)' :
              event.status === 'done' ? `✅ دقة 1م: ${event.accuracy?.pct ?? '—'}%` :
              event.status === 'failed' ? '❌ فشل' : '⏳ يُحلل...';
            const logLine = document.createElement('div');
            logLine.style.cssText = 'font-size:10px;color:var(--text3);margin-bottom:2px;font-family:monospace;';
            logLine.textContent = `${event.date}  ${statusText}`;
            progressLog.appendChild(logLine);
            progressLog.scrollTop = progressLog.scrollHeight;
          }
          else if (event.type === 'complete') {
            progressBar.style.width = '100%';
            progressText.textContent = `✅ اكتمل — ${event.newRuns} أسبوع جديد، ${event.totalRuns} إجمالي`;
            btn.textContent = '✅ اكتمل';
            // Reload charts
            await renderExtendedBacktest();
          }
          else if (event.type === 'error') {
            progressText.textContent = `❌ خطأ: ${event.message}`;
            btn.disabled = false;
            btn.textContent = '▶ اختبار 30 أسبوعاً';
          }
        } catch {}
      }
    }
  } catch (e) {
    progressText.textContent = `❌ ${e.message}`;
  }

  btn.disabled = false;
  if (btn.textContent !== '✅ اكتمل') btn.textContent = '▶ اختبار 30 أسبوعاً';
}

// ─── HTML to inject into the backtest panel (add after bt-results div) ────────
/*
ADD THIS HTML inside initBacktestPanel(), after the bt-results div:

<div style="margin-top:32px;border-top:1px solid var(--border);padding-top:24px;">
  <div style="font-size:13px;font-weight:700;color:var(--gold);margin-bottom:6px;">📊 اختبار الدقة الموسّع — 30 أسبوعاً</div>
  <div style="font-size:11.5px;color:var(--text2);margin-bottom:16px;line-height:1.6;">
    يختبر النظام على 30 أسبوعاً متتالياً ويقيس الدقة عند أفق 1 أسبوع، 2 أسبوع، 1 شهر، 3 أشهر، 6 أشهر.<br>
    يستغرق ~25 دقيقة ويكلف ~$3 في API. النتائج تُحفظ تلقائياً ولا تحتاج لإعادة تشغيله.
  </div>
  <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px;">
    <div>
      <div style="font-size:10px;color:var(--text3);margin-bottom:4px;">عدد الأسابيع</div>
      <input type="number" id="bt-weeks-input" value="30" min="4" max="52"
        style="width:80px;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 10px;font-size:12px;">
    </div>
    <div>
      <div style="font-size:10px;color:var(--text3);margin-bottom:4px;">تاريخ النهاية (اختياري)</div>
      <input type="date" id="bt-end-date-input"
        style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 10px;font-size:12px;">
    </div>
    <button id="bt-extended-btn" onclick="runExtendedBacktest()"
      style="padding:9px 20px;background:rgba(186,117,23,0.2);border:1px solid var(--gold);color:var(--gold);border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;font-family:'Almarai',sans-serif;">
      ▶ اختبار 30 أسبوعاً
    </button>
  </div>

  <!-- Progress -->
  <div id="bt-extended-progress" style="display:none;margin-bottom:16px;">
    <div style="background:rgba(255,255,255,0.06);border-radius:6px;height:6px;margin-bottom:6px;overflow:hidden;">
      <div id="bt-progress-fill" style="width:0%;height:100%;background:var(--gold);transition:width 0.3s;border-radius:6px;"></div>
    </div>
    <div id="bt-progress-text" style="font-size:10px;color:var(--text3);margin-bottom:6px;"></div>
    <div id="bt-progress-log" style="max-height:120px;overflow-y:auto;background:var(--bg1);border-radius:6px;padding:8px;"></div>
  </div>

  <!-- Results -->
  <div id="bt-extended"></div>
</div>
*/
