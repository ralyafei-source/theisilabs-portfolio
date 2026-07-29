/* ============================================================================
   THEISI — نبض السوق card for the Command Center (index.html)
   ----------------------------------------------------------------------------
   INSTALL (inside index.html, in the Command-center render scope where the
   other cards like pulse/movers/news are built):

   STEP 1 — paste the three helpers below (mpColor / mpSkeleton / mpRenderHtml
            / window.loadPulse) somewhere before the "var bento = ..." assembly.

   STEP 2 — add a default tile size next to the other _gsDefaults entries:
            _gsDefaults.mpulse = { x:0, y:20, w:4, h:7 };

   STEP 3 — add ONE item to the bento string (near +gsItem('movers',...)):
            +gsItem('mpulse', panel('<div id="mpBody">'+mpSkeleton()+'</div>',
                 {style:'flex:1;display:flex;flex-direction:column;background:var(--bg2);border-color:rgba(255,10,120,.25);'}))

   STEP 4 — after the bento is inserted into the DOM (end of the Command render),
            trigger the first load:
            try { window.loadPulse(false); } catch(e){}

   The endpoint is the standalone function:
   POST /api/market-pulse  body { nickname, forceRefresh }
   ============================================================================ */

var MP_ENDPOINT = '/api/market-pulse';

function mpColor(v){ return v==null ? 'var(--text3)' : (v>=0 ? 'var(--up,#12b886)' : 'var(--down,#ff4d67)'); }
function mpSign(v){ return v>=0 ? '+' : ''; }
function mpEsc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

function mpSkeleton(){
  return '<div style="display:flex;flex-direction:column;gap:8px;opacity:.55;">'
    + '<div style="height:12px;width:55%;background:var(--border);border-radius:4px;"></div>'
    + '<div style="height:10px;width:80%;background:var(--border);border-radius:4px;"></div>'
    + '<div style="height:10px;width:70%;background:var(--border);border-radius:4px;"></div>'
    + '<div style="font-size:11px;color:var(--text3);margin-top:4px;">جاري تحليل السوق…</div></div>';
}

function mpRenderHtml(d){
  if(!d || d.error){ return '<div style="font-size:12px;color:var(--text3);">تعذّر تحميل نبض السوق. جرّب التحديث.</div>'; }
  var name = d.footer ? d.footer.replace('القرار في النهاية عندك يا ','') : '';

  // session label — so intraday numbers aren't read as final
  var intraday = (d.session === 'intraday');
  var sessTxt = intraday ? 'خلال الجلسة' : 'إغلاق';
  var sessCol = intraday ? '#e0a021' : 'var(--text3)';
  var sessPill = '<span style="font-size:9.5px;border:1px solid '+sessCol+';color:'+sessCol
    + ';border-radius:999px;padding:1px 7px;margin-inline-start:6px;">'+sessTxt+'</span>';

  // header + refresh
  var head = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">'
    + '<div class="cc-sec-label" style="color:var(--rose,#FF0A78);">نبض السوق الآن'+sessPill+'</div>'
    + '<button onclick="window.loadPulse(true)" title="تحديث" '
    + 'style="background:none;border:1px solid var(--border);border-radius:8px;color:var(--text2);'
    + 'font-size:11px;padding:3px 9px;cursor:pointer;">↻ تحديث</button></div>';

  // market strip (indices)
  var MP_IDX_LABEL = { SPY:'S&P 500', QQQ:'ناسداك 100', DIA:'داو جونز' };
  var strip = '<div style="display:flex;gap:14px;flex-wrap:wrap;direction:ltr;justify-content:flex-end;margin-bottom:8px;">'
    + (d.market||[]).map(function(m){
        return '<span style="font-family:\'IBM Plex Mono\',monospace;font-size:12px;" title="'+mpEsc(MP_IDX_LABEL[m.sym]||m.sym)+'">'
          + mpEsc(m.sym)+' <b style="color:'+mpColor(m.dayPct)+';">'+mpSign(m.dayPct)+m.dayPct+'%</b></span>';
      }).join('') + '</div>';

  // WHAT
  var what = d.what ? '<div style="font-size:12.5px;line-height:1.9;color:var(--text);margin-bottom:10px;">'+mpEsc(d.what)+'</div>' : '';

  // WHY — per mover
  var byMover = {}; (d.movers||[]).forEach(function(m){ byMover[m.sym]=m; });
  var why = '';
  if((d.why||[]).length){
    why = '<div style="border-top:1px solid var(--border);padding-top:8px;margin-bottom:8px;">'
      + (d.why||[]).map(function(w){
          var m = byMover[w.sym]||{};
          var pct = (m.dayPct!=null) ? '<b style="color:'+mpColor(m.dayPct)+';direction:ltr;unicode-bidi:isolate;">'+mpSign(m.dayPct)+m.dayPct+'%</b>' : '';
          return '<div style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;">'
            + '<span style="font-family:\'IBM Plex Mono\',monospace;font-size:12px;font-weight:700;direction:ltr;unicode-bidi:isolate;min-width:64px;text-align:right;">'
            + mpEsc(w.sym)+' '+pct+'</span>'
            + '<span style="font-size:11.5px;line-height:1.75;color:var(--text2);flex:1;">'+mpEsc(w.text)+'</span></div>';
        }).join('') + '</div>';
  }

  // SO WHAT
  var so = d.so_what ? '<div style="font-size:12px;line-height:1.9;color:var(--text2);background:var(--bg);border-radius:10px;padding:9px 11px;margin-bottom:8px;"><b style="color:var(--rose,#FF0A78);font-size:11px;">ماذا يعني</b><br>'+mpEsc(d.so_what)+'</div>' : '';

  // WATCH pills
  var watch = (d.watch||[]).length
    ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">'
      + (d.watch||[]).map(function(w){ return '<span style="font-size:10.5px;background:var(--bg);border:1px solid var(--border);border-radius:999px;padding:3px 9px;color:var(--text2);">'+mpEsc(w)+'</span>'; }).join('')
      + '</div>'
    : '';

  var foot = '<div style="font-size:10px;color:var(--text3);border-top:1px solid var(--border);padding-top:7px;margin-top:2px;">'
    + mpEsc(d.footer||'') + ' · ' + mpEsc(d.disclaimer||'') + ' · ' + mpEsc(d.generated_at||'')
    + (d.cached ? ' · مخزّن' : '') + '</div>';

  return head + strip + what + why + so + watch + foot;
}

window._mpulse = window._mpulse || null;

// Auto-load: polls up to 10s for the card to appear in the DOM, then fills it.
// If cached data already exists (tab re-entry), it renders instantly first.
(function mpAutoInit(){
  var tries = 0;
  var t = setInterval(function(){
    var el = document.getElementById('mpBody');
    if(el){
      clearInterval(t);
      if(window._mpulse){ el.innerHTML = mpRenderHtml(window._mpulse); }
      else { window.loadPulse(false); }
    } else if(++tries > 40){ clearInterval(t); }
  }, 250);
})();

window.loadPulse = function(force){
  var el = document.getElementById('mpBody');
  if(el && force) el.innerHTML = mpSkeleton();
  var nick = (window.currentNickname || window._nickname || 'rashed');
  fetch(MP_ENDPOINT, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ mode:'pulse', nickname: nick, forceRefresh: !!force })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){ window._mpulse = d; var b=document.getElementById('mpBody'); if(b) b.innerHTML = mpRenderHtml(d); })
  .catch(function(){ var b=document.getElementById('mpBody'); if(b) b.innerHTML = mpRenderHtml({error:true}); });
};
