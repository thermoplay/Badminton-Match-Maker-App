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

const hdrs = (method = 'GET') => {
    const h = {
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type':  'application/json',
    };
    // Preference header is only valid for write operations
    if (method !== 'GET') {
        h['Prefer'] = 'return=representation';
    }
    return h;
};

async function sbFetch(path, options = {}) {
    const method = options.method || 'GET';
    // Robust URL construction: ensure no double slashes and handle trailing slashes
    const baseUrl = SUPABASE_URL.endsWith('/') ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL;
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    
    const res = await fetch(`${baseUrl}/rest/v1${cleanPath}`, {
        headers: { ...hdrs(method), ...(options.headers || {}) },
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

export default async function handler(req, res) {
    // 1. Handle CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // ── POST: player submits join request ────────────────────────────────────
    if (req.method === 'POST') {
        const { room_code, name, player_uuid, force } = req.body;

        // The `leave: true` functionality has been removed. Player removal is now
        // exclusively handled by the authenticated DELETE endpoint, which is triggered
        // by the host. This prevents a player from being able to remove another
        // player from a session without authorization.

        if (!room_code || !name) {
            return res.status(400).json({ error: 'Missing fields for join' });
        }

        // Normalize room code: remove non-alphanumeric and insert hyphen if length is 8
        let code = String(room_code).replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (code.length === 8) {
            code = code.slice(0, 4) + '-' + code.slice(4);
        }

        const trimmedName = String(name).trim().slice(0, 50);
        const uuid = player_uuid ? String(player_uuid).trim() : null;

        // ── Step 0: Validate Session Exists ──────────────────────────────────
        // Use quoted values ("") in the query to prevent PostgREST from choking on hyphens
        const sessionCheck = await sbFetch(`/sessions?room_code=eq."${encodeURIComponent(code)}"&select=id,is_open_party,guest_list,last_active&limit=1`);

        if (!sessionCheck.ok) {
            return res.status(500).json({ error: `Database communication error (${sessionCheck.status}).` });
        }

        if (!sessionCheck.data || sessionCheck.data.length === 0) {
            return res.status(404).json({ error: `Room "${code}" not found. Please verify the code with the host.` });
        }

        const isOpenParty = !!sessionCheck.data[0].is_open_party;
        const guestList   = sessionCheck.data[0].guest_list || [];
        const isGuest = Array.isArray(guestList) && guestList.some(g => 
            (typeof g === 'string' && g.toLowerCase() === trimmedName.toLowerCase()) || 
            (uuid && g === uuid)
        );

        // --- Input Validation ---
        if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
            return res.status(400).json({ error: 'Invalid room code format' });
        }
        if (uuid && !/^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(uuid)) {
            return res.status(400).json({ error: 'Invalid player UUID format' });
        }
        // ------------------------

         // ── Step 1: Check if player is already approved ─────────────────────
        if (uuid && !force) {
            const existing = await sbFetch(
                `/session_members?room_code=eq."${encodeURIComponent(code)}"&player_uuid=eq."${encodeURIComponent(uuid)}"&select=status,player_name&limit=1`
            );
            if (existing.ok && existing.data?.length > 0) {
                const member = existing.data[0];
                // If already active, return true immediately. 
                // This allows returning players to bypass the pending screen.
                if (member.status === 'active') {
                    return res.status(200).json({ ok: true, alreadyActive: true });
                }
            }
        }

        // ── Step 2: Handle Automatic Approval (Open Party or Guest) ──────────
        if (isOpenParty || isGuest) {
            if (uuid) {
                // Set member status to ACTIVE immediately in the database
                await sbFetch('/session_members', {
                    method:  'POST',
                    headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
                    body:    { room_code: code, player_uuid: uuid, player_name: trimmedName, status: 'active', last_seen: new Date().toISOString() },
                });
            }
            
            // Create notification so host's client adds player to squad in local memory.
            // We ignore failures here (like duplicates) to ensure the join itself succeeds.
            await sbFetch('/play_requests', {
                method: 'POST',
                headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
                body: { room_code: code, name: trimmedName, player_uuid: uuid, requested_at: new Date().toISOString() },
            });

            // For Open Parties/Guests, if we auto-approved, the player is immediately active.
            return res.status(200).json({ ok: true, alreadyActive: true });
        }

        // ── Step 3: Handle Manual Approval (Closed Party) ────────────────────
        // Duplicate guard for pending notifications to prevent spam        
        if (uuid) {
            const dup = await sbFetch(`/play_requests?room_code=eq."${encodeURIComponent(code)}"&player_uuid=eq."${encodeURIComponent(uuid)}"&select=id&limit=1`);
            if (dup.ok && dup.data?.length > 0) {
                return res.status(200).json({ ok: true, alreadyActive: false });
            }
        }
        // Insert notification for the host
        const r = await sbFetch('/play_requests', {
            method: 'POST',
            body: { room_code: code, name: trimmedName, player_uuid: uuid, requested_at: new Date().toISOString() },
        });

        if (!r.ok) return res.status(500).json({ error: 'Failed to create join request' });

        // Ensure player is recorded as PENDING in the membership table
        if (uuid) {
            await sbFetch('/session_members', {
                method:  'POST',
                headers: { 'Prefer': 'resolution=merge-duplicates' },
                body:    { room_code: code, player_uuid: uuid, player_name: trimmedName, status: 'pending', last_seen: new Date().toISOString() },
            });
        }

        return res.status(200).json({ ok: true, alreadyActive: false });
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
            const r = await sbFetch(`/session_members?room_code=eq."${encodeURIComponent(code)}"&status=eq.active`);
            const mapped = (Array.isArray(r.data) ? r.data : []).map(m => ({
                id: m.id,
                name: m.player_name,
                player_uuid: m.player_uuid
            }));
            return res.status(200).json({ requests: mapped });
        }

        const r = await sbFetch(
            `/play_requests?room_code=eq."${encodeURIComponent(code)}"&order=requested_at.asc`
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
            if (!sessionRes.ok || !sessionRes.data?.[0]) {
                return res.status(404).json({ error: 'Session not found' });
            }
            const opKeyHash = String(operator_key);
            if (opKeyHash !== sessionRes.data[0].operator_key) {
                return res.status(403).json({ error: 'Invalid operator key' });
            }

            // Delete from session_members
            const delRes = await sbFetch(`/session_members?player_uuid=eq."${encodeURIComponent(uuid)}"&room_code=eq."${encodeURIComponent(code)}"`, { method: 'DELETE' });
            
            // ALSO delete from play_requests to prevent join-blocking ghosts
            await sbFetch(`/play_requests?player_uuid=eq."${encodeURIComponent(uuid)}"&room_code=eq."${encodeURIComponent(code)}"`, { method: 'DELETE' });

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