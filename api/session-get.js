// =============================================================================
// Vercel Edge Function — /api/session-get
// Optimized for ultra-low latency session state retrieval with Edge caching.
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
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, apikey, Authorization',
    };

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(req.url);
    const code = url.searchParams.get('code');

    if (!code) {
        return new Response(JSON.stringify({ error: 'Missing room code' }), { 
            status: 400, 
            headers: corsHeaders 
        });
    }

    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/sessions?room_code=eq.${encodeURIComponent(code)}&select=*`, {
            headers: { 
                'apikey': SUPABASE_KEY, 
                'Authorization': `Bearer ${SUPABASE_KEY}` 
            }
        });
        
        const sessions = await res.json();
        const session = sessions[0];

        if (!session) {
            return new Response(JSON.stringify({ error: 'Session not found' }), { 
                status: 404, 
                headers: corsHeaders 
            });
        }

        return new Response(JSON.stringify({ ok: true, session }), {
            status: 200,
            headers: {
                ...corsHeaders,
                'Cache-Control': 'public, s-maxage=1, stale-while-revalidate=5'
            }
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { 
            status: 500, 
            headers: corsHeaders 
        });
    }
}