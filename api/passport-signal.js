// =============================================================================
// /api/passport-signal
// POST: Host broadcasts a win/loss signal addressed to player UUIDs
// GET:  Player polls for signals addressed to their UUID
// DELETE: Player acknowledges and clears their signal
// =============================================================================
// PRIVACY: No stats are stored or transmitted. Only uuid + event type.
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const hdrs = () => {
    return {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
    };
};

export default async function handler(req, res) {

    // HOST → broadcast win signals to winner UUIDs
    if (req.method === 'POST') {
        const { room_code, winner_uuids, loser_uuids, game_label } = req.body;
        if (!room_code || !winner_uuids) {
            return res.status(400).json({ error: 'Missing fields' });
        }

        const signals = [
            ...(winner_uuids || []).map(uuid => ({
                room_code,
                player_uuid: uuid,
                event:       'WIN',
                game_label:  game_label || '',
                created_at:  new Date().toISOString(),
            })),
            ...(loser_uuids || []).map(uuid => ({
                room_code,
                player_uuid: uuid,
                event:       'LOSS',
                game_label:  game_label || '',
                created_at:  new Date().toISOString(),
            })),
        ];

        if (signals.length === 0) return res.status(200).json({ sent: 0 });

        let baseUrl = SUPABASE_URL.endsWith('/') ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL;
        if (baseUrl.includes('/rest/v1')) baseUrl = baseUrl.split('/rest/v1')[0];

        const r = await fetch(`${baseUrl}/rest/v1/passport_signals`, {
            method:  'POST',
            headers: hdrs(),
            body:    JSON.stringify(signals),
        });

        return res.status(r.ok ? 200 : 500).json({ sent: signals.length });
    }

    // PLAYER → poll for their signal
    if (req.method === 'GET') {
        const { player_uuid, room_code } = req.query;
        if (!player_uuid || !room_code) {
            return res.status(400).json({ error: 'Missing player_uuid or room_code' });
        }

        let baseUrl = SUPABASE_URL.endsWith('/') ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL;
        if (baseUrl.includes('/rest/v1')) baseUrl = baseUrl.split('/rest/v1')[0];

        const r = await fetch(
            `${baseUrl}/rest/v1/passport_signals` +
            `?player_uuid=eq.${encodeURIComponent(player_uuid)}` +
            `&room_code=eq."${encodeURIComponent(room_code)}"` +
            `&order=created_at.desc&limit=1`,
            { headers: hdrs() }
        );

        const data = await r.json();
        return res.status(200).json({ signal: data?.[0] || null });
    }

    // PLAYER → acknowledge + clear
    if (req.method === 'DELETE') {
        const { player_uuid, room_code } = req.body;
        if (!player_uuid) return res.status(400).json({ error: 'Missing player_uuid' });

        let baseUrl = SUPABASE_URL.endsWith('/') ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL;
        if (baseUrl.includes('/rest/v1')) baseUrl = baseUrl.split('/rest/v1')[0];

        const r = await fetch(
            `${baseUrl}/rest/v1/passport_signals` +
            `?player_uuid=eq.${encodeURIComponent(player_uuid)}` +
            `&room_code=eq."${encodeURIComponent(room_code)}"`,
            { method: 'DELETE', headers: hdrs() }
        );

        return res.status(r.ok ? 200 : 500).json({ ok: r.ok });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
