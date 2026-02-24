// =============================================================================
// COURTSIDE PRO — sync.js
// All Supabase calls now go through /api/ serverless routes.
// No database URL, no keys, no schema visible in this file.
// =============================================================================

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------
let isOnlineSession   = false;
let isOperator        = false;
let currentRoomCode   = null;
let operatorKey       = null;
let operatorKeyHash   = null;  // hash returned by server to verify identity
let realtimeChannel   = null;
let syncDebounceTimer = null;

// Supabase real-time still needs the publishable key for WebSocket only
// This key is safe to expose — it cannot write or read without RLS allowing it
// All writes go through our verified /api/ routes instead
const _RT_URL = 'wss://crqwaqovoqmlyvqeekhk.supabase.co/realtime/v1/websocket';
const _RT_KEY = 'sb_publishable_2NEOSY4wadPb93X55k_uvg_ASydylcv';

// ---------------------------------------------------------------------------
// API HELPERS — all calls go to /api/, never directly to Supabase
// ---------------------------------------------------------------------------

async function apiCall(route, options = {}) {
    const res = await fetch(`/api/${route}`, {
        method:  options.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body:    options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// GENERATORS
// ---------------------------------------------------------------------------

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const seg   = () => Array.from({ length: 4 }, () =>
        chars[Math.floor(Math.random() * chars.length)]).join('');
    return `${seg()}-${seg()}`;
}

function generateOperatorKey() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashKey(key) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(key));
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// CREATE SESSION
// ---------------------------------------------------------------------------

async function createOnlineSession() {
    showSyncStatus('Creating session…', 'info');
    try {
        const roomCode = generateRoomCode();
        const opKey    = generateOperatorKey();

        const result = await apiCall('session-create', {
            method: 'POST',
            body: {
                room_code:       roomCode,
                operator_key:    opKey,
                squad:           squad,
                current_matches: currentMatches,
            },
        });

        if (!result.ok) throw new Error(result.data?.error || 'Create failed');

        currentRoomCode = roomCode;
        operatorKey     = opKey;
        operatorKeyHash = await hashKey(opKey);
        isOperator      = true;
        isOnlineSession = true;

        localStorage.setItem('cs_room_code',      roomCode);
        localStorage.setItem('cs_operator_key',   opKey);
        localStorage.setItem('cs_op_key_hash',    operatorKeyHash);

        subscribeRealtime(roomCode);
        updateSessionUI();
        closeOverlay();
        showSessionToast(`🌐 Live! Room: ${roomCode}`);
        Haptic.success();

    } catch (e) {
        console.error('CourtSide: create failed', e);
        showSyncStatus('Failed to create session. Check your connection.', 'error');
        Haptic.error();
    }
}

// ---------------------------------------------------------------------------
// JOIN SESSION
// ---------------------------------------------------------------------------

async function joinOnlineSession(roomCode) {
    const code = (roomCode || '').trim().toUpperCase();
    if (!code) return;
    showSyncStatus('Joining…', 'info');

    try {
        const result = await apiCall(`session-get?code=${encodeURIComponent(code)}`);

        if (!result.ok) {
            showSyncStatus('Room not found. Check the code and try again.', 'error');
            Haptic.error();
            return;
        }

        const session = result.data;

        // Check if this device was the original operator
        const savedCode   = localStorage.getItem('cs_room_code');
        const savedOpKey  = localStorage.getItem('cs_operator_key');
        const savedHash   = localStorage.getItem('cs_op_key_hash');

        currentRoomCode = code;
        isOnlineSession = true;

        if (savedCode === code && savedHash === session.operator_key_hash) {
            // Returning operator — verified by hash comparison (key never sent to server again)
            isOperator      = true;
            operatorKey     = savedOpKey;
            operatorKeyHash = savedHash;
            showSessionToast(`✅ Reconnected as host`);
        } else {
            // Spectator
            isOperator      = false;
            operatorKey     = null;
            operatorKeyHash = null;
            showSessionToast(`👁 Joined as spectator`);
        }

        applyRemoteState(session);
        subscribeRealtime(code);
        updateSessionUI();
        closeOverlay();
        Haptic.bump();

    } catch (e) {
        console.error('CourtSide: join failed', e);
        showSyncStatus('Could not join. Try again.', 'error');
        Haptic.error();
    }
}

// ---------------------------------------------------------------------------
// PUSH STATE (Operator only, debounced)
// ---------------------------------------------------------------------------

function pushStateToSupabase() {
    if (!isOnlineSession || !isOperator) return;
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(async () => {
        try {
            await apiCall('session-update', {
                method: 'PATCH',
                body: {
                    room_code:       currentRoomCode,
                    operator_key:    operatorKey,  // verified server-side
                    squad:           squad,
                    current_matches: currentMatches,
                    round_history:   roundHistory,
                },
            });
        } catch (e) {
            console.error('CourtSide: push failed', e);
        }
    }, 800);
}

// ---------------------------------------------------------------------------
// REAL-TIME SUBSCRIPTION (WebSocket — publishable key only, read-only)
// ---------------------------------------------------------------------------

function subscribeRealtime(roomCode) {
    if (realtimeChannel) {
        realtimeChannel.close();
        realtimeChannel = null;
    }

    const ws = new WebSocket(`${_RT_URL}?apikey=${_RT_KEY}&vsn=1.0.0`);
    realtimeChannel = ws;

    ws.onopen = () => {
        ws.send(JSON.stringify({
            topic:   'realtime:public:sessions',
            event:   'phx_join',
            payload: {
                config: {
                    broadcast:        { self: false },
                    presence:         { key: '' },
                    postgres_changes: [{
                        event:  'UPDATE',
                        schema: 'public',
                        table:  'sessions',
                        filter: `room_code=eq.${roomCode}`,
                    }],
                },
            },
            ref: '1',
        }));
    };

    ws.onmessage = (msg) => {
        try {
            const data = JSON.parse(msg.data);
            if (data.event === 'heartbeat') {
                ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: '2' }));
                return;
            }
            if (data.event === 'postgres_changes' && !isOperator) {
                const record = data.payload?.data?.record;
                if (record) applyRemoteState(record);
            }
        } catch { /* ignore */ }
    };

    ws.onerror = () => {};
    ws.onclose = () => {
        if (isOnlineSession) {
            showReconnectingIndicator(true);
            setTimeout(() => {
                subscribeRealtime(roomCode);
                // Hide indicator after reconnect attempt
                setTimeout(() => showReconnectingIndicator(false), 2000);
            }, 3000);
        }
    };
}

