export const ROOM_CODE_REGEX = /^[A-Z0-9]{2,6}-?[A-Z0-9]{2,6}$/;
export const UUID_REGEX = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

/** Normalize room code for consistency */
export function normalizeRoomCode(raw) {
    if (!raw) return '';
    let code = String(raw).toUpperCase().trim();
    const stripped = code.replace(/[^A-Z0-9]/g, '');
    // Auto-hyphenate any unhyphenated even-length code (e.g. 6, 8, 10 chars)
    if (!code.includes('-') && stripped.length >= 4 && stripped.length % 2 === 0) {
        const mid = stripped.length / 2;
        return stripped.slice(0, mid) + '-' + stripped.slice(mid);
    }
    return code;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

/** Standardized Supabase Fetch helper */
export async function sbFetch(path, options = {}) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return { ok: false, status: 500, data: { error: 'Server environment misconfigured' } };
    }

    const method = options.method || 'GET';
    let baseUrl = SUPABASE_URL.endsWith('/') ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL;
    if (baseUrl.includes('/rest/v1')) baseUrl = baseUrl.split('/rest/v1')[0];

    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${baseUrl}/rest/v1${cleanPath}`;

    const headers = {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        options.prefer || (method === 'POST' ? 'return=minimal' : 'return=representation'),
    };

    try {
        const res = await fetch(url, {
            headers: { ...headers, ...(options.headers || {}) },
            method: method,
            body:   options.body ? JSON.stringify(options.body) : undefined,
        });
        
        const text = await res.text();
        const data = text ? JSON.parse(text) : null;
        return { ok: res.ok, status: res.status, data };
    } catch (e) {
        return { ok: false, status: 500, data: { error: e.message } };
    }
}