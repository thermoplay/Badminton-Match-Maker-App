// =============================================================================
// /api/member-upsert  — POST
// =============================================================================
// Called by the player's device when they join a session.
// Creates a row in session_members with status:'pending' if one doesn't exist.
// If a row already exists for this uuid+room_code, it does nothing
// (preserves 'active' status so refresh doesn't reset an approved player).
//
// REQUEST BODY:
//   { room_code, player_uuid, player_name }
//
// RESPONSE:
//   { ok: true, status: 'pending' | 'active', member: { ...row } }
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const hdrs = {
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=representation',
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
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { room_code, player_uuid, player_name } = req.body;

    if (!room_code || !player_uuid || !player_name) {
        return res.status(400).json({ error: 'Missing required fields: room_code, player_uuid, player_name' });
    }

    // Sanitise
    const trimmedName = String(player_name).trim().slice(0, 50);
    const code        = String(room_code).trim().toUpperCase();
    const uuid        = String(player_uuid).trim();

    if (!trimmedName || !uuid) {
        return res.status(400).json({ error: 'Invalid name or uuid' });
    }

    // ── Step 1: Check if this player already has a row in this session ──────
    // If they do and status is 'active', just return it — DO NOT reset to pending.
    const existing = await sbFetch(
        `/session_members?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(uuid)}&limit=1`
    );

    if (existing.ok && existing.data?.length > 0) {
        const member = existing.data[0];

        // Player exists — update their name in case it changed, but NEVER touch status
        if (member.player_name !== trimmedName) {
            await sbFetch(
                `/session_members?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(uuid)}`,
                {
                    method:  'PATCH',
                    headers: { 'Prefer': 'return=representation' },
                    body:    { player_name: trimmedName, last_seen: new Date().toISOString() },
                }
            );
        }

        // Return current status — caller uses this to decide whether to skip pending screen
        return res.status(200).json({
            ok:     true,
            status: member.status,  // 'pending' | 'active'
            member: { ...member, player_name: trimmedName },
        });
    }

    // ── Step 2: No existing row — insert with status:'pending' ────────────
    const insert = await sbFetch('/session_members', {
        method: 'POST',
        body: {
            room_code:   code,
            player_uuid: uuid,
            player_name: trimmedName,
            status:      'pending',
            joined_at:   new Date().toISOString(),
            last_seen:   new Date().toISOString(),
        },
    });

    if (!insert.ok) {
        console.error('member-upsert insert failed:', insert.status, insert.data);
        return res.status(500).json({ error: 'Failed to register member' });
    }

    const member = Array.isArray(insert.data) ? insert.data[0] : insert.data;

    return res.status(200).json({
        ok:     true,
        status: 'pending',
        member,
    });
}
