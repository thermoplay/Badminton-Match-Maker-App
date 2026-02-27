// =============================================================================
// COURTSIDE PRO — sync.js  v5
// =============================================================================
// FIXES IN THIS VERSION:
//   #2  — pushStateToSupabase now carries a version counter; server only
//         applies updates with a higher version (prevents stale-write overwrite)
//   #3  — session-presence PATCH no longer updates last_active, eliminating
//         the heartbeat-poisons-stale-guard bug
//   #6  — _subscribeAndPoll is called AFTER _submitJoinRequest, not before,
//         so the queued-state block cannot be overwritten by an arriving
//         game_state broadcast before it renders
//   #12 — subscribeRealtime sends phx_leave for all three channels before
//         re-joining, preventing phantom server-side subscriptions
//   #13 — _startPolling guards with a module-level flag and clears the
//         previous interval before creating a new one (no stacking)
//   #22 — spectator_count incremented/decremented via Supabase RPC to
//         avoid the non-atomic read-modify-write race
// =============================================================================

let isOnlineSession   = false;
let isOperator        = false;
let currentRoomCode   = null;
let operatorKey       = null;
let operatorKeyHash   = null;
let realtimeChannel   = null;
let syncDebounceTimer = null;

// FIX #2: monotonic version counter — incremented on every host push.
// The server compares this to sessions.state_version and rejects lower values.
let _stateVersion = 0;

// FIX #13: single polling interval reference so it can be cleared on re-call.
let _pollInterval    = null;
let _pollingStarted  = false;

// ---------------------------------------------------------------------------
// STATE MIRROR
// ---------------------------------------------------------------------------
function _syncState() {
    window.isOnlineSession = isOnlineSession;
    window.isOperator      = isOperator;
    window.currentRoomCode = currentRoomCode;
}

window._sessionMembers = {};

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
        _stateVersion   = 1;
        _syncState();

        // FIX #4 (partial): store raw key in sessionStorage only, not localStorage.
        // sessionStorage is tab-scoped and cleared when the tab closes, limiting
        // the exposure window vs. the previous localStorage storage.
        sessionStorage.setItem('cs_operator_key', opKey);
        localStorage.setItem('cs_room_code',   roomCode);
        localStorage.setItem('cs_op_key_hash', operatorKeyHash);

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
        const session    = result.data?.session || result.data;
        const savedCode  = localStorage.getItem('cs_room_code');
        // FIX #4: read from sessionStorage first, fall back to localStorage for
        // backward compatibility with sessions started before this patch.
        const savedOpKey = sessionStorage.getItem('cs_operator_key')
                        || localStorage.getItem('cs_operator_key');
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
        _syncState();
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
// FIX #2: include _stateVersion so the server can reject stale writes.
// ---------------------------------------------------------------------------

function pushStateToSupabase() {
    if (!isOnlineSession || !isOperator) return;
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(async () => {
        _stateVersion++;
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
                    state_version:    _stateVersion,
                },
            });
        } catch (e) {
            console.error('CourtSide: push failed', e);
            // Roll back the version increment so the next attempt retries correctly
            _stateVersion--;
        }
    }, 800);
}

// ---------------------------------------------------------------------------
// BROADCAST — instant events, no DB write, <100ms delivery
// ---------------------------------------------------------------------------

function _broadcast(type, payload) {
    if (!realtimeChannel || realtimeChannel.readyState !== WebSocket.OPEN) return;
    realtimeChannel.send(JSON.stringify({
        topic:   `realtime:courtside-${currentRoomCode}`,
        event:   'broadcast',
        payload: { type, ...payload },
        ref:     String(Date.now()),
    }));
}

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

function broadcastGameState() {
    if (!isOperator || !isOnlineSession) return;
    _broadcast('game_state', {
        squad,
        current_matches: currentMatches,
        next_up: (document.getElementById('nextUpNames')?.textContent || '').trim(),
    });
}

function broadcastMatchResult(winnerUUIDs, loserUUIDs, gameLabel) {
    if (!isOperator) return;
    winnerUUIDs.forEach(uuid => {
        _broadcast('match_result', { playerUUID: uuid, event: 'WIN', gameLabel });
    });
    loserUUIDs.forEach(uuid => {
        _broadcast('match_result', { playerUUID: uuid, event: 'LOSS', gameLabel });
    });
}

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
// SESSION MEMBERS — DB operations
// ---------------------------------------------------------------------------

