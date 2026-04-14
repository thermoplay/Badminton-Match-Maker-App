// =============================================================================
// /api/leaderboard-get — GET: fetch weekly leaderboard from match_history
// =============================================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
    // 1. Handle CORS (Required for browser fetch to succeed)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { period } = req.query;

    try {
        if (period === 'weekly') {
            const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            // FIX: URL encode the timestamp since it contains colons and plus signs
            const response = await fetch(
                `${SUPABASE_URL}/rest/v1/match_history?played_at=gte.${encodeURIComponent(since)}&select=player_name,won,player_uuid`,
                { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
            );

            if (!response.ok) throw new Error('Supabase weekly fetch failed');
            const rows = await response.json();
            
            if (!Array.isArray(rows)) return res.status(200).json({ players: [] });

            const map = {};
            rows.forEach(r => {
                const key = r.player_uuid || r.player_name;
                if (!key) return;
                if (!map[key]) map[key] = { player_name: r.player_name, total_wins: 0, total_games: 0, elo: '—' };
                map[key].player_name = r.player_name;
                map[key].total_games++;
                if (r.won) map[key].total_wins++;
            });
            const players = Object.values(map).sort((a, b) => b.total_wins - a.total_wins).slice(0, 10);
            return res.status(200).json({ players });
        }

        // All-Time Rankings
        // FIX: Query the 'players' table and sort by 'rating' (the canonical fields used in the app)
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/players?order=rating.desc&limit=10`,
            { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );

        if (!response.ok) throw new Error('Supabase all-time fetch failed');
        const players = await response.json();

        const mappedPlayers = (Array.isArray(players) ? players : []).map(p => ({
            name: p.name,
            player_name: p.name,
            wins: p.career_wins || 0,
            games: p.career_games || 0,
            rating: p.rating || 1200
        }));

        return res.status(200).json({ players: mappedPlayers });

    } catch (err) {
        console.error('[leaderboard-get] Error:', err);
        return res.status(500).json({ error: err.message, players: [] });
    }
}
