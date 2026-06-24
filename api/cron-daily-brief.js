// api/cron-daily-brief.js — Vercel cron → forces fresh daily brief + themed news
module.exports = async (req, res) => {
  try {
    const base = `https://${req.headers.host}`;
    const post = (body) => fetch(`${base}/api/sa-analyze`, {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body)
    }).then(r=>r.json()).catch(e=>({error:e.message}));

    const brief = await post({ dailyRead:true, forceRefresh:true });
    const news  = await post({ themedNews:true, forceRefresh:true });

    return res.status(200).json({ ok:true, brief:brief.generated_at||null, news:news.generated_at||null, themes:news.themes?.length||0 });
  } catch(e){ return res.status(500).json({ ok:false, error:e.message }); }
};
