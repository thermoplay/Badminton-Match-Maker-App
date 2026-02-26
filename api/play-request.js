// =============================================================================
// /api/play-request  — POST / GET / DELETE
// =============================================================================
// POST  : Player submits a join request.
//         Writes to play_requests (for host polling + notification badge)
//         AND upserts to session_members with status:'pending'.
//         If session_members already has status:'active' for this uuid,
//         returns { ok: true, alreadyActive: true } — player skips pending screen.
//
// GET   : Host polls pending requests for a room.
// DELETE: Host dismisses a request (approve or deny both call DELETE).
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

        // ── Step 1: If we have a UUID, check session_members for existing active row ──
        // This is the "Approval Memory" check — returning player after refresh.
        if (uuid) {
            const existing = await sbFetch(
                `/session_members?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(uuid)}&limit=1`
            );
            if (existing.ok && existing.data?.length > 0) {
                const member = existing.data[0];
                if (member.status === 'active') {
                    // Player was already approved — skip pending, go straight to sideline
                    return res.status(200).json({
                        ok:            true,
                        alreadyActive: true,
                        member,
                    });
                }
                // Status is 'pending' — update name in case it changed, fall through to notify host
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
                // Don't create a duplicate play_request if one already exists
                return res.status(200).json({ ok: true, alreadyActive: false });
            }
        }

        // ── Step 2: Insert into session_members (pending) ────────────────────
        // ON CONFLICT DO NOTHING via the unique index — idempotent on re-submit.
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

        // ── Step 3: Insert into play_requests (host notification queue) ──────
        const r = await sbFetch('/play_requests', {
            method: 'POST',
            body: {
                room_code,
                name:        trimmed,
                player_uuid: uuid,
                requested_at: new Date().toISOString(),
            },
        });

        return res.status(r.ok ? 200 : 500).json({ ok: r.ok, alreadyActive: false });
    }

    // ── GET: host polls pending requests ─────────────────────────────────────
    if (req.method === 'GET') {
        const { room_code } = req.query;
        if (!room_code) return res.status(400).json({ error: 'Missing room_code' });
        const r = await sbFetch(
            `/play_requests?room_code=eq.${encodeURIComponent(room_code)}&order=requested_at.asc`
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