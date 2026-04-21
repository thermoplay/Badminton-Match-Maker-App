// =============================================================================
// Vercel Edge Function — /api/play-request
// Optimized for ultra-low latency player joining and "Open Party" activation.
// =============================================================================

export const config = {
  runtime: 'edge',
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req) {
    const corsHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, apikey, Authorization',
    };

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    const { method } = req;
    const url = new URL(req.url);

    try {
        // ── POST: JOIN REQUEST (Optimized for Open Party) ──────────────────
        if (method === 'POST') {
            const { room_code, name, player_uuid, spirit_animal, skill_level } = await req.json();

            // 1. Atomic Session Verification
            const sessionRes = await fetch(`${SUPABASE_URL}/rest/v1/sessions?room_code=eq.${room_code}&select=*`, {
                headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
            });
            const sessions = await sessionRes.json();
            const session = sessions[0];

            if (!session) return new Response(JSON.stringify({ error: 'Room not found' }), { status: 404, headers: corsHeaders });

            // 2. DIRECT ACTIVATION PATH (Open Party)
            if (session.is_open_party) {
                // A. Promoted to 'active' status in members table immediately
                await fetch(`${SUPABASE_URL}/rest/v1/session_members`, {
                    method: 'POST',
                    headers: { 
                        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
                        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates'
                    },
                    body: JSON.stringify({ room_code, player_uuid, player_name: name, spirit_animal, skill_level, status: 'active' })
                });

                // B. Immediate Cleanup of existing pending requests to prevent ghost notifications
                await fetch(`${SUPABASE_URL}/rest/v1/play_requests?room_code=eq.${room_code}&player_uuid=eq.${player_uuid}`, {
                    method: 'DELETE',
                    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
                });

                // C. Return full state so player hydrates instantly without waiting for WebSocket
                return new Response(JSON.stringify({ status: 'active', autoApproved: true, session }), { status: 200, headers: corsHeaders });
            }

            // 3. LEGACY PATH: Queue for Host Approval
            await fetch(`${SUPABASE_URL}/rest/v1/play_requests`, {
                method: 'POST',
                headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ room_code, player_uuid, name, spirit_animal, skill_level })
            });

            return new Response(JSON.stringify({ status: 'pending' }), { status: 200, headers: corsHeaders });
        }

        // ── GET: HOST POLLING ───────────────────────────────────────────────
        if (method === 'GET') {
            const room_code = url.searchParams.get('room_code');
            const res = await fetch(`${SUPABASE_URL}/rest/v1/play_requests?room_code=eq.${room_code}`, {
                headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
            });
            const data = await res.json();
            return new Response(JSON.stringify({ requests: data }), { 
                status: 200, 
                headers: { 
                    ...corsHeaders,
                    // Optimizes host polling by allowing short-lived edge caching and background revalidation
                    'Cache-Control': 'public, s-maxage=1, stale-while-revalidate=5'
                } 
            });
        }

        // ── DELETE/PATCH: RESOLVE REQUESTS ──────────────────────────────────
        if (method === 'DELETE' || method === 'PATCH') {
            const body = await req.json();
            const { id, ids, room_code, operator_key, player_uuid } = body;

            // Security: Verify operator key before allowing deletions
            if (operator_key !== 'LEAVE_ACTION') {
                const authRes = await fetch(`${SUPABASE_URL}/rest/v1/sessions?room_code=eq.${room_code}&select=operator_key`, {
                    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
                });
                const sessions = await authRes.json();
                if (!sessions[0] || sessions[0].operator_key !== operator_key) {
                    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
                }
            }

            const target = (method === 'DELETE' && id) ? `id=eq.${id}` : (player_uuid ? `player_uuid=eq.${player_uuid}` : null);
            
            if (target) {
                await fetch(`${SUPABASE_URL}/rest/v1/play_requests?room_code=eq.${room_code}&${target}`, {
                    method: 'DELETE',
                    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
                });
            } else if (ids && Array.isArray(ids)) {
                const filter = ids.map(i => `id.eq.${i}`).join(',');
                await fetch(`${SUPABASE_URL}/rest/v1/play_requests?room_code=eq.${room_code}&or=(${filter})`, {
                    method: 'DELETE',
                    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
                });
            }

            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
        }
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
}