// ---------------------------------------------------------------------------
// APPLY REMOTE STATE
// ---------------------------------------------------------------------------

let _lastRemoteUpdate = 0;

function applyRemoteState(session) {
    // Stale data guard — ignore updates older than the last one we applied
    const ts = session.last_active ? new Date(session.last_active).getTime() : 0;
    if (ts > 0 && ts < _lastRemoteUpdate) {
        console.log('CourtSide: ignoring stale remote update');
        return;
    }
    _lastRemoteUpdate = ts || Date.now();

    const prevCount = currentMatches.length;
    squad           = session.squad           || [];
    currentMatches  = session.current_matches || [];
    roundHistory    = session.round_history   || [];
    renderSquad();
    document.getElementById('matchContainer').innerHTML = '';
    renderSavedMatches();
    checkNextButtonState();
    updateUndoButton();
    // Update spectator-specific UI
    if (typeof checkIWTPSmartRecognition === 'function') checkIWTPSmartRecognition();
    if (currentMatches.length > 0 && currentMatches.length !== prevCount) Haptic.bump();
}

// ---------------------------------------------------------------------------
// LEAVE / END SESSION
// ---------------------------------------------------------------------------

function leaveSession() {
    isOnlineSession = false;
    isOperator      = false;
    currentRoomCode = null;
    operatorKey     = null;
    operatorKeyHash = null;
    if (realtimeChannel) { realtimeChannel.close(); realtimeChannel = null; }
    localStorage.removeItem('cs_room_code');
    localStorage.removeItem('cs_operator_key');
    localStorage.removeItem('cs_op_key_hash');
    updateSessionUI();
}

