// =============================================================================
// Vercel Serverless Function — /api/session-update
// Updates squad + matches. Only succeeds if operator_key matches.
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sbFetch(path, options = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
        headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
            'Prefer':        options.prefer || 'return=minimal',
        },
        method: options.method || 'GET',
        body:   options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

async function hashKey(key) {
    if (!key) return null;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function handler(req, res) {
    if (req.method !== 'PATCH') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { room_code, operator_key, squad, current_matches } = req.body;

    if (!room_code || !operator_key) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify operator_key server-side — never trust the client
    const checkResult = await sbFetch(
        `/sessions?room_code=eq.${encodeURIComponent(room_code)}&select=operator_key_hash&limit=1`
    );

    if (!checkResult.ok || !checkResult.data || checkResult.data.length === 0) {
        return res.status(404).json({ error: 'Session not found' });
    }

    if (checkResult.data[0].operator_key_hash !== await hashKey(operator_key)) {
        // Wrong key — refuse silently (don't tell them why — makes brute force harder)
        return res.status(403).json({ error: 'Unauthorized' });
    }

    // Key matches — apply the update
    const updateResult = await sbFetch(
        `/sessions?room_code=eq.${encodeURIComponent(room_code)}`,
        {
            method: 'PATCH',
            body: {
                squad,
                current_matches,
                uuid_map:         req.body.uuid_map         || {},
                approved_players: req.body.approved_players || {},
                last_active: new Date().toISOString(),
            },
        }
    );

    if (!updateResult.ok) {
        return res.status(500).json({ error: 'Update failed' });
    }

    return res.status(200).json({ updated: true });
}