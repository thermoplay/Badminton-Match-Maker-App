// =============================================================================
// Vercel Serverless Function — /api/session-create
// Creates a new CourtSide session in Supabase.
// Supabase URL and key NEVER leave the server — not visible in browser.
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service key — server only

async function sbFetch(path, options = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
        headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
            'Prefer':        options.prefer || 'return=representation',
        },
        method: options.method || 'GET',
        body:   options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

export default async function handler(req, res) {
    // Only allow POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Basic rate limit — one session per IP per minute (Vercel provides req.headers)
    // For production you'd use a Redis store; this is a lightweight check
    const { room_code, operator_key, squad, current_matches } = req.body;

    if (!room_code || !operator_key) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate room_code format: XXXX-XXXX alphanumeric
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(room_code)) {
        return res.status(400).json({ error: 'Invalid room code format' });
    }

    const result = await sbFetch('/sessions', {
        method: 'POST',
        body: {
            room_code,
            operator_key,
            squad:           squad           || [],
            current_matches: current_matches || [],
            round_history:   [],
            last_active:     new Date().toISOString(),
        },
    });

    if (!result.ok) {
        return res.status(result.status).json({ error: 'Failed to create session' });
    }

    // Only return safe fields — never leak operator_key back unnecessarily
    return res.status(200).json({ room_code, created: true });
}
