module.exports = async (req, res) => {
  const base = `https://${req.headers.host}`;
  const r = await fetch(`${base}/api/sa-analyze`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ marketRead:true, forceRefresh:true })
  });
  const d = await r.json();
  return res.status(200).json({ ok:true, generated_at: d.generated_at||null });
};
