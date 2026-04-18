// =============================================================================
// /api/play-request  — POST / GET / DELETE
// =============================================================================
// POST  : Player submits a join request.
//         1. If session_members shows status:'active' → player already approved,
//            return { alreadyActive: true } so client skips the pending screen.
//         2. Check play_requests for an existing pending row (real dup-guard).
//            If one exists already, skip the insert to prevent spam.
//         3. Insert into play_requests — THIS is what the host polls/sees.
//         4. Upsert into session_members with status:'pending'.
//
// GET   : Host polls pending requests for a room.
// DELETE: Host dismisses a request (approve or deny both call DELETE).
//
// ── ROOT CAUSE FIX ────────────────────────────────────────────────────────────
// The previous version checked session_members for a pending row and returned
// early WITHOUT writing to play_requests. But member-upsert.js always creates
// a session_members row BEFORE play-request.js is called, so play_requests was
// NEVER written → host saw zero requests every time.
//
// The duplicate guard now correctly checks play_requests (the notification
// table) rather than session_members (the identity table). These are separate
// concerns: a player can be in session_members and still need to send a
// play_request to get the host's attention.
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sbFetch(path, options = {}) {
    const method = options.method || 'GET';
    const baseUrl = SUPABASE_URL.endsWith('/') ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL;
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    
    const headers = {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
    };

    if (method !== 'GET') {
        headers['Prefer'] = options.prefer || 'return=representation';
    }

    const res = await fetch(`${baseUrl}/rest/v1${cleanPath}`, {
        headers: { ...headers, ...(options.headers || {}) },
        method:  method,
        body:    options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await res.text();
    if (!res.ok) {
        console.error(`[sbFetch] Supabase Error ${res.status}:`, text);
    }

    let data = null;
    try {
        if (text) data = JSON.parse(text);
    } catch (e) {
        console.error('[sbFetch] JSON parse failed:', text);
    }
    return { ok: res.ok, status: res.status, data };
}

/** Helper to construct a canonical player object */
function createPlayerObject(name, uuid, skill, emoji) {
    return {
        name,
        uuid,
        active: true,
        wins: 0, games: 0, streak: 0, sessionPlayCount: 0,
        waitRounds: 0, consecutiveGames: 0, forcedRest: false, acknowledged: false,
        teammateHistory: {}, opponentHistory: {}, partnerStats: {},
        form: [], achievements: [], matchHistory: [],
        spiritAnimal: emoji || null,
        skillLevel: skill || 'Intermediate'
    };
}

export default async function handler(req, res) {
    // 1. Handle CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // ── POST: player submits join request ────────────────────────────────────
    if (req.method === 'POST') {
        const { room_code, name, player_uuid, force, spirit_animal, skill_level } = req.body;

        if (!room_code || !name || !player_uuid) {
            return res.status(400).json({ error: 'Missing fields for join' });
        }

        // Normalize room code
        let code = String(room_code).replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (code.length === 8) code = code.slice(0, 4) + '-' + code.slice(4);

        if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
            return res.status(400).json({ error: 'Invalid room code format' });
        }

        const trimmedName = String(name).trim().slice(0, 50);
        const uuid = String(player_uuid).trim();

        // --- Input Validation ---
        if (trimmedName.length < 2) {
            return res.status(400).json({ error: 'Player name must be at least 2 characters' });
        }
        if (!/^[a-zA-Z0-9\s.\-_'()]+$/.test(trimmedName)) {
            return res.status(400).json({ error: 'Player name contains unsupported characters' });
        }
        if (!/^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(uuid)) {
            return res.status(400).json({ error: 'Invalid player identity format' });
        }

        const validLevels = ['Novice', 'Intermediate', 'Advanced'];
        const finalSkill = validLevels.includes(skill_level) ? skill_level : 'Intermediate';
        // 1. Verify Room Exists and Fetch Metadata
        // We fetch the squad array to check if the player is already "in the queue" (host's local state)
        const sessionCheck = await sbFetch(`/sessions?room_code=eq.${encodeURIComponent(code)}&select=room_code,is_open_party,squad,player_queue&limit=1`);
        if (!sessionCheck.ok || !sessionCheck.data?.length) {
            return res.status(404).json({ error: 'Room not found' });
        }

        const session = sessionCheck.data[0];
        const isOpenParty = !!session.is_open_party;
        const currentSquad = Array.isArray(session.squad) ? session.squad : [];
                const currentQueue = Array.isArray(session.player_queue) ? session.player_queue : [];

        // Smart Recognition: Check if player is already in the host's squad list (the "Queue")
        // This handles cases where the host added them manually (name match) or they rejoined (UUID match).
        const inSquadIdx = currentSquad.findIndex(p => (p.uuid && p.uuid === uuid) || (p.name && p.name.toLowerCase() === trimmedName.toLowerCase()));
        if (inSquadIdx !== -1) {
             const player = currentSquad[inSquadIdx];
             let needsIdentityLink = false;
             let queueChanged = false;

             // Identity Upgrade: If the host added them as a guest (no UUID), link the UUID now
             if (!player.uuid && uuid) {
                 player.uuid = uuid;
                 needsIdentityLink = true;
             }

             // Update metadata if provided during re-check-in
             if (spirit_animal && player.spiritAnimal !== spirit_animal) { player.spiritAnimal = spirit_animal; needsIdentityLink = true; }
             if (finalSkill && player.skillLevel !== finalSkill) { player.skillLevel = finalSkill; needsIdentityLink = true; }
             
             // Intent to Play: Ensure player is active and in the rotation
             if (!player.active) { player.active = true; needsIdentityLink = true; }
             if (!currentQueue.includes(player.uuid)) {
                 currentQueue.push(player.uuid);
                 queueChanged = true;
             }

             if (needsIdentityLink || queueChanged) {
                 await sbFetch(`/sessions?room_code=eq.${encodeURIComponent(code)}`, {
                     method: 'PATCH',
                     body: { 
                         squad: currentSquad, 
                         player_queue: currentQueue,
                         last_active: new Date().toISOString() 
                     }
                 });
             }

             // Optimization: If already in session, return state + global stats so they render instantly
             const [fullSession, globalProfile] = await Promise.all([
                 sbFetch(`/sessions?room_code=eq.${encodeURIComponent(code)}&select=squad,current_matches,court_names,is_open_party,sport,approved_players&limit=1`),
                 sbFetch(`/players?uuid=eq.${encodeURIComponent(uuid)}&select=uuid,name,spirit_animal,skill_level,total_wins,total_games,achievements,teammate_history,opponent_history,partner_stats&limit=1`)
             ]);
             return res.status(200).json({ alreadyActive: true, ok: true, session: fullSession.data?.[0], global: globalProfile.data?.[0] });
        }

        // 2. Check if player is already a member (any status) in session_members
        const existingMemberCheck = await sbFetch(`/session_members?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(uuid)}&select=status&limit=1`);
        const existingMemberStatus = existingMemberCheck.ok && existingMemberCheck.data?.length > 0 ? existingMemberCheck.data[0].status : null;

        if (existingMemberStatus === 'active') {
            // Player is already active. No need for a new request.
            const globalProfile = await sbFetch(`/players?uuid=eq.${encodeURIComponent(uuid)}&select=uuid,name,spirit_animal,skill_level,total_wins,total_games,achievements,teammate_history,opponent_history,partner_stats&limit=1`);
            return res.status(200).json({ alreadyActive: true, ok: true, global: globalProfile.data?.[0] });
        }

        // 3. Open Party Auto-Approve / Upgrade
        // If Open Party is ON, bypass play_requests and go straight to session_members as active.
        // This also upgrades 'pending' members to 'active' immediately.
        if (isOpenParty) {
            // --- SERVER-AUTHORITATIVE JOIN ---
            // Instead of just notifying the host, we modify the session state directly.
            
            // 1. Resolve potential name collisions
            let finalName = trimmedName;
            let counter = 1;
            while (currentSquad.some(p => p.name.toLowerCase() === finalName.toLowerCase())) {
                finalName = `${trimmedName} (${counter++})`;
            }

                        // 2. Construct player and prepare arrays
            const newPlayer = createPlayerObject(finalName, uuid, finalSkill, spirit_animal);
                        const newSquad = [...currentSquad, newPlayer];

            const newQueue = [...currentQueue.filter(id => id !== uuid), uuid];

            // 3. Atomic Session Update
            const updateSession = await sbFetch(`/sessions?room_code=eq.${encodeURIComponent(code)}`, {
                method: 'PATCH',
                body: {
                    squad: newSquad,
                    player_queue: newQueue,
                    last_active: new Date().toISOString()
                }
            });

            if (updateSession.ok) {
                // 4. Update member identity table
                await sbFetch('/session_members', {
                    method: 'POST',
                    prefer: 'resolution=merge-duplicates',
                    body: {
                        room_code: code,
                        player_uuid: uuid,
                        player_name: trimmedName,
                        spirit_animal: spirit_animal || null,
                        skill_level: finalSkill,
                        status: 'active',
                        approved_at: new Date().toISOString()
                    }
                });

                // 5. Fetch and return finalized state
                const [fullSession, globalProfile] = await Promise.all([
                    sbFetch(`/sessions?room_code=eq.${encodeURIComponent(code)}&select=squad,current_matches,court_names,is_open_party,sport,approved_players&limit=1`),
                    sbFetch(`/players?uuid=eq.${encodeURIComponent(uuid)}&select=uuid,name,spirit_animal,skill_level,total_wins,total_games,achievements,teammate_history,opponent_history,partner_stats&limit=1`)
                ]);
                
                return res.status(200).json({ 
                    ok: true, 
                    status: 'active', 
                    autoApproved: true, 
                    session: fullSession.data?.[0], 
                    global: globalProfile.data?.[0] 
                });
            }
        }

        // 4. Default: If member exists but room is NOT open, keep them in their current state (likely pending)
        if (existingMemberStatus) {
            return res.status(200).json({ ok: true, status: existingMemberStatus });
        }

        // 4. Duplicate Guard: Check if a play_request already exists for this player
        const existingRequest = await sbFetch(`/play_requests?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(uuid)}&limit=1`);
        if (existingRequest.ok && existingRequest.data?.length > 0) {
            return res.status(200).json({ ok: true, status: 'pending', id: existingRequest.data[0].id, alreadyRequested: true });
        }

        // 5. Fallback: Create the notification request for the Host (Lobby Mode)
        const insertReq = await sbFetch('/play_requests', {
            method: 'POST',
            body: {
                room_code: code,
                player_uuid: uuid,
                name: trimmedName,
                spirit_animal: spirit_animal || null
            }
        });

        if (!insertReq.ok) return res.status(500).json({ error: 'Failed to send join request' });

        // Return the created ID so the broadcast event can include it for the host
        const newRequest = insertReq.data?.[0];

        return res.status(200).json({ ok: true, status: 'pending', id: newRequest?.id });
    }

    // ── PATCH: batch resolve/approve play requests ───────────────────────────
    if (req.method === 'PATCH') {
        const { ids, room_code, operator_key } = req.body;

        if (!ids || !Array.isArray(ids) || !room_code || !operator_key) {
            return res.status(400).json({ error: 'Missing batch parameters' });
        }

        let code = String(room_code).replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (code.length === 8) code = code.slice(0, 4) + '-' + code.slice(4);

        // Verify operator key
        const sessionRes = await sbFetch(`/sessions?room_code=eq.${encodeURIComponent(code)}&select=operator_key&limit=1`);
        if (!sessionRes.ok || !sessionRes.data?.[0]) return res.status(404).json({ error: 'Session not found' });
        if (operator_key !== sessionRes.data[0].operator_key) return res.status(403).json({ error: 'Invalid operator key' });

        // 1. Fetch Request Details
        const idList = ids.map(id => String(id)).join(',');
        const reqsRes = await sbFetch(`/play_requests?room_code=eq.${encodeURIComponent(code)}&id=in.(${idList})&select=player_uuid,name,spirit_animal`);
        if (!reqsRes.ok || !reqsRes.data?.length) return res.status(400).json({ error: 'No valid requests found' });

        // 2. Fetch Session for authoritative merge
        const sessCheck = await sbFetch(`/sessions?room_code=eq.${encodeURIComponent(code)}&select=squad,player_queue&limit=1`);
        const session = sessCheck.data[0];
        let newSquad = Array.isArray(session.squad) ? [...session.squad] : [];
        let newQueue = Array.isArray(session.player_queue) ? [...session.player_queue] : [];

        const activatedUuids = [];

        for (const r of reqsRes.data) {
            if (!r.player_uuid) continue;
            activatedUuids.push(r.player_uuid);
            
            // Collision prevention
            let finalName = r.name;
            let counter = 1;
            while (newSquad.some(p => p.name.toLowerCase() === finalName.toLowerCase())) {
                finalName = `${r.name} (${counter++})`;
            }

            // Add to squad if not present
            if (!newSquad.some(p => p.uuid === r.player_uuid)) {
                newSquad.push(createPlayerObject(finalName, r.player_uuid, 'Intermediate', r.spirit_animal));
            }
            // Add to queue if not present
            if (!newQueue.includes(r.player_uuid)) newQueue.push(r.player_uuid);
        }

        // 3. Commit authoritative session update
        await sbFetch(`/sessions?room_code=eq.${encodeURIComponent(code)}`, {
            method: 'PATCH',
            body: { squad: newSquad, player_queue: newQueue, last_active: new Date().toISOString() }
        });

        // 4. Batch Update member statuses
        const uuidList = activatedUuids.map(u => `"${u}"`).join(',');
        await sbFetch(`/session_members?room_code=eq.${encodeURIComponent(code)}&player_uuid=in.(${uuidList})`, {
            method: 'PATCH',
            body: { status: 'active', approved_at: new Date().toISOString() }
        });

        // 3. Delete the notification requests
        const delRes = await sbFetch(`/play_requests?room_code=eq.${encodeURIComponent(code)}&id=in.(${idList})`, { method: 'DELETE' });
        return res.status(delRes.ok ? 200 : 500).json({ ok: delRes.ok });
    }

    // ── GET: host polls pending requests ─────────────────────────────────────
    if (req.method === 'GET') {
        const { room_code, status } = req.query;
        if (!room_code) return res.status(400).json({ error: 'Missing room_code' });

        let code = String(room_code).replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (code.length === 8) {
            code = code.slice(0, 4) + '-' + code.slice(4);
        }

        // Reconciliation support: Fetch currently active members from session_members
        // This allows the host to recover players who are active in the DB but missing locally.
        if (status === 'active') {
            const { exclude } = req.query;
            let query = `/session_members?room_code=eq.${encodeURIComponent(code)}&status=eq.active&select=id,player_name,player_uuid,spirit_animal,skill_level`;
            
            if (exclude) {
                const uuids = String(exclude).split(',').map(u => u.trim()).filter(u => /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(u));
                if (uuids.length > 0) {
                    const list = uuids.map(u => `"${u}"`).join(',');
                    query += `&player_uuid=not.in.(${list})`;
                }
            }

            const r = await sbFetch(query);
            const mapped = (Array.isArray(r.data) ? r.data : []).map(m => ({
                id: m.id,
                name: m.player_name,
                player_uuid: m.player_uuid,
                spirit_animal: m.spirit_animal,
                skill_level: m.skill_level
            }));
            return res.status(200).json({ requests: mapped });
        }

        // Filter: only show requests from the last 3 hours to prevent zombie prompts.
        const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        const r = await sbFetch(
            `/play_requests?room_code=eq.${encodeURIComponent(code)}&requested_at=gte.${encodeURIComponent(since)}&order=requested_at.asc`
        );
        return res.status(200).json({ requests: r.data || [] });
    }

    // ── DELETE: host dismisses a request ─────────────────────────────────────
    if (req.method === 'DELETE') {
        const { id, room_code, player_uuid, operator_key } = req.body;

        // --- ACTION 1: Host removes a player from the session ---
        // This is an authenticated action that deletes a row from `session_members`.
        // It is triggered by the host UI (e.g., player leaves, host kicks player).
        if (player_uuid && room_code && operator_key) {
            let code = String(room_code).replace(/[^A-Z0-9]/gi, '').toUpperCase();
            if (code.length === 8) {
                code = code.slice(0, 4) + '-' + code.slice(4);
            }
            const uuid = String(player_uuid).trim();

            // --- Input Validation ---
            if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
                return res.status(400).json({ error: 'Invalid room code format' });
            }
            if (!/^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(uuid)) {
                return res.status(400).json({ error: 'Invalid player UUID format' });
            }
            // ------------------------

            // Verify operator key
            const sessionRes = await sbFetch(`/sessions?room_code=eq.${encodeURIComponent(code)}&select=operator_key&limit=1`);
            if (!sessionRes.ok) {
                return res.status(500).json({ error: `Database error: ${sessionRes.data?.message || 'Unknown'}` });
            }
            if (!sessionRes.data?.[0]) {
                return res.status(404).json({ error: 'Session not found' });
            }

            const opKeyHash = String(operator_key);
            if (opKeyHash !== sessionRes.data[0].operator_key) {
                return res.status(403).json({ error: 'Invalid operator key' });
            }

            // --- AUTHORITATIVE REMOVAL ---
            // Remove from squad and player_queue arrays in sessions table
            const squad = Array.isArray(sessionRes.data[0].squad) ? sessionRes.data[0].squad : [];
            const queue = Array.isArray(sessionRes.data[0].player_queue) ? sessionRes.data[0].player_queue : [];
            
            const filteredSquad = squad.filter(p => p.uuid !== uuid);
            const filteredQueue = queue.filter(id => id !== uuid);

            await sbFetch(`/sessions?room_code=eq.${encodeURIComponent(code)}`, {
                method: 'PATCH',
                body: { 
                    squad: filteredSquad, 
                    player_queue: filteredQueue,
                    last_active: new Date().toISOString() 
                }
            });

            // Delete from session_members
            const delRes = await sbFetch(`/session_members?player_uuid=eq.${encodeURIComponent(uuid)}&room_code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' });
            await sbFetch(`/play_requests?player_uuid=eq.${encodeURIComponent(uuid)}&room_code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' });
            await sbFetch(`/passport_signals?player_uuid=eq.${encodeURIComponent(uuid)}&room_code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' });

            return res.status(delRes.ok ? 200 : 500).json({ ok: delRes.ok });
        }

        // --- ACTION 2: Host dismisses a pending join request ---
        // This deletes a row from `play_requests` using its unique ID.
        // It's called when the host approves or denies a join notification.
        if (id && room_code && operator_key) {
            let code = String(room_code).replace(/[^A-Z0-9]/gi, '').toUpperCase();
            if (code.length === 8) {
                code = code.slice(0, 4) + '-' + code.slice(4);
            }

            // Verify operator key
            const sessionRes = await sbFetch(`/sessions?room_code=eq.${encodeURIComponent(code)}&select=operator_key&limit=1`);
            if (!sessionRes.ok || !sessionRes.data?.[0]) {
                // Don't fail hard, maybe session ended. Just say ok.
                return res.status(200).json({ ok: true, message: 'Session not found, request likely stale.' });
            }
            const opKeyHash = String(operator_key);
            if (opKeyHash !== sessionRes.data[0].operator_key) {
                return res.status(403).json({ error: 'Invalid operator key' });
            }

            // Also filter by room_code for extra security
            const r = await sbFetch(`/play_requests?id=eq.${id}&room_code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' });
            return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
        }

        return res.status(400).json({ error: 'Missing required parameters for DELETE' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}