// =============================================================================
// COURTSIDE PRO — sync.js  v4
// =============================================================================
// BROADCAST ARCHITECTURE
// ─────────────────────────────────────────────────────────────────────────────
// Two channels run simultaneously on the same WebSocket:
//
//  1. postgres_changes  — heavy state sync (squad, matches, round history)
//     Host writes → Supabase → all subscribers receive full session row
//     Used for: initial load, reconnects, undo, full state rehydration
//     Debounced 800ms to avoid hammering
//
//  2. Broadcast channel  — instant lightweight events (no DB round-trip)
//     Host sends → Supabase realtime → all subscribers <100ms
//     Used for: session_joined, game_state, match_result, name_update
//     These four events fix all four synchronisation bugs
//
// PRIVACY: match_result carries winnerUUID only. No stats cross the wire.
// =============================================================================

let isOnlineSession   = false;
let isOperator        = false;
let currentRoomCode   = null;
let operatorKey       = null;
let operatorKeyHash   = null;
let realtimeChannel   = null;
let syncDebounceTimer = null;

const _RT_URL = 'wss://crqwaqovoqmlyvqeekhk.supabase.co/realtime/v1/websocket';
const _RT_KEY = 'sb_publishable_2NEOSY4wadPb93X55k_uvg_ASydylcv';

