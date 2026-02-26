// =============================================================================
// COURTSIDE PRO — sync.js  v5  (REWRITTEN — structural fixes applied)
// =============================================================================
// GLOBAL VARIABLE CONTRACT:
//   All globals declared here are hoisted to window scope so every function
//   in app.js, logic.js, passport.js, and inline onclick handlers can reference
//   them without ReferenceError — even before initApp() populates them.
//
// ASYNC BOOT ORDER (enforced by DOMContentLoaded in index.html):
//   1. Passport init   — localStorage read / UUID creation
//   2. URL parse       — extract ?room= or ?join= param → currentRoomID
//   3. DB init         — tryAutoRejoin() / PlayerMode.boot()
//   4. UI render       — only after steps 1-3 complete
//
// BUG FIXES IN THIS VERSION:
//   #1 — QR URL now uses ?room=XXXX-XXXX (not ?join=) — consistent everywhere
//   #2 — saveName() calls joinSession() directly — no second click needed
//   #3 — currentRoomID set BEFORE memberUpsert / QR generation
//   #4 — Host postgres_changes listener updates squad names in real time
//   #5 — Win signal fires from processAndNext() with correct UUID resolution
// =============================================================================

// ---------------------------------------------------------------------------
// GLOBAL DECLARATIONS — top of file, accessible to all scripts
// ---------------------------------------------------------------------------
let passport         = null;   // Player identity object — Passport.init() fills this
let supabase         = null;   // Reserved for future Supabase JS client
let currentRoomID    = null;   // Active room code — set BEFORE any DB calls
let inviteQR         = null;   // Alias for InviteQR — wired in initApp()

// Session state
let isOnlineSession   = false;
let isOperator        = false;
let currentRoomCode   = null;  // Alias for currentRoomID (legacy compatibility)
let operatorKey       = null;
let operatorKeyHash   = null;
let realtimeChannel   = null;
let syncDebounceTimer = null;

// session_members realtime cache: player_uuid → { player_uuid, player_name, status }
window._sessionMembers = {};

// Supabase Realtime credentials
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

        // ── FIX #3: Set currentRoomID immediately after DB confirms creation ──
        // This ensures QR generation (triggered right after) has a valid room code.
        currentRoomID   = roomCode;
        currentRoomCode = roomCode;  // keep legacy alias in sync
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

        // Auto-start play request polling for host
        if (typeof _startPolling === 'function') _startPolling();

    } catch (e) {
        console.error('[CourtSide] create failed', e);
        showSyncStatus('Failed to create session. Check your connection.', 'error');
        Haptic.error();
    }
}

// ---------------------------------------------------------------------------
// JOIN SESSION (Host path — spectator/reconnect)
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
        const session    = result.data?.session || result.data;
        const savedCode  = localStorage.getItem('cs_room_code');
        const savedOpKey = localStorage.getItem('cs_operator_key');
        const savedHash  = localStorage.getItem('cs_op_key_hash');

        // ── FIX #3: Set currentRoomID before any subscriptions or UI updates ──
        currentRoomID   = code;
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
        console.error('[CourtSide] join failed', e);
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
                    room_code:        currentRoomID,
                    operator_key:     operatorKey,
                    squad,
                    current_matches:  currentMatches,
                    round_history:    roundHistory,
                    uuid_map:         window._sessionUUIDMap  || {},
                    approved_players: window._approvedPlayers || {},
                },
            });
        } catch (e) { console.error('[CourtSide] push failed', e); }
    }, 800);
}

// ---------------------------------------------------------------------------
// BROADCAST — instant events, no DB write, <100ms delivery
// ---------------------------------------------------------------------------

function _broadcast(type, payload) {
    if (!realtimeChannel || realtimeChannel.readyState !== WebSocket.OPEN) return;
    realtimeChannel.send(JSON.stringify({
        topic:   `realtime:courtside-${currentRoomID}`,
        event:   'broadcast',
        payload: { type, ...payload },
        ref:     String(Date.now()),
    }));
}

function broadcastApproval(playerUUID, playerName, token) {
    if (!isOperator) return;
    _broadcast('session_joined', {
        playerUUID, playerName, token, squad,
        current_matches: currentMatches,
    });
}

