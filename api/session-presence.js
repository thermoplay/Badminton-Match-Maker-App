// =============================================================================
// Vercel Serverless Function — /api/session-presence
// Lightweight spectator presence tracking.
// Increments/decrements a spectator_count on the session row.
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
    return { ok: res.ok, data: text ? JSON.parse(text) : null };
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { room_code, action } = req.body;
    if (!room_code) return res.status(400).json({ error: 'Missing room_code' });

    // Get current count
    const current = await sbFetch(
        `/sessions?room_code=eq.${encodeURIComponent(room_code)}&select=spectator_count&limit=1`
    );

    if (!current.ok || !current.data || current.data.length === 0) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const currentCount = current.data[0].spectator_count || 0;
    let newCount = currentCount;

    if (action === 'join') newCount = currentCount + 1;
    if (action === 'leave') newCount = Math.max(0, currentCount - 1);
    // 'ping' keeps count the same — just signals still alive

    await sbFetch(
        `/sessions?room_code=eq.${encodeURIComponent(room_code)}`,
        {
            method: 'PATCH',
            body: { spectator_count: newCount, last_active: new Date().toISOString() },
        }
    );

    return res.status(200).json({ spectator_count: newCount });
}
