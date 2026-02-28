// =============================================================================
// Vercel Serverless Function — /api/session-cleanup
// Deletes sessions where last_active is older than max_age_hours.
// Called by the host client once on session create — fire and forget.
// Keeps the sessions table lean so Postgres doesn't cache stale blobs.
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sbFetch(path, options = {}) {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
            headers: {
                'apikey':        SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type':  'application/json',
                'Prefer':        options.prefer || 'return=minimal',
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
        throw e;
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return res.status(500).json({ error: 'Server misconfiguration' });
    }

    const maxAgeHours = Number(req.body?.max_age_hours) || 24;

    // Calculate cutoff timestamp
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

    try {
        // Delete sessions where last_active is older than cutoff
        // Supabase REST: DELETE with filter via query param
        const result = await sbFetch(
            `/sessions?last_active=lt.${encodeURIComponent(cutoff)}`,
            { method: 'DELETE' }
        );

        if (!result.ok) {
            console.error('[session-cleanup] Supabase error:', result.status, result.data);
            return res.status(result.status).json({ error: 'Cleanup failed' });
        }

        return res.status(200).json({ cleaned: true, cutoff });

    } catch (e) {
        console.error('[session-cleanup] Error:', e.message);
        return res.status(500).json({ error: 'Internal error' });
    }
}