// ---------------------------------------------------------------------------
// API HELPERS
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
        const result   = await apiCall('session-create', {
            method: 'POST',
            body: { room_code: roomCode, operator_key: opKey, squad, current_matches: currentMatches },
        });
        if (!result.ok) throw new Error(result.data?.error || 'Create failed');
        currentRoomCode = roomCode;
        operatorKey     = opKey;
        operatorKeyHash = await hashKey(opKey);
        isOperator      = true;
        isOnlineSession = true;
        localStorage.setItem('cs_room_code',    roomCode);
        localStorage.setItem('cs_operator_key', opKey);
        localStorage.setItem('cs_op_key_hash',  operatorKeyHash);
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
        // session-get returns { ok, session: {...} }
        const session = result.data?.session || result.data;
        const savedCode  = localStorage.getItem('cs_room_code');
        const savedOpKey = localStorage.getItem('cs_operator_key');
        const savedHash  = localStorage.getItem('cs_op_key_hash');
        currentRoomCode = code;
        isOnlineSession = true;
        if (savedCode === code && savedHash && savedHash === session.operator_key_hash) {
            isOperator      = true;
            operatorKey     = savedOpKey;
            operatorKeyHash = savedHash;
            showSessionToast(`✅ Reconnected as host`);
        } else {
            isOperator      = false;
            operatorKey     = null;
            operatorKeyHash = null;
            showSessionToast(`👁 Joined session`);
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
// PUSH STATE — heavy sync, debounced
// ---------------------------------------------------------------------------

function pushStateToSupabase() {
    if (!isOnlineSession || !isOperator) return;
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(async () => {
        try {
            await apiCall('session-update', {
                method: 'PATCH',
                body: {
                    room_code:        currentRoomCode,
                    operator_key:     operatorKey,
                    squad,
                    current_matches:  currentMatches,
                    round_history:    roundHistory,
                    uuid_map:         window._sessionUUIDMap  || {},
                    approved_players: window._approvedPlayers || {},
                },
            });
        } catch (e) { console.error('CourtSide: push failed', e); }
    }, 800);
}

// ---------------------------------------------------------------------------
// BROADCAST — instant events, no DB write, <100ms delivery
// ---------------------------------------------------------------------------

// Internal: send any broadcast event
function _broadcast(type, payload) {
    if (!realtimeChannel || realtimeChannel.readyState !== WebSocket.OPEN) return;
    realtimeChannel.send(JSON.stringify({
        topic:   `realtime:courtside-${currentRoomCode}`,
        event:   'broadcast',
        payload: { type, ...payload },
        ref:     String(Date.now()),
    }));
}

/**
 * BUG 1 FIX — broadcast approval to the specific player.
 * Contains: playerUUID (so player can match), token (for sessionStorage),
 * current squad + matches (so sideline view is immediately populated).
 */
function broadcastApproval(playerUUID, playerName, token) {
    if (!isOperator) return;
    _broadcast('session_joined', {
        playerUUID,
        playerName,
        token,
        squad,
        current_matches: currentMatches,
    });
}

/**
 * BUG 2 FIX — broadcast live game state whenever matches change.
 * Called by saveToDisk hook, setWinner, processAndNext.
 * Players update their live feed immediately without waiting for DB.
 */
function broadcastGameState() {
    if (!isOperator || !isOnlineSession) return;
    _broadcast('game_state', {
        squad,
        current_matches: currentMatches,
        next_up: (document.getElementById('nextUpNames')?.textContent || '').trim(),
    });
}

/**
 * BUG 4 FIX — broadcast match result with exact UUIDs.
 * One broadcast per player so each device does a strict UUID equality check.
 */
function broadcastMatchResult(winnerUUIDs, loserUUIDs, gameLabel) {
    if (!isOperator) return;
    winnerUUIDs.forEach(uuid => {
        _broadcast('match_result', { playerUUID: uuid, event: 'WIN', gameLabel });
    });
    loserUUIDs.forEach(uuid => {
        _broadcast('match_result', { playerUUID: uuid, event: 'LOSS', gameLabel });
    });
}

/**
 * BUG 3 FIX — player broadcasts their name change to the host.
 * Any subscriber can call this (not operator-only).
 */
function broadcastNameUpdate(playerUUID, oldName, newName) {
    if (!realtimeChannel || realtimeChannel.readyState !== WebSocket.OPEN) return;
    realtimeChannel.send(JSON.stringify({
        topic:   `realtime:courtside-${currentRoomCode}`,
        event:   'broadcast',
        payload: { type: 'name_update', playerUUID, oldName, newName },
        ref:     String(Date.now()),
    }));
}

// ---------------------------------------------------------------------------
// HANDLE INCOMING BROADCAST EVENTS
// ---------------------------------------------------------------------------

function _handleBroadcast(payload) {
    const { type } = payload;

    // BUG 1: Player approved — flip from pending → active
    if (type === 'session_joined') {
        if (!isOperator && typeof PlayerMode !== 'undefined') {
            PlayerMode._onApprovalReceived(payload);
        }
        return;
    }

    // BUG 2: Live game state — update player feed immediately
    if (type === 'game_state') {
        if (!isOperator) {
            // Globals first, then render
            window.squad          = payload.squad           || window.squad          || [];
            window.currentMatches = payload.current_matches || window.currentMatches || [];
            if (typeof PlayerMode !== 'undefined') {
                PlayerMode._onGameStateUpdate(payload);
            } else if (typeof SidelineView !== 'undefined') {
                SidelineView.refresh();
            }
        }
        return;
    }

    // BUG 4: Individual match_result — UUID-matched private stat update
    if (type === 'match_result') {
        if (!isOperator && typeof PlayerMode !== 'undefined') {
            PlayerMode._onMatchResult(payload);
        }
        return;
    }

    // MATCH_RESOLVED: round-level event with winner name display + individual UUIDs
    // All players receive this; only UUID-matched ones increment wins
    if (type === 'match_resolved') {
        if (!isOperator && typeof PlayerMode !== 'undefined') {
            PlayerMode._onMatchResolved(payload);
        }
        return;
    }

    // BUG 3: Name update — host applies the change
    if (type === 'name_update') {
        if (isOperator) {
            _applyNameUpdate(payload.playerUUID, payload.oldName, payload.newName);
        }
        return;
    }
}

// Host applies a name change broadcast from a player
// Issue #3 FIX: UUID-first lookup so name changes survive previous renames.
// squad member has .uuid stored at approval time — that never changes.
function _applyNameUpdate(playerUUID, oldName, newName) {
    if (!newName?.trim() || !playerUUID) return;
    const trimmed = newName.trim();

    // 1. Find player by UUID (stored on squad member at approval) — rename-safe
    let player = squad.find(p => p.uuid === playerUUID);
    // 2. Fallback: find by oldName if uuid not yet on squad member
    if (!player) player = squad.find(p => p.name === oldName);

    if (!player) return;  // player not in squad yet, ignore

    const prevName = player.name;
    player.name    = trimmed;
    player.uuid    = playerUUID;   // ensure uuid is set for future lookups

    // Update uuid_map: rename the key, ensure new key exists
    const uuidMap = window._sessionUUIDMap || {};
    // Remove old name key if it points to this UUID
    if (uuidMap[prevName] === playerUUID) delete uuidMap[prevName];
    // Always write new name key
    uuidMap[trimmed] = playerUUID;
    window._sessionUUIDMap = uuidMap;

    renderSquad();
    saveToDisk();
    showSessionToast(`✏️ ${prevName} → ${trimmed}`);
}

// ---------------------------------------------------------------------------
// REAL-TIME SUBSCRIPTION
// Two channels on one WebSocket connection
// ---------------------------------------------------------------------------

function subscribeRealtime(roomCode) {
    if (realtimeChannel) {
        realtimeChannel.close();
        realtimeChannel = null;
    }
    const ws = new WebSocket(`${_RT_URL}?apikey=${_RT_KEY}&vsn=1.0.0`);
    realtimeChannel = ws;

    ws.onopen = () => {
        // Channel 1: postgres_changes for full state sync
        ws.send(JSON.stringify({
            topic: 'realtime:public:sessions',
            event: 'phx_join',
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
        // Channel 2: broadcast for instant events
        ws.send(JSON.stringify({
            topic: `realtime:courtside-${roomCode}`,
            event: 'phx_join',
            payload: { config: { broadcast: { self: false } } },
            ref: '2',
        }));
    };

    ws.onmessage = (msg) => {
        try {
            const data = JSON.parse(msg.data);
            // Heartbeat
            if (data.event === 'heartbeat') {
                ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: '3' }));
                return;
            }
            // postgres_changes — non-operators only (spectators, players)
            if (data.event === 'postgres_changes' && !isOperator) {
                const record = data.payload?.data?.record;
                if (record) applyRemoteState(record);
                return;
            }
            // Broadcast events — all subscribers
            if (data.event === 'broadcast' && data.payload?.type) {
                _handleBroadcast(data.payload);
                return;
            }
        } catch { /* ignore */ }
    };

    ws.onerror = () => {};
    ws.onclose = () => {
        if (isOnlineSession) {
            showReconnectingIndicator(true);
            setTimeout(() => {
                subscribeRealtime(roomCode);
                setTimeout(() => showReconnectingIndicator(false), 2000);
            }, 3000);
        }
    };
}

// ---------------------------------------------------------------------------
// APPLY REMOTE STATE — globals FIRST, then render
// ---------------------------------------------------------------------------

let _lastRemoteUpdate = 0;

function applyRemoteState(session) {
    const ts = session.last_active ? new Date(session.last_active).getTime() : 0;
    if (ts > 0 && ts < _lastRemoteUpdate) {
        console.log('CourtSide: ignoring stale remote update');
        return;
    }
    _lastRemoteUpdate = ts || Date.now();
    const prevCount = currentMatches.length;

    // Globals FIRST — no render reads stale data
    squad          = session.squad           || [];
    currentMatches = session.current_matches || [];
    roundHistory   = session.round_history   || [];
    window._sessionUUIDMap  = session.uuid_map         || {};
    window._approvedPlayers = session.approved_players || {};

    if (!isOperator) {
        if (typeof PlayerMode !== 'undefined') {
            PlayerMode._onSessionUpdate(session);
        } else if (typeof SidelineView !== 'undefined') {
            SidelineView.refresh();
        }
    } else {
        renderSquad();
        document.getElementById('matchContainer').innerHTML = '';
        renderSavedMatches();
        checkNextButtonState();
        updateUndoButton();
        if (typeof checkIWTPSmartRecognition === 'function') checkIWTPSmartRecognition();
    }
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
    } catch (e) { console.error('CourtSide: delete failed', e); }
    leaveSession();
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function updateSessionUI() {
    let badge = document.getElementById('sessionBadge');
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'sessionBadge';
        document.body.appendChild(badge);
    }
    if (!isOnlineSession) { badge.style.display = 'none'; return; }
    badge.style.display = 'flex';
    badge.className     = 'session-badge';
    badge.innerHTML = `
        <span class="session-dot ${isOperator ? 'dot-operator' : 'dot-spectator'}"></span>
        <span class="session-code">${currentRoomCode}</span>
        <span class="session-role">${isOperator ? 'HOST' : 'LIVE'}</span>
    `;
    if (!isOperator) document.body.classList.add('spectator-mode');
    else document.body.classList.remove('spectator-mode');
}

