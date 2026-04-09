// =============================================================================
// Vercel Serverless Function — /api/session-create
// Creates a new CourtSide session in Supabase.
// Also cleans up sessions inactive >24hrs — no extra function needed.
// Supabase URL and key NEVER leave the server.
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const crypto = require('crypto'); // Node.js crypto module for hashing
import { ROOM_CODE_REGEX, normalizeRoomCode } from './_utils';

async function sbFetch(path, options = {}) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return { ok: false, status: 500, data: { error: 'Server environment misconfigured' } };
    }

    const method = options.method || 'GET';
    let baseUrl = SUPABASE_URL.endsWith('/') ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL;
    if (baseUrl.includes('/rest/v1')) baseUrl = baseUrl.split('/rest/v1')[0];

    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${baseUrl}/rest/v1${cleanPath}`;

    console.log(`[sbFetch] Making request to: ${url}`);
    const controller = new AbortController();
    // Fix: Reduce timeout to 9s to ensure we catch it before Vercel's 10s hard limit
    const timeout    = setTimeout(() => controller.abort(), 9000);
    try {
        const res = await fetch(url, {
            headers: {
                'apikey':        SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type':  'application/json',
                'Prefer':        options.prefer || 'return=representation',
            },
            method: method,
            body:   options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
        });
        clearTimeout(timeout);
        const text = await res.text();
        return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
    } catch (e) {
        clearTimeout(timeout);
        if (e.name === 'AbortError') throw new Error('Supabase request timed out');
        throw e;
    }
}

export default async function handler(req, res) {
    // 1. Handle CORS (Cross-Origin Resource Sharing)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.error('[session-create] Missing env vars');
        return res.status(500).json({ error: 'Server Error: Missing SUPABASE_URL or KEY' });
    }

    // 2. Body Validation
    if (!req.body) return res.status(400).json({ error: 'Empty body' });
    const { room_code: raw_code, operator_key, operator_key_hash, squad, current_matches, player_queue } = req.body;

    const room_code = normalizeRoomCode(raw_code);

    // Always hash the incoming operator_key for storage
    const finalHash = operator_key ? crypto.createHash('sha256').update(operator_key).digest('hex') : null;

    if (!room_code || !finalHash) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!ROOM_CODE_REGEX.test(room_code)) {
        return res.status(400).json({ error: 'Invalid room code format' });
    }

    // TODO: Move cleanupStaleSessions to a Vercel Cron Job to keep this function snappy.

    try {
        const result = await sbFetch('/sessions', {
            method: 'POST',
            body: {
                room_code,
                operator_key:      finalHash,
                squad:             squad           || [],
                current_matches:   current_matches || [],
                player_queue:      player_queue    || [],
                round_history:     [],
                last_active:       new Date().toISOString(),
            },
        });

        if (!result.ok) {
            console.error('[session-create] Supabase error:', result.status, result.data);
            return res.status(result.status).json({
                error: result.data?.message || 'Failed to create session',
            });
        }

        return res.status(200).json({ room_code, created: true, operator_key: finalHash });

    } catch (e) {
        console.error('[session-create] Error:', e.message);
        const isTimeout = e.message?.includes('timed out');
        return res.status(isTimeout ? 504 : 500).json({
            error: isTimeout ? 'Database timeout — try again' : 'Internal server error',
        });
    }
}