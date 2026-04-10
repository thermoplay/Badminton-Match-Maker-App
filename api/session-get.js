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
    // 1. Handle CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') return res.status(200).end();

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
        ok: true,
        session: {
            room_code:          session.room_code,
            squad:              session.squad,
            current_matches:    session.current_matches,
            player_queue:       session.player_queue     || [],
            last_active:        session.last_active,
            is_open_party:      session.is_open_party    || false,
            guest_list:         session.guest_list       || [],
            uuid_map:           session.uuid_map         || {},
            approved_players:   session.approved_players || {},
            // Return the stored key. The client can verify identity by comparing it.
            operator_key:       session.operator_key,
            // round_history is intentionally not returned to keep payloads small.
        }
    });
}