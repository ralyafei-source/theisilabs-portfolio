const fs = require('fs');
const path = require('path');
const FILE = path.join('/tmp', 'briefing.json');
const BRIEFING_API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      if (fs.existsSync(FILE)) {
        const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return res.status(200).json(data);
      }
      return res.status(200).json({ content: null });
    } catch(e) {
      return res.status(200).json({ content: null });
    }
  }

  if (req.method === 'POST') {
    const apiKey = req.headers['x-api-key'] || (req.body && req.body.api_key);
    if (apiKey !== BRIEFING_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const content = (req.body && req.body.content) || '';
    if (!content) return res.status(400).json({ error: 'No content' });
    const data = { content, date: new Date().toISOString() };
    try {
      fs.writeFileSync(FILE, JSON.stringify(data));
      return res.status(200).json({ success: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
