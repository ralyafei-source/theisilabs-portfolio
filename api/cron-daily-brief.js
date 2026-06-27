module.exports = async (req, res) => {
  try {
    const base = `https://${req.headers.host}`;
    const r = await fetch(`${base}/api/sa-analyze`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ dailyRead:true, forceRefresh:true })
    });
    const d = await r.json();
    return res.status(200).json({ ok:true, generated_at:d.generated_at||null });
  } catch(e){ return res.status(500).json({ ok:false, error:e.message }); }
};
