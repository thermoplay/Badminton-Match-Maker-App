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

const hdrs = () => ({
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=representation',
});

async function sbFetch(path, options = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
        headers: { ...hdrs(), ...(options.headers || {}) },
        method:  options.method || 'GET',
        body:    options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

export default async function handler(req, res) {

    // ── POST: player submits join request ────────────────────────────────────
    if (req.method === 'POST') {
        const { room_code, name, player_uuid } = req.body;
        if (!room_code || !name) return res.status(400).json({ error: 'Missing fields' });

        const code    = String(room_code).trim().toUpperCase();
        const trimmed = String(name).trim().slice(0, 50);
        const uuid    = player_uuid ? String(player_uuid).trim() : null;

        // ── Step 1: Check if player is already approved in session_members ────
        // Only this check should short-circuit. A pending row does NOT block us.
        if (uuid) {
            const existing = await sbFetch(
                `/session_members?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(uuid)}&select=status,player_name&limit=1`
            );
            if (existing.ok && existing.data?.length > 0) {
                const member = existing.data[0];

                if (member.status === 'active') {
                    return res.status(200).json({ ok: true, alreadyActive: true });
                }

                // Status is 'pending' — update name if it changed, then FALL THROUGH.
                // Do NOT return early here — we still need to write play_requests.
                if (member.player_name !== trimmed) {
                    await sbFetch(
                        `/session_members?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(uuid)}`,
                        {
                            method:  'PATCH',
                            headers: { 'Prefer': 'return=minimal' },
                            body:    { player_name: trimmed, last_seen: new Date().toISOString() },
                        }
                    );
                }
                // Fall through to Step 2 and Step 3
            }
        }

        // ── Step 2: Duplicate guard — check play_requests, NOT session_members ─
        // Prevent spam: if a play_requests row already exists for this player,
        // the host already has the notification. Don't add a second one.
        if (uuid) {
            const dupCheck = await sbFetch(
                `/play_requests?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(uuid)}&select=id&limit=1`
            );
            if (dupCheck.ok && dupCheck.data?.length > 0) {
                return res.status(200).json({ ok: true, alreadyActive: false });
            }
        }

        // ── Step 3: Insert into play_requests (host notification queue) ──────
        // This is what pollPlayRequests() reads. Always write here.
        const r = await sbFetch('/play_requests', {
            method: 'POST',
            body: {
                room_code:    code,
                name:         trimmed,
                player_uuid:  uuid,
                requested_at: new Date().toISOString(),
            },
        });

        if (!r.ok) {
            return res.status(500).json({ ok: false, error: 'Failed to write play request' });
        }

        // ── Step 4: Upsert into session_members (pending) ────────────────────
        if (uuid) {
            await sbFetch('/session_members', {
                method:  'POST',
                headers: { 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
                body: {
                    room_code:   code,
                    player_uuid: uuid,
                    player_name: trimmed,
                    status:      'pending',
                    joined_at:   new Date().toISOString(),
                    last_seen:   new Date().toISOString(),
                },
            });
        }

        return res.status(200).json({ ok: true, alreadyActive: false });
    }

    // ── GET: host polls pending requests ─────────────────────────────────────
    if (req.method === 'GET') {
        const { room_code } = req.query;
        if (!room_code) return res.status(400).json({ error: 'Missing room_code' });
        const code = String(room_code).trim().toUpperCase();
        const r = await sbFetch(
            `/play_requests?room_code=eq.${encodeURIComponent(code)}&order=requested_at.asc`
        );
        return res.status(200).json({ requests: r.data || [] });
    }

    // ── DELETE: host dismisses a request ─────────────────────────────────────
    if (req.method === 'DELETE') {
        const { id } = req.body;
        if (!id) return res.status(400).json({ error: 'Missing id' });
        const r = await fetch(
            `${SUPABASE_URL}/rest/v1/play_requests?id=eq.${id}`,
            { method: 'DELETE', headers: hdrs() }
        );
        return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}