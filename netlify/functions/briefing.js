// Netlify Function: /api/briefing
// Receives POST from Make.com, stores briefing
// Returns GET for dashboard to read

const BRIEFINGS_STORE = [];

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle CORS preflight
  if(event.httpMethod === 'OPTIONS'){
    return { statusCode: 200, headers, body: '' };
  }

  // GET — dashboard fetches latest briefing
  if(event.httpMethod === 'GET'){
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        briefings: [],
        message: 'No briefings stored yet. Use Netlify Blobs or a database for persistence.'
      })
    };
  }

  // POST — Make.com sends briefing
  if(event.httpMethod === 'POST'){
    try{
      const body = JSON.parse(event.body || '{}');
      const apiKey = event.headers['x-api-key'] || body.api_key;

      // Simple auth check — you set this secret in Netlify environment variables
      const expectedKey = process.env.BRIEFING_API_KEY || 'theisilabs2026';
      if(apiKey !== expectedKey){
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: 'Unauthorized' })
        };
      }

      const briefing = {
        date: new Date().toISOString(),
        content: body.content || body.text || '',
        source: 'make.com'
      };

      if(!briefing.content){
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'No content provided' })
        };
      }

      // In production, store in Netlify Blobs
      // For now, return success and the dashboard uses localStorage
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          briefing,
          message: 'Briefing received successfully'
        })
      };

    } catch(e){
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Server error: ' + e.message })
      };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