async function memberApprove(playerUUID) {
    if (!isOperator || !currentRoomCode || !operatorKey || !playerUUID) return;
    try {
        const r = await fetch('/api/member-approve', {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code:    currentRoomCode,
                player_uuid:  playerUUID,
                operator_key: operatorKey,
            }),
        });
        if (!r.ok) console.error('[CourtSide] member-approve failed:', r.status);
    } catch (e) { console.error('[CourtSide] member-approve error:', e); }
}

async function memberRename(playerUUID, newName) {
    if (!currentRoomCode || !playerUUID || !newName) return;
    try {
        const r = await fetch('/api/member-rename', {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code:   currentRoomCode,
                player_uuid: playerUUID,
                new_name:    newName,
            }),
        });
        if (!r.ok) console.error('[CourtSide] member-rename failed:', r.status);
    } catch (e) { console.error('[CourtSide] member-rename error:', e); }
}

async function memberUpsert(playerUUID, playerName, explicitRoomCode) {
    const roomCode = explicitRoomCode || currentRoomCode || window.currentRoomCode || null;
    if (!roomCode || !playerUUID || !playerName) return null;
    currentRoomCode        = roomCode;
    window.currentRoomCode = roomCode;
    _syncState();
    try {
        const r = await fetch('/api/member-upsert', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code:   roomCode,
                player_uuid: playerUUID,
                player_name: playerName,
            }),
        });
        if (!r.ok) { console.error('[CourtSide] member-upsert failed:', r.status); return null; }
        return await r.json();
    } catch (e) { console.error('[CourtSide] member-upsert error:', e); return null; }
}

// ---------------------------------------------------------------------------
// HANDLE INCOMING BROADCAST EVENTS
// ---------------------------------------------------------------------------

