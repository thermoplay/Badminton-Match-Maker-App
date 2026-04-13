// =============================================================================
// Vercel Serverless Function — /api/session-update
// Updates squad + matches. Only succeeds if operator_key matches.
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sbFetch(path, options = {}) {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 9000);
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
            headers: {
                'apikey':        SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type':  'application/json',
                'Prefer':        options.prefer || 'return=minimal',
            },
            method: options.method || 'GET',
            body:   options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
        });
        clearTimeout(timeout);
        const text = await res.text();
        return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
    } catch (e) {
        clearTimeout(timeout);
        throw e;
    }
}

export default async function handler(req, res) {
    // 1. Handle CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'PATCH') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { room_code, operator_key, squad, current_matches, player_queue } = req.body;

    if (!room_code || !operator_key) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify operator_key server-side — never trust the client
    const checkResult = await sbFetch(
        `/sessions?room_code=eq.${encodeURIComponent(room_code)}&select=operator_key,squad&limit=1`
    );

    if (!checkResult.ok || !checkResult.data || checkResult.data.length === 0) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const session = checkResult.data[0];
    if (session.operator_key !== operator_key) {
        // Wrong key — refuse silently (don't tell them why — makes brute force harder)
        return res.status(403).json({ error: 'Unauthorized' });
    }

    // --- SMART SQUAD MERGE ---
    // Prevent overwriting server-side updates (like achievements merged during join_session RPC)
    // with stale local state from the host.
    const existingSquad = Array.isArray(session.squad) ? session.squad : [];
    const incomingSquad = Array.isArray(squad) ? squad : [];

    // Perform a Server-Centric merge to support Differential Sync. 
    // We map through the existing squad and apply updates only for players 
    // included in the incoming payload. This allows the host to send only 
    // the 4 players involved in a match, reducing bandwidth significantly.
    const mergedSquadMap = new Map(existingSquad.map(p => [p.uuid, p]));

    for (const p of incomingSquad) {
        if (!p.uuid) continue;
        const serverP = mergedSquadMap.get(p.uuid);

        const mergedP = serverP ? {
            ...p,
            achievements:    [...new Set([...(p.achievements || []), ...(serverP.achievements || [])])],
            spiritAnimal:    p.spiritAnimal || serverP.spiritAnimal || null,
            teammateHistory: { ...(serverP.teammateHistory || {}), ...(p.teammateHistory || {}) },
            opponentHistory: { ...(serverP.opponentHistory || {}), ...(p.opponentHistory || {}) },
            partnerStats:    { ...(serverP.partnerStats || {}),    ...(p.partnerStats || {}) },
            matchHistory:    (p.matchHistory && p.matchHistory.length > 0) ? p.matchHistory : (serverP.matchHistory || [])
        } : p;

        mergedSquadMap.set(p.uuid, mergedP);
    }

    const mergedSquad = Array.from(mergedSquadMap.values());

    // ── NORMALIZE: Sync career stats to global 'players' table ──────────────
    // Update the master registry with latest career ratings and achievements.
    // This ensures stats are preserved even after a session is deleted.
    const playerRegistryTasks = incomingSquad
        .filter(p => p.uuid)
        .map(p => sbFetch(`/players?uuid=eq.${encodeURIComponent(p.uuid)}`, {
            method: 'PATCH',
            body: {
                rating:       p.rating,
                career_wins:  p.wins,
                career_games: p.games,
                achievements: p.achievements || [],
                spirit_animal: p.spiritAnimal || null,
                last_active:  new Date().toISOString()
            }
        }));
    
    if (playerRegistryTasks.length > 0) await Promise.all(playerRegistryTasks);

    // Key matches — apply the update
    const updateResult = await sbFetch(
        `/sessions?room_code=eq.${encodeURIComponent(room_code)}`,
        {
            method: 'PATCH',
            body: {
                squad:            mergedSquad,
                current_matches,
                player_queue:     player_queue || [],
                uuid_map:         req.body.uuid_map         || {},
                approved_players: req.body.approved_players || {},
                is_open_party:    req.body.is_open_party    || false,
                guest_list:       req.body.guest_list       || [],
                last_active: new Date().toISOString(),
            },
        }
    );

    if (!updateResult.ok) {
        return res.status(500).json({ error: 'Update failed' });
    }

    return res.status(200).json({ updated: true });
}