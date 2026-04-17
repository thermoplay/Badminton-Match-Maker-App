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

async function sbFetch(path, options = {}) {
    const method = options.method || 'GET';
    const baseUrl = SUPABASE_URL.endsWith('/') ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL;
    const cleanPath = path.startsWith('/') ? path : `/${path}`;

    const headers = {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        options.prefer || 'return=minimal',
    };

    const res = await fetch(`${baseUrl}/rest/v1${cleanPath}`, {
        headers: { ...headers, ...(options.headers || {}) },
        method,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

export default async function handler(req, res) {
    if (req.method !== 'PATCH') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { room_code, player_uuid, new_name, spirit_animal } = req.body;

    if (!room_code || !player_uuid || (!new_name && spirit_animal === undefined)) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    let code = String(room_code).replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (code.length === 8) {
        code = code.slice(0, 4) + '-' + code.slice(4);
    }

    const uuid    = String(player_uuid).trim();
    const trimmed = String(new_name).trim().slice(0, 50);

    // --- Input Validation ---
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
        return res.status(400).json({ error: 'Invalid room code format' });
    }
    if (!/^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(uuid)) {
        return res.status(400).json({ error: 'Invalid player UUID format' });
    }
    if (new_name && trimmed.length < 2) {
        return res.status(400).json({ error: 'Player name must be at least 2 characters' });
    }
    if (new_name && !/^[a-zA-Z0-9\s.\-_'()]+$/.test(trimmed)) {
        return res.status(400).json({ error: 'Player name contains unsupported characters' });
    }
    // ------------------------

    const sessionUpdates = { last_seen: new Date().toISOString() };
    if (new_name) sessionUpdates.player_name = trimmed;
    if (spirit_animal !== undefined) sessionUpdates.spirit_animal = spirit_animal;

    const profileUpdates = {};
    if (new_name) profileUpdates.name = trimmed;
    if (spirit_animal !== undefined) profileUpdates.spirit_animal = spirit_animal;

    const res2 = await sbFetch(
        `/session_members?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(uuid)}`,
        { method: 'PATCH', body: sessionUpdates }
    );

    // Sync profile changes to global players table to maintain identity integrity
    if (Object.keys(profileUpdates).length > 0) {
        await sbFetch(`/players?uuid=eq.${encodeURIComponent(uuid)}`, {
            method: 'PATCH',
            body:   profileUpdates
        });
    }

    if (!res2.ok) {
        console.error('member-rename patch failed:', res2.status, res2.data);
        return res.status(500).json({ error: 'Rename failed' });
    }

    const reqUpdates = {};
    if (new_name) reqUpdates.name = trimmed;
    if (spirit_animal !== undefined) reqUpdates.spirit_animal = spirit_animal;

    // Also update any pending play_requests for this player so the Host sees the new name
    if (Object.keys(reqUpdates).length > 0) {
        await sbFetch(
            `/play_requests?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(uuid)}`,
            { method: 'PATCH', body: reqUpdates }
        );
    }

    return res.status(200).json({ ok: true, updated: true });
}