function broadcastGameState() {
    if (!isOperator || !isOnlineSession) return;
    _broadcast('game_state', {
        squad,
        current_matches: currentMatches,
        next_up: (document.getElementById('nextUpNames')?.textContent || '').trim(),
    });
}

// broadcastMatchResult removed — match_resolved carries UUIDs, no need for per-player broadcasts

function broadcastNameUpdate(playerUUID, oldName, newName) {
    if (!realtimeChannel || realtimeChannel.readyState !== WebSocket.OPEN) return;
    realtimeChannel.send(JSON.stringify({
        topic:   `realtime:courtside-${currentRoomID}`,
        event:   'broadcast',
        payload: { type: 'name_update', playerUUID, oldName, newName },
        ref:     String(Date.now()),
    }));
}

// ---------------------------------------------------------------------------
// SESSION MEMBERS — DB operations
// ---------------------------------------------------------------------------

async function memberApprove(playerUUID) {
    if (!isOperator || !currentRoomID || !operatorKey || !playerUUID) return;
    try {
        const r = await fetch('/api/member-approve', {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code:    currentRoomID,
                player_uuid:  playerUUID,
                operator_key: operatorKey,
            }),
        });
        if (!r.ok) console.error('[CourtSide] member-approve failed:', r.status);
    } catch (e) { console.error('[CourtSide] member-approve error:', e); }
}

async function memberRename(playerUUID, newName) {
    if (!currentRoomID || !playerUUID || !newName) return;
    try {
        const r = await fetch('/api/member-rename', {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code:   currentRoomID,
                player_uuid: playerUUID,
                new_name:    newName,
            }),
        });
        if (!r.ok) console.error('[CourtSide] member-rename failed:', r.status);
    } catch (e) { console.error('[CourtSide] member-rename error:', e); }
}

async function memberUpsert(playerUUID, playerName) {
    if (!currentRoomID || !playerUUID || !playerName) return null;
    try {
        const r = await fetch('/api/member-upsert', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code:   currentRoomID,
                player_uuid: playerUUID,
                player_name: playerName,
            }),
        });
        if (!r.ok) { console.error('[CourtSide] member-upsert failed:', r.status); return null; }
        return await r.json();
    } catch (e) { console.error('[CourtSide] member-upsert error:', e); return null; }
}

// ---------------------------------------------------------------------------
// BROADCAST HANDLER
// ---------------------------------------------------------------------------

