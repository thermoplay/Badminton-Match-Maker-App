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
        const { room_code, name, player_uuid, force, spirit_animal } = req.body;

        if (!room_code || !name || !player_uuid) {
            return res.status(400).json({ error: 'Missing fields for join' });
        }

        // Normalize room code
        let code = String(room_code).replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (code.length === 8) code = code.slice(0, 4) + '-' + code.slice(4);

        const trimmedName = String(name).trim().slice(0, 50);
        const uuid = String(player_uuid).trim();

        // Input Validation
        if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return res.status(400).json({ error: 'Invalid room code format' });
        if (!/^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(uuid)) return res.status(400).json({ error: 'Invalid player UUID format' });

        // ── SINGLE ATOMIC RPC CALL ───────────────────────────────────────────
        // This moves session validation, existing status checks, and multiple 
        // upserts into a single database transaction for improved reliability.
        const r = await sbFetch('/rpc/join_session', {
            method:  'POST',
            body:    { 
                p_room_code: code, 
                p_player_name: trimmedName, 
                p_player_uuid: uuid,
                p_spirit_animal: (spirit_animal === undefined || spirit_animal === '') ? null : spirit_animal,
                p_force: !!force 
            },
        });

        if (!r.ok) return res.status(r.status || 500).json({ error: r.data?.message || 'Database error' });
        if (r.data?.error) return res.status(r.data.status || 400).json({ error: r.data.error });

        return res.status(200).json(r.data);
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
            const r = await sbFetch(`/session_members?room_code=eq.${encodeURIComponent(code)}&status=eq.active`);
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
            if (!sessionRes.ok || !sessionRes.data?.[0]) {
                return res.status(404).json({ error: 'Session not found' });
            }
            const opKeyHash = String(operator_key);
            if (opKeyHash !== sessionRes.data[0].operator_key) {
                return res.status(403).json({ error: 'Invalid operator key' });
            }

            // Delete from session_members
            const delRes = await sbFetch(`/session_members?player_uuid=eq.${encodeURIComponent(uuid)}&room_code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' });
            
            // ALSO delete from play_requests to prevent join-blocking ghosts
            await sbFetch(`/play_requests?player_uuid=eq.${encodeURIComponent(uuid)}&room_code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' });

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