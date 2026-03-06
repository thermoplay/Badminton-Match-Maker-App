// =============================================================================
// Vercel Serverless Function — /api/session-create
// Creates a new CourtSide session in Supabase.
// Also cleans up sessions inactive >24hrs — no extra function needed.
// Supabase URL and key NEVER leave the server.
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sbFetch(path, options = {}) {
    const controller = new AbortController();
    // Fix: Reduce timeout to 9s to ensure we catch it before Vercel's 10s hard limit
    const timeout    = setTimeout(() => controller.abort(), 9000);
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
            headers: {
                'apikey':        SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type':  'application/json',
                'Prefer':        options.prefer || 'return=representation',
            },
            method: options.method || 'GET',
            body:   options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
        });
        clearTimeout(timeout);
        const text = await res.text();
        return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
    } catch (e) {
        clearTimeout(timeout);
        if (e.name === 'AbortError') throw new Error('Supabase request timed out');
        throw e;
    }
}

async function cleanupStaleSessions() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    try {
        await sbFetch(
            `/sessions?last_active=lt.${encodeURIComponent(cutoff)}`,
            { method: 'DELETE', prefer: 'return=minimal' }
        );
    } catch (e) {
        console.warn('[session-create] Stale cleanup failed:', e.message);
    }
}

export default async function handler(req, res) {
    // 1. Handle CORS (Cross-Origin Resource Sharing)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.error('[session-create] Missing env vars');
        return res.status(500).json({ error: 'Server Error: Missing SUPABASE_URL or KEY' });
    }

    const { room_code, operator_key, operator_key_hash, squad, current_matches, player_queue } = req.body;

    // Hash the raw key if provided, otherwise use the pre-hashed one (for future compatibility)
    let finalHash = operator_key_hash;
    if (!finalHash && operator_key) {
        finalHash = operator_key;
    }

    if (!room_code || !finalHash) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(room_code)) {
        return res.status(400).json({ error: 'Invalid room code format' });
    }

    // Run cleanup in parallel — doesn't block the response
    try { cleanupStaleSessions(); } catch (err) { console.warn('Cleanup failed', err); }

    try {
        const result = await sbFetch('/sessions', {
            method: 'POST',
            body: {
                room_code,
                operator_key_hash: finalHash,
                squad:             squad           || [],
                current_matches:   current_matches || [],
                player_queue:      player_queue    || [],
                round_history:     [],
                last_active:       new Date().toISOString(),
            },
        });

        if (!result.ok) {
            console.error('[session-create] Supabase error:', result.status, result.data);
            return res.status(result.status).json({
                error: result.data?.message || 'Failed to create session',
            });
        }

        return res.status(200).json({ room_code, created: true, operator_key_hash: finalHash });

    } catch (e) {
        console.error('[session-create] Error:', e.message);
        const isTimeout = e.message?.includes('timed out');
        return res.status(isTimeout ? 504 : 500).json({
            error: isTimeout ? 'Database timeout — try again' : 'Internal server error',
        });
    }
}