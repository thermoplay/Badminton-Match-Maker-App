// =============================================================================
// /api/member-approve  — PATCH
// =============================================================================
// Called by the HOST when they click 'Approve' on a play request.
// Sets session_members.status = 'active' for the given player_uuid + room_code.
//
// Security: requires operator_key — verified server-side against the sessions table.
// The player's device is listening on postgres_changes for their own row,
// so Supabase Realtime pushes the status change to their phone within ~100ms.
//
// REQUEST BODY:
//   { room_code, player_uuid, operator_key }
//
// RESPONSE:
//   { ok: true, approved: true }
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const hdrs = {
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=minimal',
};

async function sbFetch(path, options = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
        headers: { ...hdrs, ...(options.headers || {}) },
        method:  options.method || 'GET',
        body:    options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

export default async function handler(req, res) {
    if (req.method !== 'PATCH') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { room_code, player_uuid, operator_key } = req.body;

    if (!room_code || !player_uuid || !operator_key) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const code = String(room_code).trim().toUpperCase();
    const uuid = String(player_uuid).trim();

    // --- Input Validation ---
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
        return res.status(400).json({ error: 'Invalid room code format' });
    }
    if (!/^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(uuid)) {
        return res.status(400).json({ error: 'Invalid player UUID format' });
    }
    // ------------------------

    // ── Verify operator_key ─────────────────────────────────────────────────
    // Never trust the client for host identity — always cross-check the DB.
    // Hash the incoming raw key and compare it to the stored hash.
    const sessionCheck = await sbFetch(
        `/sessions?room_code=eq.${encodeURIComponent(code)}&select=operator_key_hash&limit=1`
    );

    if (!sessionCheck.ok || !sessionCheck.data?.length) {
        return res.status(404).json({ error: 'Session not found' });
    }

    if (sessionCheck.data[0].operator_key_hash !== operator_key) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    // ── Flip status to 'active' ─────────────────────────────────────────────
    // Supabase Realtime will fire a postgres_changes event to any subscriber
    // filtering on this room_code + player_uuid, which the player's phone
    // catches in subscribeRealtime() → _handleMemberChange().
    const update = await sbFetch(
        `/session_members?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(uuid)}`,
        {
            method: 'PATCH',
            body: {
                status:      'active',
                approved_at: new Date().toISOString(),
            },
        }
    );

    if (!update.ok) {
        console.error('member-approve patch failed:', update.status, update.data);
        return res.status(500).json({ error: 'Approval update failed' });
    }

    return res.status(200).json({ ok: true, approved: true });
}
