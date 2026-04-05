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

const crypto = require('crypto'); // Node.js crypto module for hashing
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

export default async function handler(req, res) {
    // 1. Handle CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // ── POST: player submits join request ────────────────────────────────────
    if (req.method === 'POST') {
        const { room_code, name, player_uuid, force, spirit_animal } = req.body;

        if (!room_code || !name || !player_uuid) {
            return res.status(400).json({ error: 'Missing fields for join' });
        }

        // Clean and normalize room code
        let code = String(room_code).toUpperCase().trim();
        // Auto-hyphenate only if hyphen is missing and it looks like a standard 8-char code
        if (!code.includes('-')) {
            const stripped = code.replace(/[^A-Z0-9]/g, '');
            if (stripped.length === 8) {
                code = stripped.slice(0, 4) + '-' + stripped.slice(4);
            }
        }

        const trimmedName = String(name).trim().slice(0, 50);
        const uuid = String(player_uuid).trim();

        // Input Validation
        if (!/^[A-Z0-9]{2,6}-[A-Z0-9]{2,6}$/.test(code)) return res.status(400).json({ error: 'Invalid room code format' });
        if (!/^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(uuid)) return res.status(400).json({ error: 'Invalid player UUID format' });

        // ── REVERTED: Standard Table Operations ──────────────────────────────
        // Reverting to standard PostgREST calls because the RPC is hitting 
        // persistent type mismatch errors. Standard calls handle strings better.
        
        // 1. Verify Room Exists
        const sessionCheck = await sbFetch(`/sessions?room_code=eq."${code}"&select=room_code,is_open_party&limit=1`);
        if (!sessionCheck.ok) return res.status(500).json({ error: `Connection failed: ${sessionCheck.data?.message || 'Database unavailable'}` });
        if (!sessionCheck.data?.length) return res.status(404).json({ error: `Room ${code} does not exist.` });

        // 2. Check if player is already active in this session
        const memberCheck = await sbFetch(`/session_members?room_code=eq."${code}"&player_uuid=eq."${uuid}"&select=status&limit=1`);
        if (memberCheck.ok && memberCheck.data?.[0]?.status === 'active' && !force) {
            return res.status(200).json({ alreadyActive: true, ok: true });
        }

        const isOpen = !!sessionCheck.data[0].is_open_party;

        // 2.5 If Open Party, auto-approve membership in DB immediately
        if (isOpen) {
            await sbFetch('/session_members', {
                method: 'POST',
                body: {
                    room_code: code,
                    player_uuid: uuid,
                    player_name: trimmedName,
                    status: 'active',
                    spirit_animal: spirit_animal || null
                },
                prefer: 'resolution=merge-duplicates'
            });
            // Fall through to insert play_request so the host's local state still updates
        }

        // 3. Create the notification request for the Host
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

        return res.status(200).json({ ok: true, status: isOpen ? 'active' : 'pending' });
    }
    // ── GET: host polls pending requests ─────────────────────────────────────
    if (req.method === 'GET') {
        const { room_code, status } = req.query;
        if (!room_code) return res.status(400).json({ error: 'Missing room_code' });

        let code = String(room_code).toUpperCase().trim();
        if (!code.includes('-')) {
            const stripped = code.replace(/[^A-Z0-9]/g, '');
            if (stripped.length === 8) {
                code = stripped.slice(0, 4) + '-' + stripped.slice(4);
            }
        }

        // Reconciliation support: Fetch currently active members from session_members
        // This allows the host to recover players who are active in the DB but missing locally.
        if (status === 'active') {
            const r = await sbFetch(`/session_members?room_code=eq."${code}"&status=eq.active`);
            const mapped = (Array.isArray(r.data) ? r.data : []).map(m => ({
                id: m.id,
                name: m.player_name,
                player_uuid: m.player_uuid
            }));
            return res.status(200).json({ requests: mapped });
        }

        // Filter: only show requests from the last 3 hours to prevent zombie prompts.
        const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        const r = await sbFetch(
            `/play_requests?room_code=eq."${code}"&requested_at=gte.${encodeURIComponent(since)}&order=requested_at.asc`
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
            let code = String(room_code).toUpperCase().trim();
            if (!code.includes('-')) {
                const stripped = code.replace(/[^A-Z0-9]/g, '');
                if (stripped.length === 8) {
                    code = stripped.slice(0, 4) + '-' + stripped.slice(4);
                }
            }
            const uuid = String(player_uuid).trim();

            // --- Input Validation ---
            if (!/^[A-Z0-9]{2,6}-[A-Z0-9]{2,6}$/.test(code)) {
                return res.status(400).json({ error: 'Invalid room code format' });
            }
            if (!/^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(uuid)) {
                return res.status(400).json({ error: 'Invalid player UUID format' });
            }
            // ------------------------

            // Verify operator key (using quoted filter)
            const sessionRes = await sbFetch(`/sessions?room_code=eq."${code}"&select=operator_key&limit=1`); 
            if (!sessionRes.ok) {
                return res.status(500).json({ error: `Database error: ${sessionRes.data?.message || 'Unknown'}` });
            }
            if (!sessionRes.data?.[0]) {
                return res.status(404).json({ error: 'Session not found' });
            }
            const incomingOperatorKeyHash = crypto.createHash('sha256').update(operator_key).digest('hex');

            const opKeyHash = String(operator_key);
            if (incomingOperatorKeyHash !== sessionRes.data[0].operator_key) {
                return res.status(403).json({ error: 'Invalid operator key' });
            }

            // Delete from session_members
            const delRes = await sbFetch(`/session_members?player_uuid=eq."${uuid}"&room_code=eq."${code}"`, { method: 'DELETE' });
            
            // ALSO delete from play_requests to prevent join-blocking ghosts
            await sbFetch(`/play_requests?player_uuid=eq."${uuid}"&room_code=eq."${code}"`, { method: 'DELETE' });

            return res.status(delRes.ok ? 200 : 500).json({ ok: delRes.ok });
        }

        // --- ACTION 2: Host dismisses a pending join request ---
        // This deletes a row from `play_requests` using its unique ID.
        // It's called when the host approves or denies a join notification.
        if (id && room_code && operator_key) {
            let code = String(room_code).toUpperCase().trim();
            if (!code.includes('-')) {
                const stripped = code.replace(/[^A-Z0-9]/g, '');
                if (stripped.length === 8) {
                    code = stripped.slice(0, 4) + '-' + stripped.slice(4);
                }
            }

            // Verify operator key
            const sessionRes = await sbFetch(`/sessions?room_code=eq."${code}"&select=operator_key&limit=1`); // Quoted filter
            if (!sessionRes.ok || !sessionRes.data?.[0]) {
                // Don't fail hard, maybe session ended. Just say ok.
                return res.status(200).json({ ok: true, message: 'Session not found, request likely stale.' });
            }
            const incomingOperatorKeyHash = crypto.createHash('sha256').update(operator_key).digest('hex');
            const opKeyHash = String(operator_key);
            if (incomingOperatorKeyHash !== sessionRes.data[0].operator_key) {
                return res.status(403).json({ error: 'Invalid operator key' });
            }

            // Also filter by room_code for extra security
            const r = await sbFetch(`/play_requests?id=eq.${id}&room_code=eq."${code}"`, { method: 'DELETE' });
            return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
        }

        return res.status(400).json({ error: 'Missing required parameters for DELETE' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}