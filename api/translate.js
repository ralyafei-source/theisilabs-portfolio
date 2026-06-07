// api/translate.js — Save this file as: api/translate.js in your GitHub repo
// Translates Arabic analysis to English using Claude API
// Uses the same ANTHROPIC_API_KEY already set in Vercel environment

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { text, date } = req.body || {};
  if (!text) { res.status(400).json({ error: 'No text provided' }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'API key not configured' }); return; }

  const target = req.body?.target || 'en';
  const system = target === 'ar'
    ? 'You are a financial translator. Translate the following English company description to clear, professional Arabic. Keep all stock symbols, percentages, and numbers exactly as they are. Output ONLY the translated Arabic text, nothing else.'
    : 'You are a financial translator. Translate the following Arabic investment analysis to clear, professional English. Keep all stock symbols, percentages, and numbers exactly as they are. Preserve the structure and section headers. Output ONLY the translated text, nothing else.';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', // Fast + cheap for translation
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: text }]
      })
    });

    const data = await response.json();
    const translated = data.content?.[0]?.text || '';

    if (!translated) throw new Error('Empty translation response');

    res.json({ translated, date });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
