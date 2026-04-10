// =============================================================================
// /api/members — Member Registration & Identity
// Replaces: member-upsert, member-approve, member-rename
// =============================================================================

import { ROOM_CODE_REGEX, UUID_REGEX, normalizeRoomCode, sbFetch } from './_utils';
const crypto = require('crypto');

export default async function handler(req, res) {
    const { method } = req;

    // --- GET: Poll Requests OR Leaderboard ---
    if (method === 'GET') {
        const { room_code, type, player_uuid, status } = req.query;

        if (type === 'leaderboard') {
            const response = await sbFetch('/career_stats?order=elo.desc&limit=10');
            return res.status(response.ok ? 200 : 500).json({ players: response.data || [] });
        }

        if (player_uuid) {
            const result = await sbFetch(`/player_achievements?player_uuid=eq.${encodeURIComponent(player_uuid)}&select=achievement_id,unlocked_at`);
            return res.status(result.ok ? 200 : 500).json({ achievements: result.data || [] });
        }

        if (!room_code) return res.status(400).json({ error: 'Missing room_code' });
        const code = normalizeRoomCode(room_code);
        
        // Reconciliation support: Fetch currently active members
        if (status === 'active') {
            const r = await sbFetch(`/session_members?room_code=eq.${encodeURIComponent(code)}&status=eq.active`);
            const mapped = (Array.isArray(r.data) ? r.data : []).map(m => ({
                id: m.id,
                name: m.player_name,
                player_uuid: m.player_uuid
            }));
            return res.status(200).json({ requests: mapped });
        }

        // Requests from last 3 hours
        const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        const r = await sbFetch(`/play_requests?room_code=eq.${encodeURIComponent(code)}&requested_at=gte.${encodeURIComponent(since)}&order=requested_at.asc`);
        return res.status(200).json({ requests: r.data || [] });
    }

    // --- POST: Upsert/Register Member ---
    if (method === 'POST') {
        const { room_code, player_uuid, player_name, spirit_animal } = req.body;
        const code = normalizeRoomCode(room_code);
        if (!ROOM_CODE_REGEX.test(code) || !UUID_REGEX.test(player_uuid)) return res.status(400).json({ error: 'Invalid input' });

        // 1. Ensure global player record exists
        await sbFetch('/players', {
            method: 'POST',
            headers: { 'Prefer': 'resolution=merge-duplicates' },
            body: { uuid: player_uuid, name: player_name, spirit_animal, last_active: new Date().toISOString() }
        });

        // 2. Register for session & Fetch Current State
        const [existing, sessionRes] = await Promise.all([
            sbFetch(`/session_members?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(player_uuid)}&select=status&limit=1`),
            sbFetch(`/sessions?room_code=eq.${encodeURIComponent(code)}&limit=1`)
        ]);
        
        if (existing.ok && existing.data?.length > 0) {
            if (existing.data[0].status === 'active') return res.status(200).json({ ok: true, status: 'active', alreadyActive: true });
            return res.status(200).json({ ok: true, status: existing.data[0].status, member: existing.data[0], session: sessionRes.data?.[0] });
        }

        // 3. Create Notification for Host
        await sbFetch('/play_requests', {
            method: 'POST',
            body: { room_code: code, player_uuid, name: player_name, spirit_animal }
        });

        const result = await sbFetch('/session_members', {
            method: 'POST',
            body: {
                room_code: code,
                player_uuid,
                player_name,
                spirit_animal,
                status: 'pending',
                joined_at: new Date().toISOString()
            }
        });
        return res.status(result.ok ? 200 : 500).json({ ok: result.ok, status: 'pending', member: result.data?.[0], session: sessionRes.data?.[0] });
    }

    // --- PATCH: Approve OR Rename ---
    if (method === 'PATCH') {
        const { room_code, player_uuid, operator_key, new_name, spirit_animal } = req.body;
        const code = normalizeRoomCode(room_code);

        // Sub-route: Host Approval
        if (operator_key) {
            const check = await sbFetch(`/sessions?room_code=eq.${encodeURIComponent(code)}&select=operator_key&limit=1`);
            const incomingHash = crypto.createHash('sha256').update(operator_key).digest('hex');
            if (check.data?.[0]?.operator_key !== incomingHash) return res.status(403).json({ error: 'Unauthorized' });

            const result = await sbFetch(`/session_members?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(player_uuid)}`, {
                method: 'PATCH',
                body: { status: 'active', approved_at: new Date().toISOString() }
            }); // This was already correct, no quotes needed for `player_uuid`
            return res.status(result.ok ? 200 : 500).json({ ok: result.ok, approved: true });
        }

        // Sub-route: Player Rename/Spirit Animal
        const updates = { last_seen: new Date().toISOString() };
        if (new_name) updates.player_name = new_name;
        if (spirit_animal !== undefined) updates.spirit_animal = spirit_animal;

        const result = await sbFetch(`/session_members?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(player_uuid)}`, {
            method: 'PATCH',
            body: updates
        });

        // Sync to global profile
        await sbFetch(`/players?uuid=eq.${player_uuid}`, { method: 'PATCH', body: { name: new_name, spirit_animal, last_active: new Date().toISOString() } });
        
        // Restore: Update pending play_requests so host sees the new name/animal immediately
        const reqUpdates = {}; // This was already correct, no quotes needed for `player_uuid`
        if (new_name) reqUpdates.name = new_name;
        if (spirit_animal !== undefined) reqUpdates.spirit_animal = spirit_animal;
        await sbFetch(`/play_requests?room_code=eq.${encodeURIComponent(code)}&player_uuid=eq.${encodeURIComponent(player_uuid)}`, { method: 'PATCH', body: reqUpdates });

        return res.status(result.ok ? 200 : 500).json({ ok: result.ok, updated: true });
    }

    // --- DELETE: Remove Member OR Dismiss Request ---
    if (method === 'DELETE') {
        const { id, room_code, player_uuid, operator_key, type } = req.body;
        const code = normalizeRoomCode(room_code);

        // Sub-route: Acknowledge Passport Signal (Player-side)
        if (type === 'signal' && player_uuid) {
            const r = await sbFetch(`/passport_signals?player_uuid=eq.${encodeURIComponent(player_uuid)}&room_code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' });
            return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
        }

        const check = await sbFetch(`/sessions?room_code=eq.${encodeURIComponent(code)}&select=operator_key&limit=1`);
        const incomingHash = crypto.createHash('sha256').update(operator_key).digest('hex');
        if (!check.ok || check.data?.[0]?.operator_key !== incomingHash) return res.status(403).json({ error: 'Unauthorized' });

        if (player_uuid) {
            // Kick player from session
            await Promise.all([
                sbFetch(`/session_members?player_uuid=eq.${encodeURIComponent(player_uuid)}&room_code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' }),
                sbFetch(`/play_requests?player_uuid=eq.${encodeURIComponent(player_uuid)}&room_code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' })
            ]);
            return res.status(200).json({ ok: true });
        }

        if (id) {
            // Dismiss join request
            const r = await sbFetch(`/play_requests?id=eq.${id}&room_code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' });
            return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
        }

        return res.status(400).json({ error: 'Missing ID or UUID' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}