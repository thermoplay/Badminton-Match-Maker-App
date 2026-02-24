// =============================================================================
// /api/leaderboard-get — GET: fetch weekly leaderboard from match_history
// =============================================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    // Get last 7 days of data
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const response = await fetch(
        `${SUPABASE_URL}/rest/v1/match_history?played_at=gte.${since}&select=player_name,won`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );

    if (!response.ok) return res.status(500).json({ error: 'Fetch failed' });
    const rows = await response.json();

    // Aggregate per player
    const map = {};
    rows.forEach(r => {
        if (!map[r.player_name]) map[r.player_name] = { name: r.player_name, wins: 0, games: 0 };
        map[r.player_name].games++;
        if (r.won) map[r.player_name].wins++;
    });

    const players = Object.values(map).filter(p => p.games >= 1);
    return res.status(200).json({ players, since });
}
