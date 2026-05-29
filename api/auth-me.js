const https = require('https');

const REPO = 'ralyafei-source/theisilabs-portfolio';

async function ghGet(path, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${REPO}/contents/${path}`,
      headers: { 'Authorization': `token ${token}`, 'User-Agent': 'theisilabs-app' }
    };
    https.get(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization || '';
  const sessionToken = authHeader.replace('Bearer ', '').trim();

  if (!sessionToken) return res.status(401).json({ error: 'No session token' });

  const token = process.env.GITHUB_TOKEN;

  try {
    const usersFile = await ghGet('data/users.json', token);
    const users = JSON.parse(Buffer.from(usersFile.content, 'base64').toString());

    const user = users.find(u => u.sessionToken === sessionToken);

    if (!user) return res.status(401).json({ error: 'Invalid session' });

    if (new Date(user.sessionExpiry) < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }

    return res.status(200).json({
      nickname: user.nickname,
      isAdmin: user.isAdmin || false,
      portfolioFile: user.portfolioFile || null
    });

  } catch (e) {
    console.error('auth-me error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
