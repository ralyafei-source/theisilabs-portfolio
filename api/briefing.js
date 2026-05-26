const BRIEFING_API_KEY = process.env.BRIEFING_API_KEY || 'theisilabs2026';

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      message: 'Briefing API is working',
      status: 'ok'
    });
  }

  if (req.method === 'POST') {
    const apiKey = req.headers['x-api-key'] || (req.body && req.body.api_key);
    if (apiKey !== BRIEFING_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const content = (req.body && req.body.content) || (req.body && req.body.text) || '';
    if (!content) {
      return res.status(400).json({ error: 'No content provided' });
    }
    return res.status(200).json({
      success: true,
      message: 'Briefing received successfully',
      date: new Date().toISOString()
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
