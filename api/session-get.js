// =============================================================================
// Vercel Serverless Function — /api/session-get
// Fetches a session by room code. Returns safe fields only.
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

/** Normalize room code for consistency */
function normalizeRoomCode(raw) {
    if (!raw) return '';
    let code = String(raw).toUpperCase().trim();
    const stripped = code.replace(/[^A-Z0-9]/g, '');
    if (stripped.length === 8 && !code.includes('-')) {
        return stripped.slice(0, 4) + '-' + stripped.slice(4);
    }
    return code;
}

async function sbFetch(path, options = {}) {
    const baseUrl = SUPABASE_URL.endsWith('/') ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL;
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${baseUrl}/rest/v1${cleanPath}`;

    console.log(`[sbFetch] Making request to: ${url}`);
    const res = await fetch(url, {
        headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
        },
        method: options.method || 'GET',
    });

    let data = null;
    const text = await res.text();
    try { if (text) data = JSON.parse(text); } catch(e) {}

    if (!res.ok) console.error(`[sbFetch] Error ${res.status}:`, text);
    return { ok: res.ok, status: res.status, data };
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
    const codeClean = normalizeRoomCode(code);

    if (!codeClean || !/^[A-Z0-9]{2,6}-[A-Z0-9]{2,6}$/.test(codeClean)) {
        return res.status(400).json({ error: 'Invalid room code' });
    }

    const result = await sbFetch(`/sessions?room_code=eq.${encodeURIComponent(codeClean)}&limit=1`);

    if (!result.ok) {
        return res.status(500).json({ error: 'Database connection failed' });
    }
    if (!result.data || result.data.length === 0) {
        return res.status(404).json({ error: 'Room not found' });
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
            // Do NOT return operator_key to client. Client verifies identity by comparing its hash.
            // operator_key:       session.operator_key,
            // round_history is intentionally not returned to keep payloads small.
        }
    });
}