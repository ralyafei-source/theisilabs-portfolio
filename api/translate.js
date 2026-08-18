// api/translate.js — Arabic⇄English translation via Claude (ANTHROPIC_API_KEY).
// Two modes:
//   { text }            → single string  → { translated }
//   { texts: [...] }    → batch array    → { translations: [...] } (same order)
// Batch mode powers the dashboard's English layer: any UI/AI text not in the
// static dictionary is translated once and cached in the browser (free after).

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'API key not configured' }); return; }

  const body = req.body || {};
  const target = body.target || 'en';
  const langWord = target === 'ar' ? 'Arabic' : 'English';

  async function callClaude(system, user, maxTokens) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
    });
    const d = await r.json();
    return (d.content && d.content[0] && d.content[0].text) || '';
  }

  try {
    // ── Batch mode ──────────────────────────────────────────────────────────
    if (Array.isArray(body.texts)) {
      const texts = body.texts.filter(t => typeof t === 'string');
      if (!texts.length) return res.json({ translations: [] });
      const system =
        `You translate short UI and financial-analysis strings for a finance dashboard to ${langWord}. ` +
        `You receive a JSON array of strings. Return ONLY a JSON array of the SAME length and order, ` +
        `each element the translation of the corresponding input. Keep stock symbols, numbers, %, $, and ` +
        `dates EXACTLY as given. Keep it concise and professional. No commentary, output valid JSON array only.`;
      const raw = await callClaude(system, JSON.stringify(texts), 8000);
      let translations = [];
      try {
        const a = raw.indexOf('['), b = raw.lastIndexOf(']');
        translations = JSON.parse(raw.slice(a, b + 1));
      } catch (e) { translations = []; }
      if (!Array.isArray(translations) || translations.length !== texts.length) {
        // fall back to originals on parse mismatch (never invent)
        translations = texts.slice();
      }
      return res.json({ translations });
    }

    // ── Single mode (backwards compatible) ──────────────────────────────────
    const text = body.text;
    if (!text) { res.status(400).json({ error: 'No text provided' }); return; }
    const system = target === 'ar'
      ? 'You are a financial translator. Translate the following English text to clear, professional Arabic. Keep all stock symbols, percentages, and numbers exactly as they are. Output ONLY the translated Arabic text, nothing else.'
      : 'You are a financial translator. Translate the following Arabic investment analysis to clear, professional English. Keep all stock symbols, percentages, and numbers exactly as they are. Preserve the structure and section headers. Output ONLY the translated text, nothing else.';
    const translated = await callClaude(system, text, 4000);
    if (!translated) throw new Error('Empty translation response');
    res.json({ translated, date: body.date });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
