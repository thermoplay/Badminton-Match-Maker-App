// /api/play-request — POST/GET/DELETE for spectator play requests
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const hdrs = () => ({
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
});

export default async function handler(req, res) {

    if (req.method === 'POST') {
        const { room_code, name } = req.body;
        if (!room_code || !name) return res.status(400).json({ error: 'Missing fields' });
        const r = await fetch(`${SUPABASE_URL}/rest/v1/play_requests`, {
            method: 'POST', headers: hdrs(),
            body: JSON.stringify({ room_code, name, requested_at: new Date().toISOString() }),
        });
        return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
    }

    if (req.method === 'GET') {
        const { room_code } = req.query;
        if (!room_code) return res.status(400).json({ error: 'Missing room_code' });
        const r = await fetch(
            `${SUPABASE_URL}/rest/v1/play_requests?room_code=eq.${encodeURIComponent(room_code)}&order=requested_at.asc`,
            { headers: hdrs() }
        );
        const data = await r.json();
        return res.status(200).json({ requests: data || [] });
    }

    if (req.method === 'DELETE') {
        const { id, room_code } = req.body;
        if (!id) return res.status(400).json({ error: 'Missing id' });
        const r = await fetch(
            `${SUPABASE_URL}/rest/v1/play_requests?id=eq.${id}`,
            { method: 'DELETE', headers: hdrs() }
        );
        return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