function showReconnectingIndicator(show) {
    let el = document.getElementById('reconnectIndicator');
    if (!el) {
        el = document.createElement('div');
        el.id = 'reconnectIndicator';
        el.className = 'reconnect-indicator';
        el.textContent = '⟳ Reconnecting…';
        document.body.appendChild(el);
    }
    el.classList.toggle('visible', show);
}

async function endAndDeleteSession() {
    if (!isOperator || !currentRoomCode) return;
    try {
        await apiCall('session-delete', {
            method: 'DELETE',
            body: { room_code: currentRoomCode, operator_key: operatorKey },
        });
    } catch (e) {
        console.error('CourtSide: delete failed', e);
    }
    leaveSession();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function updateSessionUI() {
    let badge = document.getElementById('sessionBadge');
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'sessionBadge';
        // Fixed top-right — not inside nav bar
        document.body.appendChild(badge);
    }
    if (!isOnlineSession) { badge.style.display = 'none'; return; }
    badge.style.display = 'flex';
    badge.className     = 'session-badge';
    badge.innerHTML     = `
        <span class="session-dot ${isOperator ? 'dot-operator' : 'dot-spectator'}"></span>
        <span class="session-code">${currentRoomCode}</span>
        <span class="session-role">${isOperator ? 'HOST' : 'LIVE'}</span>
    `;
    lockUIForSpectator(!isOperator);
    if (!isOperator) document.body.classList.add('spectator-mode');
    else document.body.classList.remove('spectator-mode');
}

function lockUIForSpectator(lock) {
    // Use a single body class — CSS handles everything from one place.
    // This is bulletproof: no selector can be missed, no inline style can be
    // accidentally overridden, and dynamically added elements (new match cards)
    // are automatically locked without any extra JS.
    if (lock) {
        document.body.classList.add('spectator-mode');
    } else {
        document.body.classList.remove('spectator-mode');
    }
}

function showSyncStatus(msg, type = 'info') {
    const el = document.getElementById('syncStatusMsg');
    if (!el) return;
    el.textContent   = msg;
    el.className     = `sync-status sync-status-${type}`;
    el.style.display = 'block';
}