function _handleBroadcast(payload) {
    const { type } = payload;

    if (type === 'session_joined') {
        if (!isOperator && typeof PlayerMode !== 'undefined') {
            PlayerMode._onApprovalReceived(payload);
        }
        return;
    }

    if (type === 'game_state') {
        if (!isOperator) {
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

    // match_result (individual per-UUID) is intentionally NOT handled here.
    // match_resolved already carries winnerUUIDs + loserUUIDs and is the
    // single canonical stat-recording path. Handling both would double-count.

    if (type === 'match_resolved') {
        if (!isOperator && typeof PlayerMode !== 'undefined') {
            PlayerMode._onMatchResolved(payload);
        }
        return;
    }

    if (type === 'name_update') {
        if (isOperator) {
            _applyNameUpdate(payload.playerUUID, payload.oldName, payload.newName);
        }
        return;
    }
}

// ── FIX #4: Host name sync via postgres_changes ──────────────────────────────
// UUID-first lookup survives renames. Called from _handleMemberChange on UPDATE.
function _applyNameUpdate(playerUUID, oldName, newName) {
    if (!newName?.trim() || !playerUUID) return;
    const trimmed = newName.trim();

    let player = squad.find(p => p.uuid === playerUUID);
    if (!player) player = squad.find(p => p.name === oldName);
    if (!player) return;

    const prevName   = player.name;
    player.name      = trimmed;
    player.uuid      = playerUUID;

    const uuidMap = window._sessionUUIDMap || {};
    if (uuidMap[prevName] === playerUUID) delete uuidMap[prevName];
    uuidMap[trimmed] = playerUUID;
    window._sessionUUIDMap = uuidMap;

    renderSquad();
    saveToDisk();
    showSessionToast(`✏️ ${prevName} → ${trimmed}`);
}

// ---------------------------------------------------------------------------
// REALTIME SUBSCRIPTION
// ---------------------------------------------------------------------------

function subscribeRealtime(roomCode) {
    if (realtimeChannel) {
        realtimeChannel.close();
        realtimeChannel = null;
    }
    const ws = new WebSocket(`${_RT_URL}?apikey=${_RT_KEY}&vsn=1.0.0`);
    realtimeChannel = ws;

    ws.onopen = () => {
        // Channel 1: sessions postgres_changes
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

        // Channel 2: broadcast (instant events)
        ws.send(JSON.stringify({
            topic: `realtime:courtside-${roomCode}`,
            event: 'phx_join',
            payload: { config: { broadcast: { self: false } } },
            ref: '2',
        }));

        // Channel 3: session_members postgres_changes
        // ── FIX #4: Host receives name updates; Player receives own approval ──
        ws.send(JSON.stringify({
            topic: `realtime:public:session_members`,
            event: 'phx_join',
            payload: {
                config: {
                    broadcast:        { self: false },
                    presence:         { key: '' },
                    postgres_changes: [{
                        event:  '*',
                        schema: 'public',
                        table:  'session_members',
                        filter: `room_code=eq.${roomCode}`,
                    }],
                },
            },
            ref: '3',
        }));
    };

    ws.onmessage = (msg) => {
        try {
            const data = JSON.parse(msg.data);
            if (data.event === 'heartbeat') {
                ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: '4' }));
                return;
            }
            if (data.event === 'postgres_changes') {
                const table  = data.payload?.data?.table;
                const record = data.payload?.data?.record;
                const old    = data.payload?.data?.old_record;
                const evType = data.payload?.data?.type;

                if (table === 'session_members') {
                    if (record) _handleMemberChange(record, old, evType);
                    return;
                }
                if (!isOperator && record) {
                    applyRemoteState(record);
                }
                return;
            }
            if (data.event === 'broadcast' && data.payload?.type) {
                _handleBroadcast(data.payload);
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
// APPLY REMOTE STATE
// ---------------------------------------------------------------------------

let _lastRemoteUpdate = 0;

function applyRemoteState(session) {
    const ts = session.last_active ? new Date(session.last_active).getTime() : 0;
    if (ts > 0 && ts < _lastRemoteUpdate) return;
    _lastRemoteUpdate = ts || Date.now();

    const prevCount = currentMatches.length;

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
        const mc = document.getElementById('matchContainer');
        if (mc) mc.innerHTML = '';
        renderSavedMatches();
        checkNextButtonState();
        updateUndoButton();
    }
    if (currentMatches.length > 0 && currentMatches.length !== prevCount) Haptic.bump();
}

// ---------------------------------------------------------------------------
// SESSION MEMBERS — realtime change handler
// ── FIX #4: Host receives INSERT/UPDATE to sync names and new joins ──────────
// ── Player receives own-row UPDATE for approval (status→'active') ───────────
// ---------------------------------------------------------------------------

function _handleMemberChange(record, oldRecord, eventType) {
    if (!record) return;

    const uuid = record.player_uuid;
    const name = record.player_name;

    if (isOperator) {
        if (eventType === 'INSERT') {
            window._sessionMembers[uuid] = record;
            // Trigger poll so the notification badge refreshes
            if (typeof pollPlayRequests === 'function') pollPlayRequests();
        } else if (eventType === 'UPDATE') {
            const prev = window._sessionMembers[uuid] || {};
            window._sessionMembers[uuid] = record;

            // ── FIX #4: Name changed → update squad immediately ───────────────
            if (prev.player_name && prev.player_name !== name) {
                _applyNameUpdate(uuid, prev.player_name, name);
            }
        } else if (eventType === 'DELETE') {
            delete window._sessionMembers[uuid];
        }
        return;
    }

    // Player path — only react to own row
    const p = (typeof Passport !== 'undefined') ? Passport.get() : null;
    if (!p || uuid !== p.playerUUID) return;

    if (record.status === 'active') {
        if (typeof PlayerMode !== 'undefined') {
            PlayerMode._onMemberActivated(record);
        }
    }
}

// ---------------------------------------------------------------------------
// LEAVE / END SESSION
// ---------------------------------------------------------------------------

function leaveSession() {
    isOnlineSession = false;
    isOperator      = false;
    currentRoomID   = null;
    currentRoomCode = null;
    operatorKey     = null;
    operatorKeyHash = null;
    if (realtimeChannel) { realtimeChannel.close(); realtimeChannel = null; }
    localStorage.removeItem('cs_room_code');
    localStorage.removeItem('cs_operator_key');
    localStorage.removeItem('cs_op_key_hash');
    updateSessionUI();
}

async function endAndDeleteSession() {
    if (!isOperator || !currentRoomID) return;
    try {
        await apiCall('session-delete', {
            method: 'DELETE',
            body: { room_code: currentRoomID, operator_key: operatorKey },
        });
    } catch (e) { console.error('[CourtSide] delete failed', e); }
    leaveSession();
}

// ---------------------------------------------------------------------------
// UI HELPERS
// ---------------------------------------------------------------------------

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
        <span class="session-code">${currentRoomID}</span>
        <span class="session-role">${isOperator ? 'HOST' : 'LIVE'}</span>
    `;
    if (!isOperator) document.body.classList.add('spectator-mode');
    else document.body.classList.remove('spectator-mode');
    if (!isOperator) registerPresence();
    if (typeof updateIWTPVisibility === 'function') updateIWTPVisibility();
    if (isOnlineSession && isOperator && typeof _startPolling === 'function') _startPolling();

    // Spectator count badge
    if (isOperator) {
        let countEl = document.getElementById('spectatorCount');
        if (!countEl) {
            countEl = document.createElement('span');
            countEl.id = 'spectatorCount';
            countEl.className = 'spectator-count-badge';
            countEl.style.display = 'none';
            badge.appendChild(countEl);
        }
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

// Hook saveToDisk: push + broadcast on every host save
const _originalSaveToDisk = saveToDisk;
saveToDisk = function () {
    _originalSaveToDisk();
    if (isOnlineSession && isOperator) {
        pushStateToSupabase();
        broadcastGameState();
    }
};

// ---------------------------------------------------------------------------
// AUTO-REJOIN — called from bootApp() after DOMContentLoaded
//
// URL PARAMETER SUPPORT:
//   ?room=XXXX-XXXX  — primary parameter (used by host QR and invite system)
//   ?join=XXXX-XXXX  — legacy parameter (kept for backward compatibility)
//
// ── FIX #3: currentRoomID set synchronously from URL BEFORE any async calls ──
// ---------------------------------------------------------------------------

async function tryAutoRejoin() {
    const urlParams = new URLSearchParams(window.location.search);

    // Support both ?room= (new) and ?join= (legacy)
    const joinCode = urlParams.get('room') || urlParams.get('join');
    const role     = urlParams.get('role');

    if (joinCode) {
        // Clean URL — remove room/join param, keep role if present
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

        // ── FIX #3: Set globals synchronously ────────────────────────────────
        currentRoomID   = savedCode;
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

let presenceHeartbeat = null;

async function registerPresence() {
    if (isOperator || !currentRoomID) return;
    try {
        await apiCall('session-presence', {
            method: 'POST',
            body: { room_code: currentRoomID, action: 'join' },
        });
        clearInterval(presenceHeartbeat);
        presenceHeartbeat = setInterval(async () => {
            if (!isOnlineSession) { clearInterval(presenceHeartbeat); return; }
            await apiCall('session-presence', {
                method: 'POST',
                body: { room_code: currentRoomID, action: 'ping' },
            }).catch(() => {});
        }, 20000);
    } catch { /* silent */ }
}

// ---------------------------------------------------------------------------
// MATCH HISTORY ARCHIVAL
// ---------------------------------------------------------------------------

async function archiveRoundToSupabase(snapshot) {
    if (!currentRoomID) return;
    try {
        await fetch('/api/match-history', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code: currentRoomID,
                timestamp: snapshot.timestamp,
                matches:   snapshot.matches,
                squad:     snapshot.squadSnapshot,
            }),
        });
    } catch (e) { console.error('[CourtSide] archive failed', e); }
}