// =============================================================================
// API: session-update.js
// =============================================================================
// FIXES:
//   #2 — PATCH now requires a `state_version` field. The server rejects any
//        update whose version is not strictly greater than the stored version.
//        This prevents a slow-resolving PATCH from overwriting newer state
//        that a faster PATCH already committed (last-write-wins race).
//
//        The server also updates `last_active` on every accepted host push,
//        which is the ONLY place `last_active` should be touched (see
//        session-presence.js fix #3).
// =============================================================================

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

function hashKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

    const {
        room_code,
        operator_key,
        squad,
        current_matches,
        round_history,
        uuid_map,
        approved_players,
        state_version,   // FIX #2: required for optimistic concurrency
    } = req.body || {};

    if (!room_code || !operator_key) {
        return res.status(400).json({ error: 'room_code and operator_key required' });
    }

    // FIX #2: state_version must be a positive integer
    if (typeof state_version !== 'number' || state_version < 1) {
        return res.status(400).json({ error: 'state_version must be a positive integer' });
    }

    try {
        // 1. Authenticate the operator
        const { data: existing, error: fetchErr } = await supabase
            .from('sessions')
            .select('operator_key_hash, state_version')
            .eq('room_code', room_code)
            .single();

        if (fetchErr || !existing) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const incomingHash = hashKey(operator_key);
        if (incomingHash !== existing.operator_key_hash) {
            return res.status(403).json({ error: 'Invalid operator key' });
        }

        // FIX #2: Reject the update if the client's version isn't strictly
        // greater than what's currently stored. This handles the race where
        // two PATCHes are in flight and the older one resolves last.
        const storedVersion = existing.state_version || 0;
        if (state_version <= storedVersion) {
            return res.status(409).json({
                error:          'Stale update rejected',
                stored_version: storedVersion,
                your_version:   state_version,
            });
        }

        // 2. Apply the update, bumping both state_version and last_active
        const { error: updateErr } = await supabase
            .from('sessions')
            .update({
                squad,
                current_matches,
                round_history:    round_history    || [],
                uuid_map:         uuid_map         || {},
                approved_players: approved_players || {},
                state_version,
                last_active: new Date().toISOString(), // Only host game pushes set this
            })
            .eq('room_code', room_code);

        if (updateErr) throw updateErr;

        return res.status(200).json({ ok: true, state_version });

    } catch (err) {
        console.error('[session-update] error:', err);
        return res.status(500).json({ error: 'Internal error', detail: err.message });
    }
}