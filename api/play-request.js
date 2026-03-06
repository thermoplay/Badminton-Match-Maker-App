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

import { createHash } from 'crypto';

function hashKey(key) {
    if (!key) return null;
    // Use standard Node.js crypto module for better serverless compatibility
    return createHash('sha256').update(key).digest('hex');
}

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
        const { room_code, name, player_uuid, force } = req.body;

        // The `leave: true` functionality has been removed. Player removal is now
        // exclusively handled by the authenticated DELETE endpoint, which is triggered
        // by the host. This prevents a player from being able to remove another
        // player from a session without authorization.

        if (!room_code || !name) {
            return res.status(400).json({ error: 'Missing fields for join' });
        }

        const code = String(room_code).trim().toUpperCase();
        const trimmedName = String(name).trim().slice(0, 50);
        const uuid = player_uuid ? String(player_uuid).trim() : null;

        // --- Input Validation ---
        if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
            return res.status(400).json({ error: 'Invalid room code format' });
        }
        if (uuid && !/^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(uuid)) {
            return res.status(400).json({ error: 'Invalid player UUID format' });
        }
        // ------------------------

        // ── Step 1: Check if player is already approved in session_members ────
        // Only this check should short-circuit. A pending row does NOT block us.
        // If 'force' is true (ghost player detected by client), skip this check.
        if (uuid && !force) {
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
                if (member.player_name !== trimmedName) {
                    await sbFetch(
                        `/session_members?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(uuid)}`,
                        {
                            method:  'PATCH',
                            headers: { 'Prefer': 'return=minimal' },
                            body:    { player_name: trimmedName, last_seen: new Date().toISOString() },
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
                name:         trimmedName,
                player_uuid:  uuid,
                requested_at: new Date().toISOString(),
            },
        });

        if (!r.ok) {
            return res.status(500).json({ ok: false, error: 'Failed to write play request' });
        }

        // ── Step 4: Upsert/Update session_members status ────────────────────
        if (uuid) {
            if (force) {
                // If forcing (ghost player rejoin), we MUST update the status to pending.
                await sbFetch(
                    `/session_members?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(uuid)}`,
                    {
                        method:  'PATCH',
                        headers: { 'Prefer': 'return=minimal' },
                        body:    { status: 'pending', last_seen: new Date().toISOString() },
                    }
                );
            } else {
                // Standard join: upsert, ignoring if already exists.
                await sbFetch('/session_members', {
                    method:  'POST',
                    headers: { 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
                    body:    { room_code: code, player_uuid: uuid, player_name: trimmedName, status: 'pending', joined_at: new Date().toISOString(), last_seen: new Date().toISOString() },
                });
            }
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
        const { id, room_code, player_uuid, operator_key } = req.body;

        // --- ACTION 1: Host removes a player from the session ---
        // This is an authenticated action that deletes a row from `session_members`.
        // It is triggered by the host UI (e.g., player leaves, host kicks player).
        if (player_uuid && room_code && operator_key) {
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

            // Verify operator key
            const sessionRes = await sbFetch(`/sessions?room_code=eq.${encodeURIComponent(code)}&select=operator_key_hash&limit=1`);
            if (!sessionRes.ok || !sessionRes.data?.[0]) {
                return res.status(404).json({ error: 'Session not found' });
            }
            const opKeyHash = hashKey(String(operator_key));
            if (opKeyHash !== sessionRes.data[0].operator_key_hash) {
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
        if (id) {
            const r = await sbFetch(`/play_requests?id=eq.${id}`, { method: 'DELETE' });
            return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
        }

        return res.status(400).json({ error: 'Missing required parameters for DELETE' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}