function lockUIForSpectator(lock) {
    if (lock) document.body.classList.add('spectator-mode');
    else document.body.classList.remove('spectator-mode');
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

// Hook saveToDisk: push + broadcast game state on every host save
const _originalSaveToDisk = saveToDisk;
saveToDisk = function () {
    _originalSaveToDisk();
    if (isOnlineSession && isOperator) {
        pushStateToSupabase();
        broadcastGameState();   // instant, no debounce
    }
};

// ---------------------------------------------------------------------------
// AUTO-REJOIN
// ---------------------------------------------------------------------------

async function tryAutoRejoin() {
    const urlParams = new URLSearchParams(window.location.search);
    const joinCode  = urlParams.get('join');
    const role      = urlParams.get('role');
    if (joinCode) {
        const cleanUrl = window.location.origin + window.location.pathname +
            (role ? `?role=${role}` : '');
        window.history.replaceState({}, document.title, cleanUrl);
        await joinOnlineSession(joinCode);
        return;
    }
    const savedCode = localStorage.getItem('cs_room_code');
    if (!savedCode) return;
    try {
        const result = await apiCall(`session-get?code=${encodeURIComponent(savedCode)}`);
        if (!result.ok) {
            localStorage.removeItem('cs_room_code');
            localStorage.removeItem('cs_operator_key');
            localStorage.removeItem('cs_op_key_hash');
            return;
        }
        const session = result.data?.session || result.data;
        currentRoomCode = savedCode;
        isOnlineSession = true;
        const savedHash = localStorage.getItem('cs_op_key_hash');
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
// SPECTATOR PRESENCE
// ---------------------------------------------------------------------------

let spectatorCount    = 0;
let presenceHeartbeat = null;

async function registerPresence() {
    if (isOperator) return;
    try {
        await apiCall('session-presence', {
            method: 'POST',
            body: { room_code: currentRoomCode, action: 'join' },
        });
        clearInterval(presenceHeartbeat);
        presenceHeartbeat = setInterval(async () => {
            if (!isOnlineSession) { clearInterval(presenceHeartbeat); return; }
            await apiCall('session-presence', { method: 'POST', body: { room_code: currentRoomCode, action: 'ping' } }).catch(() => {});
        }, 20000);
    } catch { /* silent */ }
}

function updateSpectatorCount(count) {
    spectatorCount = count;
    const countEl = document.getElementById('spectatorCount');
    if (countEl) {
        countEl.textContent   = `👁 ${count}`;
        countEl.style.display = count > 0 ? 'inline-flex' : 'none';
    }
}

const _originalUpdateSessionUI = updateSessionUI;
updateSessionUI = function() {
    _originalUpdateSessionUI();
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
    if (isOnlineSession && !isOperator) registerPresence();
    if (typeof updateIWTPVisibility === 'function') updateIWTPVisibility();
    if (isOnlineSession && isOperator && typeof _startPolling === 'function') _startPolling();
};

// ---------------------------------------------------------------------------
// MATCH HISTORY ARCHIVAL
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
    } catch (e) { console.error('CourtSide: archive failed', e); }
}