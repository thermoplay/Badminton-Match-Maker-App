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
const crypto = require('crypto'); // Node.js crypto module for hashing
import { ROOM_CODE_REGEX, UUID_REGEX, normalizeRoomCode } from './_utils';

async function sb(path, options = {}) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return { ok: false, status: 500, data: { error: 'Server environment misconfigured' } };
    }

    const method = options.method || 'GET';
    let baseUrl = SUPABASE_URL.endsWith('/') ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL;
    if (baseUrl.includes('/rest/v1')) baseUrl = baseUrl.split('/rest/v1')[0];

    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${baseUrl}/rest/v1${cleanPath}`;

    console.log(`[sbFetch] Making request to: ${url}`);
    const headers = {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        options.prefer || (method === 'POST' ? 'return=minimal' : 'return=representation'),
    };

    const res = await fetch(url, {
        headers,
        method,
        body: options.body ? JSON.stringify(options.body) : undefined,
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
            const { room_code, operator_key, timestamp, matches, squad } = req.body;
            if (!room_code || !matches || !operator_key) {
                return res.status(400).json({ error: 'Missing fields for match_result' });
            }

            // Normalize room code
            const code = normalizeRoomCode(room_code);

            // Validation
            if (!ROOM_CODE_REGEX.test(code)) {
                return res.status(400).json({ error: 'Invalid room code format' });
            }

            const results = [];
            matches.forEach(m => {
                if (m.winnerTeamIndex === null) return;
                const winIdx  = m.winnerTeamIndex;
                const loseIdx = winIdx === 0 ? 1 : 0;

                const resolveData = (uuid, won) => {
                    const p = (squad || []).find(x => x.uuid === uuid) || {};
                    return {
                        player_uuid: uuid,
                        player_name: p.name || 'Unknown',
                        won: won,
                        rating: Math.round(p.rating || 1200)
                    };
                };

                m.teams[winIdx].forEach(name => {
                    const d = resolveData(name, true);
                    if (d.player_uuid) results.push(d);
                });
                m.teams[loseIdx].forEach(name => {
                    const d = resolveData(name, false);
                    if (d.player_uuid) results.push(d);
                });
            });

            if (results.length === 0) return res.status(200).json({ archived: 0 });

            // ── REVERTED: MANUAL UPDATES ─────────────────────────────────────
            // Bypassing the RPC to avoid persistent "text = uuid" type mismatches.
            
            // 1. Verify operator key
            const sessionRes = await sb(`/sessions?room_code=eq.${encodeURIComponent(code)}&select=operator_key&limit=1`);
            const incomingOperatorKeyHash = crypto.createHash('sha256').update(operator_key).digest('hex');
            if (!sessionRes.ok || sessionRes.data?.[0]?.operator_key !== incomingOperatorKeyHash) {
                return res.status(403).json({ error: 'Unauthorized' });
            }

            // 2. Update individual player ratings
            // IMPROVEMENT: Batch UPSERT ratings to avoid sequential network round-trips.
            const ratingUpdates = results.map(r => ({
                uuid: r.player_uuid,
                rating: r.rating,
                last_active: new Date().toISOString()
            }));

            await sb('/players', {
                method: 'POST',
                body: ratingUpdates,
                prefer: 'resolution=merge-duplicates'
            });

            // 3. Log achievements directly
            for (const ach of (req.body.achievements || [])) {
                await sb('/player_achievements', {
                    method: 'POST',
                    body: { player_uuid: ach.player_uuid, achievement_id: ach.achievement_id }
                });
            }

            return res.status(200).json({ ok: true });
        }

        // --- Unlock an Achievement ---
        if (type === 'achievement_unlock') {
            const { player_uuid, achievement_id, room_code, operator_key } = req.body;
            
            // Normalize room code
            const code = normalizeRoomCode(room_code);

            // Validation
            if (!ROOM_CODE_REGEX.test(code)) {
                return res.status(400).json({ error: 'Invalid room code format' });
            }
            if (!UUID_REGEX.test(player_uuid)) {
                return res.status(400).json({ error: 'Invalid player UUID format' });
            }

            // 1. Verify operator key
            const sessionRes = await sb(`/sessions?room_code=eq.${encodeURIComponent(code)}&select=operator_key&limit=1`);
            const incomingOperatorKeyHash = crypto.createHash('sha256').update(operator_key).digest('hex');
            if (!sessionRes.ok || sessionRes.data?.[0]?.operator_key !== incomingOperatorKeyHash) {
                return res.status(403).json({ error: 'Unauthorized' });
            }

            // 2. Insert achievement directly into the table
            const r = await sb('/player_achievements', {
                method: 'POST',
                body: {
                    player_uuid:    player_uuid,
                    achievement_id: achievement_id
                }
            });

            return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
        }

        return res.status(400).json({ error: 'Invalid POST type specified' });
    }

    // -------------------------------------------------------------------------
    // GET: Fetch achievements for a player
    // -------------------------------------------------------------------------
    if (req.method === 'GET') {
        const { player_uuid, type } = req.query;

        // Sub-route: Global Leaderboard
        if (type === 'leaderboard') {
            const response = await sb('/career_stats?order=elo.desc&limit=10');
            return res.status(response.ok ? 200 : 500).json({ players: response.data || [] });
        }

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
