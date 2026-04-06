// =============================================================================
// /api/leaderboard-get — GET: fetch weekly leaderboard from match_history
// =============================================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sbFetch(path, options = {}) {
    console.log(`[sbFetch] Making request to: ${SUPABASE_URL}/rest/v1${path}`);
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
        headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
        },
        method: options.method || 'GET',
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { period } = req.query;

    if (period === 'weekly') {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const response = await sbFetch(
            `${SUPABASE_URL}/rest/v1/match_history?played_at=gte.${since}&select=player_name,won,player_uuid`,
            { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );

        if (!response.ok) return res.status(500).json({ error: 'Fetch failed' });
        const rows = await response.json();

        const map = {};
        rows.forEach(r => {
            // Use player_uuid as the primary key for aggregation to handle name changes
            const key = r.player_uuid || r.player_name;
            if (!map[key]) map[key] = { player_name: r.player_name, total_wins: 0, total_games: 0, elo: '—' };
            // Always use the most recent name for display
            map[key].player_name = r.player_name;
            map[key].total_games++;
            if (r.won) map[key].total_wins++;
        });
        const players = Object.values(map).sort((a, b) => b.total_wins - a.total_wins).slice(0, 10);
        return res.status(200).json({ players });
    }

    const response = await sbFetch(
        `${SUPABASE_URL}/rest/v1/career_stats?order=elo.desc&limit=10`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );

    if (!response.ok) return res.status(500).json({ error: 'Fetch failed' });
    const players = await response.json();

    return res.status(200).json({ players });
}
