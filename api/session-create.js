// =============================================================================
// Vercel Serverless Function — /api/session-create
// Creates a new CourtSide session in Supabase.
// Supabase URL and key NEVER leave the server — not visible in browser.
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service key — server only

// ---------------------------------------------------------------------------
// sbFetch — wraps Supabase REST with a hard 8s timeout so the Vercel function
// never silently hangs until the platform kills it at 10s.
// ---------------------------------------------------------------------------
async function sbFetch(path, options = {}) {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 8000);

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
        if (e.name === 'AbortError') {
            throw new Error('Supabase request timed out');
        }
        throw e;
    }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
    // Only allow POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Guard: env vars must be set or every request will hang
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.error('[session-create] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
        return res.status(500).json({ error: 'Server misconfiguration' });
    }

    const { room_code, operator_key, operator_key_hash, squad, current_matches } = req.body;

    if (!room_code || !operator_key) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate room_code format: XXXX-XXXX alphanumeric
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(room_code)) {
        return res.status(400).json({ error: 'Invalid room code format' });
    }

    try {
        const result = await sbFetch('/sessions', {
            method: 'POST',
            body: {
                room_code,
                operator_key,
                // Store the hash so clients can verify host identity on rejoin
                // without the server ever needing to compare raw keys
                operator_key_hash: operator_key_hash || null,
                squad:             squad           || [],
                current_matches:   current_matches || [],
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

        // Only return safe fields — never leak operator_key back
        return res.status(200).json({ room_code, created: true });

    } catch (e) {
        console.error('[session-create] Unexpected error:', e.message);
        const isTimeout = e.message?.includes('timed out');
        return res.status(isTimeout ? 504 : 500).json({
            error: isTimeout ? 'Database timeout — try again' : 'Internal server error',
        });
    }
}