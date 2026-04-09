// =============================================================================
// /api/sessions — Lifecycle & Presence Management
// Replaces: session-get, session-create, session-update, session-delete, session-presence
// =============================================================================

import { ROOM_CODE_REGEX, normalizeRoomCode, sbFetch } from './_utils';
const crypto = require('crypto');

export default async function handler(req, res) {
    const { method } = req;
    const { code } = req.query;

    // --- GET: Fetch Session ---
    if (method === 'GET') {
        const codeClean = normalizeRoomCode(code);
        if (!codeClean || !ROOM_CODE_REGEX.test(codeClean)) return res.status(400).json({ error: 'Invalid room code' });
        
        const result = await sbFetch(`/sessions?room_code=eq."${encodeURIComponent(codeClean)}"&select=room_code,squad,current_matches,player_queue,last_active,is_open_party,court_names,uuid_map,approved_players,guest_list&limit=1`);
        if (!result.ok) return res.status(result.status).json({ error: 'Database connection failed' });
        if (!result.data?.length) return res.status(404).json({ error: 'Room not found' });

        const session = result.data[0];
        return res.status(200).json({
            ok: true,
            session: {
                room_code: session.room_code,
                squad: session.squad,
                current_matches: session.current_matches,
                player_queue: session.player_queue || [],
                last_active: session.last_active,
                is_open_party: !!session.is_open_party,
                court_names: session.court_names || {},
                uuid_map: session.uuid_map || {},
                approved_players: session.approved_players || {},
                guest_list: session.guest_list || []
            }
        });
    }

    // --- POST: Create Session OR Presence Update ---
    if (method === 'POST') {
        const { room_code, operator_key, action } = req.body;

        // Sub-route: Presence Tracking
        if (action) {
            const result = await sbFetch('/rpc/handle_spectator_presence', {
                method: 'POST',
                body: { p_room_code: room_code, p_action: action }
            });
            return res.status(result.ok ? 200 : 500).json({ spectator_count: result.data });
        }

        // Sub-route: Create Session
        const finalHash = operator_key ? crypto.createHash('sha256').update(operator_key).digest('hex') : null;
        if (!room_code || !finalHash) return res.status(400).json({ error: 'Missing required fields' });

        const result = await sbFetch('/sessions', {
            method: 'POST',
            body: { 
                room_code, 
                operator_key: finalHash, 
                last_active: new Date().toISOString(),
                squad: req.body.squad || [],
                current_matches: req.body.current_matches || [],
                player_queue: req.body.player_queue || [],
                round_history: []
            },
        });
        return res.status(result.ok ? 200 : result.status).json(result.ok ? { room_code, created: true, operator_key: finalHash } : { error: result.data?.message });
    }

    // --- PATCH: Update State ---
    if (method === 'PATCH') {
        const { room_code: raw_code, operator_key, squad, current_matches } = req.body;
        const code = normalizeRoomCode(raw_code);
        
        const check = await sbFetch(`/sessions?room_code=eq."${encodeURIComponent(code)}"&select=operator_key,squad&limit=1`);
        if (!check.ok || !check.data?.length) return res.status(404).json({ error: 'Session not found' });
        
        const incomingHash = crypto.createHash('sha256').update(operator_key).digest('hex');
        if (check.data[0].operator_key !== incomingHash) return res.status(403).json({ error: 'Unauthorized' });

        // --- RESTORE: Smart Squad Merge ---
        const existingSquad = Array.isArray(check.data[0].squad) ? check.data[0].squad : [];
        const incomingSquad = Array.isArray(squad) ? squad : [];
        const mergedSquadMap = new Map(existingSquad.map(p => [p.uuid, p]));

        for (const p of incomingSquad) {
            if (!p.uuid) continue;
            const serverP = mergedSquadMap.get(p.uuid);
            const mergedP = serverP ? {
                ...p,
                achievements: [...new Set([...(p.achievements || []), ...(serverP.achievements || [])])],
                spiritAnimal: p.spiritAnimal || serverP.spiritAnimal || null,
                teammateHistory: { ...(serverP.teammateHistory || {}), ...(p.teammateHistory || {}) },
                opponentHistory: { ...(serverP.opponentHistory || {}), ...(p.opponentHistory || {}) },
                partnerStats: { ...(serverP.partnerStats || {}), ...(p.partnerStats || {}) },
                matchHistory: (p.matchHistory?.length > 0) ? p.matchHistory : (serverP.matchHistory || [])
            } : p;
            mergedSquadMap.set(p.uuid, mergedP);
        }
        const mergedSquad = Array.from(mergedSquadMap.values());

        // --- RESTORE: Career Stats Sync ---
        const playerUpdates = incomingSquad.filter(p => p.uuid).map(p => ({
            uuid: p.uuid,
            rating: p.rating,
            career_wins: p.wins,
            career_games: p.games,
            achievements: p.achievements || [],
            spirit_animal: p.spiritAnimal || null,
            last_active: new Date().toISOString()
        }));
        if (playerUpdates.length > 0) {
            await sbFetch('/players', { method: 'POST', body: playerUpdates, prefer: 'resolution=merge-duplicates' });
        }

        const result = await sbFetch(`/sessions?room_code=eq."${encodeURIComponent(code)}"`, {
            method: 'PATCH',
            body: {
                squad: mergedSquad,
                current_matches,
                player_queue: req.body.player_queue || [],
                last_active: new Date().toISOString(),
                is_open_party: req.body.is_open_party,
                court_names: req.body.court_names,
                uuid_map: req.body.uuid_map || {},
                approved_players: req.body.approved_players || {},
                guest_list: req.body.guest_list || []
            }
        });
        return res.status(result.ok ? 200 : 500).json({ updated: result.ok });
    }

    // --- DELETE: End Session ---
    if (method === 'DELETE') {
        const { room_code, operator_key } = req.body;
        const check = await sbFetch(`/sessions?room_code=eq.${encodeURIComponent(room_code)}&select=operator_key&limit=1`);
        if (!check.ok || !check.data?.length) return res.status(404).json({ error: 'Not found' });

        const incomingHash = crypto.createHash('sha256').update(operator_key).digest('hex');
        if (check.data[0].operator_key !== incomingHash) return res.status(403).json({ error: 'Unauthorized' });

        const result = await sbFetch(`/sessions?room_code=eq."${encodeURIComponent(room_code)}"`, { method: 'DELETE' });
        return res.status(result.ok ? 200 : 500).json({ deleted: result.ok }); // This line was already correct
    }

    return res.status(405).json({ error: 'Method not allowed' });
}