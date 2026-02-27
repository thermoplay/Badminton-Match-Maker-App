// =============================================================================
// API: session-presence.js
// =============================================================================
// FIXES:
//   #3  — Presence pings NO LONGER update `last_active` on the sessions row.
//         That was poisoning the stale-state guard in sync.js:applyRemoteState.
//         Only session-update (host game state pushes) touches last_active.
//   #22 — spectator_count is now incremented/decremented atomically using
//         Supabase's PostgREST RPC so concurrent joins don't clobber each other.
// =============================================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { room_code, action } = req.body || {};
    if (!room_code || !['join', 'leave', 'ping'].includes(action)) {
        return res.status(400).json({ error: 'room_code and action (join|leave|ping) required' });
    }

    try {
        // FIX #22: Use Supabase RPC for atomic increment/decrement.
        // The SQL function `adjust_spectator_count(p_room_code, p_delta)` does:
        //   UPDATE sessions
        //      SET spectator_count = GREATEST(0, spectator_count + p_delta)
        //    WHERE room_code = p_room_code;
        // This is safe under concurrent requests because the UPDATE is a single
        // statement — no client-side read-modify-write race.
        //
        // FIX #3: We deliberately do NOT update `last_active` here. Only the host's
        // session-update PATCH should touch that column, so it remains a reliable
        // indicator of when the host last pushed game state.

        if (action === 'join') {
            const { error } = await supabase.rpc('adjust_spectator_count', {
                p_room_code: room_code,
                p_delta:     1,
            });
            if (error) throw error;
            return res.status(200).json({ ok: true, action: 'joined' });
        }

        if (action === 'leave') {
            const { error } = await supabase.rpc('adjust_spectator_count', {
                p_room_code: room_code,
                p_delta:     -1,
            });
            if (error) throw error;
            return res.status(200).json({ ok: true, action: 'left' });
        }

        if (action === 'ping') {
            // Heartbeat — keep the session alive server-side without touching
            // last_active (which would corrupt the stale-state guard).
            // We simply verify the session still exists and return ok.
            const { data, error } = await supabase
                .from('sessions')
                .select('room_code, spectator_count')
                .eq('room_code', room_code)
                .single();

            if (error || !data) {
                return res.status(404).json({ ok: false, error: 'Session not found' });
            }
            return res.status(200).json({ ok: true, action: 'pinged', spectator_count: data.spectator_count });
        }

    } catch (err) {
        console.error('[session-presence] error:', err);
        return res.status(500).json({ error: 'Internal error', detail: err.message });
    }
}