// =============================================================================
// /api/member-rename  — PATCH
// =============================================================================
// Called by the PLAYER when they update their display name via editName().
// Updates session_members.player_name for their uuid + room_code.
//
// This write triggers a Supabase Realtime postgres_changes UPDATE event which
// the HOST's subscribeRealtime() channel catches in _handleMemberChange(),
// immediately refreshing the name on the host's squad list — no page reload.
//
// No operator_key needed here: a player can only rename themselves (UUID-scoped).
//
// REQUEST BODY:
//   { room_code, player_uuid, new_name }
//
// RESPONSE:
//   { ok: true, updated: true }
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const hdrs = {
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=minimal',
};

export default async function handler(req, res) {
    if (req.method !== 'PATCH') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { room_code, player_uuid, new_name } = req.body;

    if (!room_code || !player_uuid || !new_name) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const code    = String(room_code).trim().toUpperCase();
    const uuid    = String(player_uuid).trim();
    const trimmed = String(new_name).trim().slice(0, 50);

    if (!trimmed) {
        return res.status(400).json({ error: 'Name cannot be empty' });
    }

    const res2 = await fetch(
        `${SUPABASE_URL}/rest/v1/session_members?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(uuid)}`,
        {
            method:  'PATCH',
            headers: hdrs,
            body:    JSON.stringify({ player_name: trimmed, last_seen: new Date().toISOString() }),
        }
    );

    if (!res2.ok) {
        const err = await res2.text();
        console.error('member-rename patch failed:', res2.status, err);
        return res.status(500).json({ error: 'Rename failed' });
    }

    return res.status(200).json({ ok: true, updated: true });
}
