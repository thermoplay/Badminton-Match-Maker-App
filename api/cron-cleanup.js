// =============================================================================
// Vercel Serverless Function — /api/cron-cleanup
// Purges sessions that have been inactive for more than 24 hours.
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sbFetch(path, options = {}) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return { ok: false, status: 500, data: { error: 'Server environment misconfigured' } };
    }

    const method = options.method || 'GET';
    let baseUrl = SUPABASE_URL.endsWith('/') ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL;
    if (baseUrl.includes('/rest/v1')) baseUrl = baseUrl.split('/rest/v1')[0];

    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${baseUrl}/rest/v1${cleanPath}`;

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 9000);
    try {
        const res = await fetch(url, {
            headers: {
                'apikey':        SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type':  'application/json',
                'Prefer':        options.prefer || 'return=representation',
            },
            method: method,
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

export default async function handler(req, res) {
    // 1. Security: Only allow requests from Vercel's Cron scheduler
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // 2. Define staleness (24 hours ago)
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    try {
        // Delete sessions where last_active is less than the cutoff
        const result = await sbFetch(`/sessions?last_active=lt.${cutoff}`, {
            method: 'DELETE',
            prefer: 'count=exact'
        });

        if (!result.ok) {
            console.error('[cron-cleanup] Supabase error:', result.status, result.data);
            return res.status(result.status).json({ error: 'Cleanup failed' });
        }

        return res.status(200).json({ 
            success: true, 
            message: `Cleanup completed for sessions inactive since ${cutoff}`
        });

    } catch (e) {
        console.error('[cron-cleanup] Error:', e.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
}