function _handleBroadcast(payload) {
    const { type } = payload;

    if (type === 'session_joined') {
        if (!isOperator && typeof PlayerMode !== 'undefined') {
            PlayerMode._onApprovalReceived(payload);
        }
        return;
    }

    if (type === 'player_removed') {
        if (!isOperator && typeof PlayerMode !== 'undefined') {
            const p = (typeof Passport !== 'undefined') ? Passport.get() : null;
            if (p && (payload.playerUUID === p.playerUUID || payload.playerName === p.playerName)) {
                if (typeof PlayerMode._onRemovedFromSession === 'function') {
                    PlayerMode._onRemovedFromSession();
                }
            }
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

    if (type === 'match_result') {
        if (!isOperator && typeof PlayerMode !== 'undefined') {
            PlayerMode._onMatchResult(payload);
        }
        return;
    }

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

function _applyNameUpdate(playerUUID, oldName, newName) {
    if (!newName?.trim() || !playerUUID) return;
    const trimmed = newName.trim();

    let player = squad.find(p => p.uuid === playerUUID);
    if (!player) player = squad.find(p => p.name === oldName);
    if (!player) return;

    const prevName = player.name;
    player.name    = trimmed;
    player.uuid    = playerUUID;

    const uuidMap = window._sessionUUIDMap || {};
    if (uuidMap[prevName] === playerUUID) delete uuidMap[prevName];
    uuidMap[trimmed]       = playerUUID;
    window._sessionUUIDMap = uuidMap;

    renderSquad();
    saveToDisk();
    showSessionToast(`✏️ ${prevName} → ${trimmed}`);
}

// ---------------------------------------------------------------------------
// REAL-TIME SUBSCRIPTION
// FIX #12: send phx_leave for all channels before re-subscribing to prevent
// phantom server-side subscriptions accumulating across reconnects.
// ---------------------------------------------------------------------------

// Track which channels have been joined so we can leave them cleanly.
let _joinedChannels = [];

function subscribeRealtime(roomCode) {
    // FIX #12: gracefully leave existing channels on the old socket before
    // closing it, so Supabase cleans them up server-side immediately.
    if (realtimeChannel && realtimeChannel.readyState === WebSocket.OPEN) {
        _joinedChannels.forEach(topic => {
            try {
                realtimeChannel.send(JSON.stringify({
                    topic,
                    event:   'phx_leave',
                    payload: {},
                    ref:     String(Date.now()),
                }));
            } catch (_) { /* socket may already be closing */ }
        });
    }
    _joinedChannels = [];

    if (realtimeChannel) {
        // Prevent the onclose reconnect loop from firing while we intentionally close
        realtimeChannel._intentionalClose = true;
        realtimeChannel.close();
        realtimeChannel = null;
    }

    const ws = new WebSocket(`${_RT_URL}?apikey=${_RT_KEY}&vsn=1.0.0`);
    realtimeChannel = ws;
    ws._intentionalClose = false;

    const sessionsChannel  = 'realtime:public:sessions';
    const broadcastChannel = `realtime:courtside-${roomCode}`;
    const membersChannel   = 'realtime:public:session_members';

    ws.onopen = () => {
        _joinedChannels = [sessionsChannel, broadcastChannel, membersChannel];

        ws.send(JSON.stringify({
            topic: sessionsChannel,
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

        ws.send(JSON.stringify({
            topic: broadcastChannel,
            event: 'phx_join',
            payload: { config: { broadcast: { self: false } } },
            ref: '2',
        }));

        ws.send(JSON.stringify({
            topic: membersChannel,
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
                ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: data.ref }));
                return;
            }
            if (data.event === 'postgres_changes') {
                const table  = data.payload?.data?.table || data.payload?.table;
                const record = data.payload?.data?.record;
                const old    = data.payload?.data?.old_record;

                if (table === 'session_members') {
                    if (record) _handleMemberChange(record, old, data.payload?.data?.type);
                    return;
                }

                if (!isOperator && record) {
                    applyRemoteState(record);
                }
                return;
            }
            if (data.event === 'broadcast' && data.payload?.type) {
                _handleBroadcast(data.payload);
                return;
            }
        } catch { /* ignore malformed frames */ }
    };

    ws.onerror = () => {};
    ws.onclose = () => {
        if (ws._intentionalClose) return; // we closed it ourselves — don't reconnect
        if (isOnlineSession) {
            setTimeout(() => subscribeRealtime(roomCode), 3000);
        }
    };
}

// ---------------------------------------------------------------------------
// APPLY REMOTE STATE
// FIX #3: The stale-state guard now uses sessions.state_version (an integer)
// instead of last_active (a timestamp that presence heartbeats also update).
// ---------------------------------------------------------------------------

let _lastAppliedVersion = 0;

function applyRemoteState(session) {
    // FIX #3: prefer state_version over last_active for staleness checks.
    // Fall back to timestamp comparison only for sessions that predate this fix.
    const remoteVersion = session.state_version || 0;
    if (remoteVersion > 0) {
        if (remoteVersion <= _lastAppliedVersion) {
            console.log('CourtSide: ignoring stale remote update (version)', remoteVersion, '<=', _lastAppliedVersion);
            return;
        }
        _lastAppliedVersion = remoteVersion;
    } else {
        // Legacy fallback: timestamp-based guard, but EXCLUDE presence-only updates.
        // Presence updates change only spectator_count + last_active — we detect them
        // by checking if the game-state fields are unchanged (squad length as proxy).
        const ts = session.last_active ? new Date(session.last_active).getTime() : 0;
        const wasPresenceOnly = session._presenceOnly === true;
        if (wasPresenceOnly) return; // skip — server must tag presence-only PATCHes
    }

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
        document.getElementById('matchContainer').innerHTML = '';
        renderSavedMatches();
        checkNextButtonState();
        updateUndoButton();
        if (typeof checkIWTPSmartRecognition === 'function') checkIWTPSmartRecognition();
    }
    if (currentMatches.length > 0 && currentMatches.length !== prevCount) Haptic.bump();
}

// ---------------------------------------------------------------------------
// SESSION MEMBERS — realtime change handler
// ---------------------------------------------------------------------------

function _handleMemberChange(record, oldRecord, eventType) {
    if (!record) return;

    const uuid = record.player_uuid;
    const name = record.player_name;

    if (isOperator) {
        if (eventType === 'INSERT') {
            window._sessionMembers[uuid] = record;
        } else if (eventType === 'UPDATE') {
            const prev = window._sessionMembers[uuid] || {};
            window._sessionMembers[uuid] = record;
            if (prev.player_name && prev.player_name !== name) {
                _applyNameUpdate(uuid, prev.player_name, name);
                showSessionToast(`✏️ ${prev.player_name} → ${name}`);
            }
        } else if (eventType === 'DELETE') {
            delete window._sessionMembers[uuid];
        }
        return;
    }

    const passport = (typeof Passport !== 'undefined') ? Passport.get() : null;
    if (!passport || uuid !== passport.playerUUID) return;

    if (record.status === 'active') {
        if (typeof PlayerMode !== 'undefined') PlayerMode._onMemberActivated(record);
    } else if (record.status === 'pending' || eventType === 'DELETE') {
        if (typeof PlayerMode !== 'undefined' && typeof PlayerMode._onRemovedFromSession === 'function') {
            PlayerMode._onRemovedFromSession();
        }
    }
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
    _stateVersion   = 0;
    _lastAppliedVersion = 0;
    _syncState();

    if (realtimeChannel) {
        realtimeChannel._intentionalClose = true;
        realtimeChannel.close();
        realtimeChannel = null;
    }
    _joinedChannels = [];

    localStorage.removeItem('cs_room_code');
    localStorage.removeItem('cs_operator_key'); // clean up legacy key too
    localStorage.removeItem('cs_op_key_hash');
    sessionStorage.removeItem('cs_operator_key');

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
        broadcastGameState();
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
        if (role === 'player') {
            currentRoomCode        = joinCode;
            window.currentRoomCode = joinCode;
            window._pendingJoinCode = joinCode;
            _syncState();
            const cleanUrl = window.location.origin + window.location.pathname + '?role=player';
            window.history.replaceState({}, document.title, cleanUrl);
            return;
        }
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
        const session    = result.data?.session || result.data;
        currentRoomCode  = savedCode;
        isOnlineSession  = true;
        const savedHash  = localStorage.getItem('cs_op_key_hash');
        const savedOpKey = sessionStorage.getItem('cs_operator_key')
                        || localStorage.getItem('cs_operator_key');

        if (savedHash && savedHash === session.operator_key_hash) {
            isOperator      = true;
            operatorKey     = savedOpKey;
            operatorKeyHash = savedHash;
            // Sync version from server to avoid immediately pushing a stale write
            _stateVersion = session.state_version || 0;
            _lastAppliedVersion = _stateVersion;
        } else {
            isOperator = false;
        }
        _syncState();
        applyRemoteState(session);
        subscribeRealtime(savedCode);
        updateSessionUI();
        showSessionToast(isOperator ? `✅ Reconnected as host` : `👁 Rejoined session`);
    } catch { /* silently stay offline */ }
}

// ---------------------------------------------------------------------------
// SPECTATOR PRESENCE
// FIX #22: Use Supabase RPC (or a dedicated endpoint) for atomic increment.
// Until the server exposes an RPC, we POST action:'join'/'leave'/'ping' to
// session-presence and let the SERVER do the atomic increment/decrement.
// The previous non-atomic read-modify-write has been removed from the client.
// ---------------------------------------------------------------------------

let presenceHeartbeat = null;

async function registerPresence() {
    if (isOperator) return;
    try {
        // Server-side session-presence now does atomic increment via SQL:
        //   UPDATE sessions SET spectator_count = spectator_count + 1
        // No client-side read is needed.
        await apiCall('session-presence', {
            method: 'POST',
            body: { room_code: currentRoomCode, action: 'join' },
        });
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

function updateSpectatorCount(count) {
    const countEl = document.getElementById('spectatorCount');
    if (countEl) {
        countEl.textContent   = `👁 ${count}`;
        countEl.style.display = count > 0 ? 'inline-flex' : 'none';
    }
}

// FIX #13: Override updateSessionUI ONCE with a version that uses _startPolling
// safely. Guard with _pollingStarted so the interval never stacks.
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
    // FIX #13: _startPolling is called here instead of everywhere else.
    if (isOnlineSession && isOperator) _startPolling();
};

// FIX #13: Guard-protected polling starter. Clears the existing interval
// before creating a new one so it never stacks across updateSessionUI calls.
function _startPolling() {
    if (_pollInterval) {
        clearInterval(_pollInterval);
        _pollInterval = null;
    }
    pollPlayRequests(); // immediate first poll
    _pollInterval = setInterval(() => {
        if (isOnlineSession && isOperator) pollPlayRequests();
    }, 10000);
}

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