// =============================================================================
// API: member-upsert.js
// =============================================================================
// FIXES:
//   #17 — The name-update PATCH is now awaited and its result is inspected.
//          If the PATCH fails (e.g. RLS violation), the endpoint returns
//          status 500 rather than silently returning the stale `member.status`
//          from the original GET — which previously caused callers to skip the
//          pending screen when they should have been re-queued.
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

    const { room_code, player_uuid, player_name } = req.body || {};
    if (!room_code || !player_uuid || !player_name) {
        return res.status(400).json({ error: 'room_code, player_uuid, and player_name required' });
    }

    const trimmedName = player_name.trim();
    if (!trimmedName) return res.status(400).json({ error: 'player_name cannot be blank' });

    try {
        // 1. Check if the session exists
        const { data: session, error: sessErr } = await supabase
            .from('sessions')
            .select('room_code')
            .eq('room_code', room_code)
            .single();

        if (sessErr || !session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // 2. Look up existing member
        const { data: existingRows, error: fetchErr } = await supabase
            .from('session_members')
            .select('*')
            .eq('room_code', room_code)
            .eq('player_uuid', player_uuid)
            .limit(1);

        if (fetchErr) throw fetchErr;

        const member = existingRows?.[0] || null;

        if (member) {
            // 3a. Member exists — update name if changed
            if (member.player_name !== trimmedName) {
                // FIX #17: await the PATCH and check for errors before returning.
                // Previously this was fire-and-forget, so a failed PATCH caused the
                // caller to receive the stale `status: 'active'` from the original
                // GET, skipping the pending screen incorrectly.
                const { data: patchData, error: patchErr } = await supabase
                    .from('session_members')
                    .update({
                        player_name: trimmedName,
                        last_seen:   new Date().toISOString(),
                    })
                    .eq('room_code', room_code)
                    .eq('player_uuid', player_uuid)
                    .select()
                    .single();

                if (patchErr) {
                    // The PATCH failed (e.g. RLS). Return 500 so the client knows
                    // the true state is unknown and falls back to pending.
                    console.error('[member-upsert] name PATCH failed:', patchErr);
                    return res.status(500).json({
                        error:  'Failed to update player name',
                        detail: patchErr.message,
                    });
                }

                // Return the freshly patched record, not the stale pre-PATCH member
                return res.status(200).json({
                    ok:     true,
                    status: patchData.status,
                    member: patchData,
                });
            }

            // Name unchanged — update last_seen only (non-critical, ignore errors)
            supabase
                .from('session_members')
                .update({ last_seen: new Date().toISOString() })
                .eq('room_code', room_code)
                .eq('player_uuid', player_uuid)
                .then(() => {}) // fire and forget — last_seen is cosmetic
                .catch(() => {});

            return res.status(200).json({
                ok:     true,
                status: member.status,
                member,
            });
        }

        // 3b. New member — insert as pending
        const { data: inserted, error: insertErr } = await supabase
            .from('session_members')
            .insert({
                room_code,
                player_uuid,
                player_name: trimmedName,
                status:      'pending',
                joined_at:   new Date().toISOString(),
                last_seen:   new Date().toISOString(),
            })
            .select()
            .single();

        if (insertErr) throw insertErr;

        return res.status(200).json({
            ok:     true,
            status: 'pending',
            member: inserted,
        });

    } catch (err) {
        console.error('[member-upsert] error:', err);
        return res.status(500).json({ error: 'Internal error', detail: err.message });
    }
}