// =============================================================================
// /api/match-history — POST: archive a completed round
// =============================================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path, options = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
        headers: {
            'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json', 'Prefer': 'return=minimal',
        },
        method: options.method || 'GET',
        body:   options.body ? JSON.stringify(options.body) : undefined,
    });
    return { ok: res.ok, status: res.status };
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { room_code, timestamp, matches, squad } = req.body;
    if (!room_code || !matches) return res.status(400).json({ error: 'Missing fields' });

    // For each completed match, upsert player win/loss into match_history
    const rows = [];
    matches.forEach(m => {
        if (m.winnerTeamIndex === null) return;
        const winIdx  = m.winnerTeamIndex;
        const loseIdx = winIdx === 0 ? 1 : 0;
        m.teams[winIdx].forEach(name => {
            rows.push({ room_code, player_name: name, won: true,  played_at: new Date(timestamp).toISOString() });
        });
        m.teams[loseIdx].forEach(name => {
            rows.push({ room_code, player_name: name, won: false, played_at: new Date(timestamp).toISOString() });
        });
    });

    if (rows.length === 0) return res.status(200).json({ archived: 0 });

    const result = await sb('/match_history', { method: 'POST', body: rows });
    return res.status(result.ok ? 200 : 500).json({ archived: rows.length });
}
