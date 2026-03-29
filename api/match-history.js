// =============================================================================
// /api/match-history — Handles match history and player achievements
//
// GET:
//  - /api/match-history -> returns recent match history (not implemented yet)
//  - /api/match-history?player_uuid={uuid} -> returns achievements for a player
//
// POST:
//  - body: { type: 'match_result', ... } -> archives a completed round
//  - body: { type: 'achievement_unlock', ... } -> saves a new achievement
// =============================================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path, options = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
        headers: {
            'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            // GET requests might want representation, POSTs want minimal
            'Prefer': options.prefer || (options.method === 'POST' ? 'return=minimal' : 'return=representation'),
        },
        method: options.method || 'GET',
        body:   options.body ? JSON.stringify(options.body) : undefined,
    });
    // For GETs, we want the data. For POSTs, just the status.
    const data = (res.headers.get('Content-Type')?.includes('application/json')) ? await res.json() : null;
    return { ok: res.ok, status: res.status, data };
}

export default async function handler(req, res) {

    // -------------------------------------------------------------------------
    // POST: Archive a round OR unlock an achievement
    // -------------------------------------------------------------------------
    if (req.method === 'POST') {
        const { type } = req.body;

        // --- Archive a completed match/round ---
        if (type === 'match_result') {
            const { room_code, operator_key, timestamp, matches } = req.body;
            if (!room_code || !matches || !operator_key) {
                return res.status(400).json({ error: 'Missing fields for match_result' });
            }

            const results = [];
            matches.forEach(m => {
                if (m.winnerTeamIndex === null) return;
                const winIdx  = m.winnerTeamIndex;
                const loseIdx = winIdx === 0 ? 1 : 0;
                m.teams[winIdx].forEach(name => results.push({ player_name: name, won: true }));
                m.teams[loseIdx].forEach(name => results.push({ player_name: name, won: false }));
            });

            if (results.length === 0) return res.status(200).json({ archived: 0 });

            // ── ATOMIC RPC CALL ──────────────────────────────────────────────
            // Verification and batch insertion happen in one database transaction.
            const r = await sb('/rpc/archive_round', {
                method: 'POST',
                prefer: 'return=representation',
                body: {
                    p_room_code:    room_code,
                    p_operator_key: operator_key,
                    p_timestamp:    new Date(timestamp).toISOString(),
                    p_results:      results,
                    p_achievements: req.body.achievements || []
                }
            });

            if (!r.ok) return res.status(r.status || 500).json({ error: r.data?.message || 'Database error' });
            if (r.data?.error) return res.status(r.data.status || 400).json({ error: r.data.error });

            return res.status(200).json(r.data);
        }

        // --- Unlock an Achievement ---
        if (type === 'achievement_unlock') {
            const { player_uuid, achievement_id, room_code, operator_key } = req.body;
            
            const r = await sb('/rpc/unlock_achievement', {
                method: 'POST',
                prefer: 'return=representation',
                body: {
                    p_room_code:      room_code,
                    p_operator_key:   operator_key,
                    p_player_uuid:    player_uuid,
                    p_achievement_id: achievement_id
                }
            });

            if (!r.ok) return res.status(r.status || 500).json({ error: r.data?.message || 'Database error' });
            if (r.data?.error) return res.status(r.data.status || 400).json({ error: r.data.error });

            return res.status(200).json({ ok: true });
        }

        return res.status(400).json({ error: 'Invalid POST type specified' });
    }

    // -------------------------------------------------------------------------
    // GET: Fetch achievements for a player
    // -------------------------------------------------------------------------
    if (req.method === 'GET') {
        const { player_uuid } = req.query;

        // --- Fetch achievements for a specific player ---
        if (player_uuid) {
            const result = await sb(
                `/player_achievements?player_uuid=eq.${encodeURIComponent(player_uuid)}&select=achievement_id,unlocked_at`
            );
            if (!result.ok) return res.status(500).json({ error: 'Failed to fetch achievements' });
            return res.status(200).json({ achievements: result.data || [] });
        }

        // --- Placeholder for fetching general match history (original purpose) ---
        // (Currently not implemented, but this is where it would go)
        return res.status(400).json({ error: 'Missing query parameter. Did you mean to add ?player_uuid=...' });
    }

    // -------------------------------------------------------------------------
    // All other methods
    // -------------------------------------------------------------------------
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
}
