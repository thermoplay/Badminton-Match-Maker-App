// =============================================================================
// Vercel Serverless Function — /api/session-get
// Fetches a session by room code. Returns safe fields only.
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sbFetch(path) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
        headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
        },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { code } = req.query;
    if (!code || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code.toUpperCase())) {
        return res.status(400).json({ error: 'Invalid room code' });
    }

    const result = await sbFetch(
        `/sessions?room_code=eq.${encodeURIComponent(code.toUpperCase())}&limit=1`
    );

    if (!result.ok || !result.data || result.data.length === 0) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const session = result.data[0];

    // IMPORTANT: never return operator_key to the client
    return res.status(200).json({
        room_code:          session.room_code,
        squad:              session.squad,
        current_matches:    session.current_matches,
        round_history:      session.round_history,
        last_active:        session.last_active,
        uuid_map:           session.uuid_map         || {},
        approved_players:   session.approved_players || {},
        // Return a hash of the operator_key so the client can verify identity
        // without ever seeing the actual key
        operator_key_hash: await hashKey(session.operator_key),
    });
}

// One-way hash — client stores their key, hashes it, compares to this
async function hashKey(key) {
    const enc    = new TextEncoder();
    const buf    = await crypto.subtle.digest('SHA-256', enc.encode(key));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}