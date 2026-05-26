const fs = require('fs');
const path = require('path');
const BRIEFING_API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'ralyafei-source/theisilabs-portfolio';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const date = req.query.date || new Date().toISOString().split('T')[0];
      const FILE_PATH = `data/analysis-${date}.json`;
      const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/${FILE_PATH}?t=${Date.now()}`);
      if (!r.ok) return res.status(200).json({ content: null, date });
      const data = await r.json();
      return res.status(200).json(data);
    } catch(e) {
      return res.status(200).json({ content: null });
    }
  }

  if (req.method === 'POST') {
    const apiKey = req.headers['x-api-key'] || (req.body && req.body.api_key);
    if (apiKey !== BRIEFING_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const content = (req.body && req.body.content) || '';
    const date = new Date().toISOString().split('T')[0];
    if (!content) return res.status(400).json({ error: 'No content' });
    try {
      const FILE_PATH = `data/analysis-${date}.json`;
      const data = { content, date, generated: new Date().toISOString() };
      const encoded = Buffer.from(JSON.stringify(data)).toString('base64');
      const getRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      const getSha = getRes.ok ? (await getRes.json()).sha : null;
      const putRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
        method: 'PUT',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: `Analysis ${date}`,
          content: encoded,
          ...(getSha && { sha: getSha })
        })
      });
      if (!putRes.ok) {
        const err = await putRes.json();
        return res.status(500).json({ error: err.message });
      }
      return res.status(200).json({ success: true, date });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
};
