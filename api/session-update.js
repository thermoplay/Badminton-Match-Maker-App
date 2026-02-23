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
        `/sessions?room_code=eq.${encodeURIComponent(room_code)}&select=operator_key&limit=1`
    );

    if (!checkResult.ok || !checkResult.data || checkResult.data.length === 0) {
        return res.status(404).json({ error: 'Session not found' });
    }

    if (checkResult.data[0].operator_key !== operator_key) {
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
                last_active: new Date().toISOString(),
            },
        }
    );

    if (!updateResult.ok) {
        return res.status(500).json({ error: 'Update failed' });
    }

    return res.status(200).json({ updated: true });
}
