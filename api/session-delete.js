// =============================================================================
// Vercel Serverless Function — /api/session-delete
// Deletes a session. Only succeeds if operator_key matches.
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const crypto = require('crypto'); // Node.js crypto module for hashing

async function sbFetch(path, options = {}) {
    console.log(`[sbFetch] Making request to: ${SUPABASE_URL}/rest/v1${path}`);
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
        headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
            'Prefer':        'return=minimal',
        },
        method: options.method || 'GET',
        body:   options.body ? JSON.stringify(options.body) : undefined,
    });
    return { ok: res.ok, status: res.status };
}

export default async function handler(req, res) {
    if (req.method !== 'DELETE') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { room_code, operator_key } = req.body;
    if (!room_code || !operator_key) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify key server-side first
    const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/sessions?room_code=eq.${encodeURIComponent(room_code)}&select=operator_key&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const checkData = await checkRes.json();

    if (!checkData || checkData.length === 0) {
        return res.status(404).json({ error: 'Session not found or already deleted' });
    }
    const incomingOperatorKeyHash = crypto.createHash('sha256').update(operator_key).digest('hex');
    if (checkData[0].operator_key !== incomingOperatorKeyHash) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const delRes = await sbFetch(
        `/sessions?room_code=eq.${encodeURIComponent(room_code)}`,
        { method: 'DELETE' }
    );

    return res.status(delRes.ok ? 200 : 500).json({ deleted: delRes.ok });
}