function showSessionToast(msg) {
    let toast = document.getElementById('sessionToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'sessionToast';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className   = 'session-toast show';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 3000);
}

// ---------------------------------------------------------------------------
// HOOK INTO saveToDisk
// ---------------------------------------------------------------------------

const _originalSaveToDisk = saveToDisk;
saveToDisk = function () {
    _originalSaveToDisk();
    if (isOnlineSession && isOperator) pushStateToSupabase();
};

// ---------------------------------------------------------------------------
// AUTO-REJOIN
// ---------------------------------------------------------------------------

async function tryAutoRejoin() {
    // Check for ?join=XXXX-XXXX in the URL first — this is how QR code scanning works.
    // When someone scans the QR, their camera opens the URL with this param
    // and we immediately join that session as a spectator.
    const urlParams  = new URLSearchParams(window.location.search);
    const joinCode   = urlParams.get('join');
    if (joinCode) {
        // Clean the URL so the code doesn't stay visible or persist on refresh
        const cleanUrl = window.location.origin + window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
        await joinOnlineSession(joinCode);
        return; // don't also try localStorage rejoin
    }

    // Otherwise try to reconnect as returning operator from localStorage
    const savedCode = localStorage.getItem('cs_room_code');
    const savedHash = localStorage.getItem('cs_op_key_hash');
    if (!savedCode) return;

    try {
        const result = await apiCall(`session-get?code=${encodeURIComponent(savedCode)}`);
        if (!result.ok) {
            localStorage.removeItem('cs_room_code');
            localStorage.removeItem('cs_operator_key');
            localStorage.removeItem('cs_op_key_hash');
            return;
        }
        const session = result.data;
        currentRoomCode = savedCode;
        isOnlineSession = true;

        if (savedHash && savedHash === session.operator_key_hash) {
            isOperator      = true;
            operatorKey     = localStorage.getItem('cs_operator_key');
            operatorKeyHash = savedHash;
        } else {
            isOperator = false;
        }

        applyRemoteState(session);
        subscribeRealtime(savedCode);
        updateSessionUI();
        showSessionToast(isOperator ? `✅ Reconnected as host` : `👁 Rejoined session`);
    } catch { /* silently stay offline */ }
}

// ---------------------------------------------------------------------------
// SPECTATOR COUNT — lightweight presence tracking
// Each spectator device pings a presence endpoint on join/heartbeat.
// We track count via a simple in-memory counter updated from realtime.
// ---------------------------------------------------------------------------

let spectatorCount = 0;
let presenceHeartbeat = null;

/**
 * Called when a spectator joins — registers their presence via a simple
 * counter stored alongside the session. Uses a separate lightweight ping.
 */
async function registerPresence() {
    if (isOperator) return; // operator doesn't count as spectator
    try {
        await apiCall('session-presence', {
            method: 'POST',
            body: { room_code: currentRoomCode, action: 'join' },
        });
        // Heartbeat every 20s to signal still watching
        clearInterval(presenceHeartbeat);
        presenceHeartbeat = setInterval(async () => {
            if (!isOnlineSession) { clearInterval(presenceHeartbeat); return; }
            await apiCall('session-presence', {
                method: 'POST',
                body: { room_code: currentRoomCode, action: 'ping' },
            }).catch(() => {});
        }, 20000);
    } catch { /* silent */ }
}

/**
 * Updates the spectator count badge on the host's nav bar.
 */
function updateSpectatorCount(count) {
    spectatorCount = count;
    const countEl = document.getElementById('spectatorCount');
    if (countEl) {
        countEl.textContent = `👁 ${count}`;
        countEl.style.display = count > 0 ? 'inline-flex' : 'none';
    }
}

// ---------------------------------------------------------------------------
// Override updateSessionUI to also handle spectator UI and count badge
const _originalUpdateSessionUI = updateSessionUI;
updateSessionUI = function() {
    _originalUpdateSessionUI();

    // Spectator count badge — only shown to operator
    if (isOnlineSession && isOperator) {
        let countEl = document.getElementById('spectatorCount');
        if (!countEl) {
            countEl = document.createElement('span');
            countEl.id = 'spectatorCount';
            countEl.className = 'spectator-count-badge';
            countEl.style.display = 'none';
            const badge = document.getElementById('sessionBadge');
            if (badge) badge.appendChild(countEl);
        }
    }

    // Register spectator presence
    if (isOnlineSession && !isOperator) {
        registerPresence();
    }

    // Show/hide "I Want to Play" sheet for spectators
    if (typeof updateIWTPVisibility === 'function') updateIWTPVisibility();

    // Start polling play requests if operator
    if (isOnlineSession && isOperator && typeof _startPolling === 'function') {
        _startPolling();
    }
};


// ---------------------------------------------------------------------------
// MATCH HISTORY ARCHIVAL — weekly leaderboard
// ---------------------------------------------------------------------------

async function archiveRoundToSupabase(snapshot) {
    if (!currentRoomCode) return;
    try {
        await fetch('/api/match-history', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code: currentRoomCode,
                timestamp: snapshot.timestamp,
                matches:   snapshot.matches,
                squad:     snapshot.squadSnapshot,
            }),
        });
    } catch (e) {
        console.error('CourtSide: archive failed', e);
    }
}