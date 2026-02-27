// =============================================================================
// COURTSIDE PRO — sync.js  v6
// Responsibilities: Supabase session management, Realtime subscriptions,
//                  host/spectator sync, member approve/rename/upsert,
//                  broadcast dispatch, signal polling, session toast.
//
// Depends on: app.js, passport.js (loaded before this file)
// =============================================================================

// ---------------------------------------------------------------------------
// SESSION STATE
// ---------------------------------------------------------------------------

let isOnlineSession = false;
let isOperator      = false;
let currentRoomCode = null;
let operatorKey     = null;

let _realtimeChannel = null;
let _sessionPollTimer = null;

// ---------------------------------------------------------------------------
// TOAST NOTIFICATION
// ---------------------------------------------------------------------------

function showSessionToast(msg, duration = 3200) {
    let toast = document.getElementById('sessionToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'sessionToast';
        toast.className = 'session-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
}

// ---------------------------------------------------------------------------
// ROOM CODE GENERATOR
// ---------------------------------------------------------------------------

function _generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `${seg()}-${seg()}`;
}

function _generateOperatorKey() {
    const arr = new Uint8Array(16);
    (window.crypto || crypto).getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// CREATE ONLINE SESSION (Host)
// ---------------------------------------------------------------------------

async function createOnlineSession() {
    const syncMsg = document.getElementById('syncStatusMsg');
    if (syncMsg) { syncMsg.style.display = 'block'; syncMsg.className = 'sync-status sync-status-info'; syncMsg.textContent = 'Creating session…'; }

    const roomCode = _generateRoomCode();
    const opKey    = _generateOperatorKey();

    try {
        const res = await fetch('/api/session-create', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code:       roomCode,
                operator_key:    opKey,
                squad:           squad           || [],
                current_matches: currentMatches  || [],
            }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        isOnlineSession = true;
        isOperator      = true;
        currentRoomCode = roomCode;
        operatorKey     = opKey;

        // Persist operator credentials so a page refresh can reclaim host role
        try {
            localStorage.setItem('cs_operator_room', roomCode);
            localStorage.setItem('cs_operator_key',  opKey);
        } catch { /* ignore */ }

        _attachSessionBadge(roomCode, 'operator');
        subscribeRealtime(roomCode);
        _startPolling();
        closeOverlay();
        showSessionToast(`🟢 Session live — room ${roomCode}`);
        Haptic.success();

    } catch (err) {
        console.error('[CourtSide] createOnlineSession failed:', err);
        if (syncMsg) { syncMsg.className = 'sync-status sync-status-error'; syncMsg.textContent = 'Could not create session. Check your connection.'; }
    }
}

// ---------------------------------------------------------------------------
// JOIN ONLINE SESSION (Spectator / Player)
// ---------------------------------------------------------------------------

async function joinOnlineSession(code) {
    if (!code) return;
    const roomCode = String(code).trim().toUpperCase();

    try {
        const res  = await fetch(`/api/session-get?code=${encodeURIComponent(roomCode)}`);
        if (!res.ok) { showSessionToast('Session not found.'); return; }
        const data = await res.json();

        // Check if we are the operator (rejoining after refresh)
        const savedRoom = localStorage.getItem('cs_operator_room');
        const savedKey  = localStorage.getItem('cs_operator_key');

        if (savedRoom === roomCode && savedKey) {
            // Verify operator key hash
            const enc  = new TextEncoder();
            const buf  = await crypto.subtle.digest('SHA-256', enc.encode(savedKey));
            const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
            if (hash === data.operator_key_hash) {
                isOperator      = true;
                operatorKey     = savedKey;
            }
        }

        isOnlineSession = true;
        currentRoomCode = roomCode;

        // Hydrate local state from session
        if (data.squad)           squad          = data.squad;
        if (data.current_matches) currentMatches = data.current_matches;
        if (data.round_history)   roundHistory   = data.round_history;

        window._sessionUUIDMap  = data.uuid_map         || {};
        window._approvedPlayers = data.approved_players || {};

        renderSquad();
        document.getElementById('matchContainer').innerHTML = '';
        renderSavedMatches();
        checkNextButtonState();

        _attachSessionBadge(roomCode, isOperator ? 'operator' : 'spectator');
        subscribeRealtime(roomCode);

        if (!isOperator) {
            document.body.classList.add('spectator-mode');
            showSessionToast(`👁 Watching session ${roomCode}`);
            updateIWTPVisibility();
        } else {
            _startPolling();
            showSessionToast(`🟢 Rejoined session ${roomCode}`);
        }

    } catch (err) {
        console.error('[CourtSide] joinOnlineSession failed:', err);
        showSessionToast('Could not join session.');
    }
}

// ---------------------------------------------------------------------------
// LEAVE SESSION (Spectator)
// ---------------------------------------------------------------------------

function leaveSession() {
    _teardownSession();
    document.body.classList.remove('spectator-mode');
    showSessionToast('Left session.');
    location.reload();
}

// ---------------------------------------------------------------------------
// END & DELETE SESSION (Operator)
// ---------------------------------------------------------------------------

async function endAndDeleteSession() {
    if (!currentRoomCode || !operatorKey) return;
    try {
        await fetch('/api/session-delete', {
            method:  'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ room_code: currentRoomCode, operator_key: operatorKey }),
        });
    } catch { /* silent — clean up client side regardless */ }
    _teardownSession();
    localStorage.removeItem('cs_operator_room');
    localStorage.removeItem('cs_operator_key');
    showSessionToast('Session ended.');
}

function _teardownSession() {
    isOnlineSession = false;
    isOperator      = false;
    const prev = currentRoomCode;
    currentRoomCode = null;
    operatorKey     = null;

    if (_realtimeChannel) {
        try { _realtimeChannel.unsubscribe(); } catch { }
        _realtimeChannel = null;
    }
    clearInterval(_sessionPollTimer);

    const badge = document.getElementById('sessionBadge');
    if (badge) badge.remove();

    updateIWTPVisibility();
}

// ---------------------------------------------------------------------------
// PUSH STATE TO SUPABASE (Operator → DB)
// Called after every squad/match change when online.
// ---------------------------------------------------------------------------

async function pushStateToSupabase() {
    if (!isOnlineSession || !isOperator || !currentRoomCode || !operatorKey) return;
    try {
        await fetch('/api/session-update', {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code:        currentRoomCode,
                operator_key:     operatorKey,
                squad,
                current_matches:  currentMatches,
                round_history:    roundHistory,
                uuid_map:         window._sessionUUIDMap  || {},
                approved_players: window._approvedPlayers || {},
            }),
        });
    } catch (err) {
        console.error('[CourtSide] pushStateToSupabase failed:', err);
    }
}

// ---------------------------------------------------------------------------
// ARCHIVE ROUND (Operator → match_history table)
// ---------------------------------------------------------------------------

async function archiveRoundToSupabase(snapshot) {
    if (!isOnlineSession || !currentRoomCode) return;
    try {
        await fetch('/api/match-history', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code: currentRoomCode,
                timestamp: snapshot.timestamp,
                matches:   snapshot.matches,
                squad,
            }),
        });
    } catch { /* silent */ }
}

// ---------------------------------------------------------------------------
// MEMBER API WRAPPERS
// ---------------------------------------------------------------------------

async function memberUpsert(playerUUID, playerName, roomCode) {
    try {
        const res  = await fetch('/api/member-upsert', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ room_code: roomCode, player_uuid: playerUUID, player_name: playerName }),
        });
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

async function memberApprove(playerUUID) {
    if (!currentRoomCode || !operatorKey) return;
    try {
        await fetch('/api/member-approve', {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code:    currentRoomCode,
                player_uuid:  playerUUID,
                operator_key: operatorKey,
            }),
        });
    } catch { /* silent */ }
}

async function memberRename(playerUUID, newName) {
    if (!currentRoomCode) return;
    try {
        await fetch('/api/member-rename', {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code:   currentRoomCode,
                player_uuid: playerUUID,
                new_name:    newName,
            }),
        });
    } catch { /* silent */ }
}

// ---------------------------------------------------------------------------
// BROADCAST HELPERS (Operator → Supabase Realtime)
// ---------------------------------------------------------------------------

function _broadcast(event, payload = {}) {
    if (!_realtimeChannel) return;
    try {
        _realtimeChannel.send({
            type:    'broadcast',
            event,
            payload: { ...payload, _ts: Date.now() },
        });
    } catch (err) {
        console.warn('[CourtSide] _broadcast failed:', err);
    }
}

function broadcastApproval(playerUUID, playerName, token) {
    _broadcast('player_approved', {
        playerUUID,
        playerName,
        token,
        squad,
        current_matches: currentMatches,
    });
    // Also push full state so approved player hydrates correctly
    pushStateToSupabase();
}

function broadcastNameUpdate(playerUUID, oldName, newName) {
    _broadcast('name_update', { playerUUID, oldName, newName });
    pushStateToSupabase();
}

// ---------------------------------------------------------------------------
// SUPABASE REALTIME SUBSCRIPTION
// ---------------------------------------------------------------------------

// Supabase client is initialised lazily the first time we need it.
// We read the anon key from the session-get endpoint (which returns a hash
// but NOT the key itself) — so for realtime we use the public anon key
// which is safe to expose in the browser.
// Set window.SUPABASE_ANON_KEY from a <script> tag in index.html or an
// env-injected snippet before this file loads.

function _getSupabaseClient() {
    if (window._supabaseClient) return window._supabaseClient;

    const url     = window.SUPABASE_URL;
    const anonKey = window.SUPABASE_ANON_KEY;

    if (!url || !anonKey) {
        console.warn('[CourtSide] Supabase URL/key not set — realtime disabled. Set window.SUPABASE_URL and window.SUPABASE_ANON_KEY.');
        return null;
    }

    if (!window.supabase?.createClient) {
        console.warn('[CourtSide] Supabase JS library not loaded — realtime disabled.');
        return null;
    }

    window._supabaseClient = window.supabase.createClient(url, anonKey);
    return window._supabaseClient;
}

function subscribeRealtime(roomCode) {
    // Unsubscribe from any previous channel
    if (_realtimeChannel) {
        try { _realtimeChannel.unsubscribe(); } catch { }
        _realtimeChannel = null;
    }

    const sb = _getSupabaseClient();
    if (!sb) {
        console.warn('[CourtSide] subscribeRealtime: no Supabase client — falling back to polling only.');
        _startSessionPoll(roomCode);
        return;
    }

    _realtimeChannel = sb
        .channel(`courtside:${roomCode}`)

        // ── Broadcast events (host ↔ players, low-latency) ─────────────────
        .on('broadcast', { event: 'player_approved' }, ({ payload }) => {
            if (typeof PlayerMode !== 'undefined') PlayerMode._onApprovalReceived(payload);
        })
        .on('broadcast', { event: 'game_state_update' }, ({ payload }) => {
            if (typeof PlayerMode !== 'undefined') PlayerMode._onGameStateUpdate(payload);
        })
        .on('broadcast', { event: 'match_resolved' }, ({ payload }) => {
            if (typeof PlayerMode !== 'undefined') PlayerMode._onMatchResolved(payload);
            window._lastMatchWinner = payload.winnerNames ? `🏆 ${payload.winnerNames}` : null;
            if (typeof SidelineView !== 'undefined') SidelineView.refresh();
        })
        .on('broadcast', { event: 'name_update' }, ({ payload }) => {
            _handleNameUpdate(payload);
        })
        .on('broadcast', { event: 'player_removed' }, ({ payload }) => {
            _handlePlayerRemoved(payload);
        })

        // ── Postgres changes — session row (spectators / players hydrate) ──
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `room_code=eq.${roomCode}` },
            ({ new: session }) => {
                if (!isOperator) _handleSessionUpdate(session);
            }
        )

        // ── Postgres changes — session_members (player approval) ──────────
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'session_members', filter: `room_code=eq.${roomCode}` },
            ({ eventType, new: record, old: oldRecord }) => {
                _handleMemberChange(eventType, record, oldRecord);
            }
        )

        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log(`[CourtSide] Realtime connected: ${roomCode}`);
                _hideReconnectIndicator();
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                console.warn('[CourtSide] Realtime disconnected:', status);
                _showReconnectIndicator();
            }
        });
}

// ---------------------------------------------------------------------------
// REALTIME EVENT HANDLERS
// ---------------------------------------------------------------------------

function _handleSessionUpdate(session) {
    // Hydrate state for non-operator viewers
    if (session.squad)           { squad          = session.squad;           renderSquad(); }
    if (session.current_matches) { currentMatches = session.current_matches; document.getElementById('matchContainer').innerHTML = ''; renderSavedMatches(); }
    if (session.round_history)     roundHistory   = session.round_history;
    if (session.uuid_map)          window._sessionUUIDMap  = session.uuid_map;
    if (session.approved_players)  window._approvedPlayers = session.approved_players;

    checkNextButtonState();
    updateSideline();

    if (typeof PlayerMode !== 'undefined') PlayerMode._onSessionUpdate(session);
    if (typeof SidelineView !== 'undefined') SidelineView.refresh();
}

function _handleMemberChange(eventType, record, oldRecord) {
    const passport = typeof Passport !== 'undefined' ? Passport.get() : null;
    if (!passport) return;

    // Host: a member's status changed — refresh the play requests badge
    if (isOperator) {
        if (typeof pollPlayRequests === 'function') pollPlayRequests();
        return;
    }

    // Player: their own row changed
    if (record?.player_uuid !== passport.playerUUID) return;

    if (eventType === 'UPDATE' && record.status === 'active') {
        // Host approved this player via member-approve
        if (typeof PlayerMode !== 'undefined') PlayerMode._onMemberActivated(record);
    }

    if (eventType === 'DELETE') {
        // Row deleted — treat as removal
        if (typeof PlayerMode !== 'undefined') PlayerMode._onRemovedFromSession();
    }
}

function _handleNameUpdate(payload) {
    const { playerUUID, oldName, newName } = payload;
    if (!playerUUID || !newName) return;

    // Update squad member name
    const member = squad.find(p => p.uuid === playerUUID || p.name === oldName);
    if (member) {
        const prev = member.name;
        member.name = newName;
        currentMatches.forEach(m => {
            m.teams = m.teams.map(team => team.map(n => n === prev ? newName : n));
        });
        renderSquad();
        document.getElementById('matchContainer').innerHTML = '';
        renderSavedMatches();
        if (isOperator) pushStateToSupabase();
    }
}

function _handlePlayerRemoved(payload) {
    const passport = typeof Passport !== 'undefined' ? Passport.get() : null;
    if (!passport) return;

    // Check if the removal is addressed to this player
    const { playerName, playerUUID } = payload;
    const isMe = (playerUUID && playerUUID === passport.playerUUID) ||
                 (playerName && playerName.toLowerCase() === passport.playerName?.toLowerCase());

    if (isMe && typeof PlayerMode !== 'undefined') {
        PlayerMode._onRemovedFromSession();
    }
}

// ---------------------------------------------------------------------------
// SESSION POLLING (fallback when realtime is unavailable)
// ---------------------------------------------------------------------------

function _startSessionPoll(roomCode) {
    clearInterval(_sessionPollTimer);
    _sessionPollTimer = setInterval(async () => {
        if (!currentRoomCode || isOperator) return;
        try {
            const res  = await fetch(`/api/session-get?code=${encodeURIComponent(currentRoomCode)}`);
            if (!res.ok) return;
            const data = await res.json();
            _handleSessionUpdate({
                squad:            data.squad,
                current_matches:  data.current_matches,
                round_history:    data.round_history,
                uuid_map:         data.uuid_map,
                approved_players: data.approved_players,
            });
        } catch { /* silent */ }
    }, 6000);
}

// ---------------------------------------------------------------------------
// SESSION BADGE
// ---------------------------------------------------------------------------

function _attachSessionBadge(roomCode, role) {
    let badge = document.getElementById('sessionBadge');
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'sessionBadge';
        badge.className = 'session-badge';
        document.body.appendChild(badge);
    }
    badge.innerHTML = `
        <span class="session-dot ${role === 'operator' ? 'dot-operator' : 'dot-spectator'}"></span>
        <span class="session-code">${roomCode}</span>
        <span class="session-role">${role === 'operator' ? 'HOST' : 'LIVE'}</span>
    `;
}

// ---------------------------------------------------------------------------
// RECONNECT INDICATOR
// ---------------------------------------------------------------------------

function _showReconnectIndicator() {
    let el = document.getElementById('reconnectIndicator');
    if (!el) {
        el = document.createElement('div');
        el.id = 'reconnectIndicator';
        el.className = 'reconnect-indicator';
        el.textContent = 'RECONNECTING…';
        document.body.appendChild(el);
    }
    el.classList.add('visible');
}

function _hideReconnectIndicator() {
    const el = document.getElementById('reconnectIndicator');
    if (el) el.classList.remove('visible');
}

// ---------------------------------------------------------------------------
// AUTO-REJOIN ON PAGE LOAD
// Called by bootApp() and initApp() fallback.
// Checks localStorage for a saved operator room and rejoins if found.
// ---------------------------------------------------------------------------

async function tryAutoRejoin() {
    const savedRoom = localStorage.getItem('cs_operator_room');
    const savedKey  = localStorage.getItem('cs_operator_key');

    if (!savedRoom || !savedKey) return;

    try {
        const res  = await fetch(`/api/session-get?code=${encodeURIComponent(savedRoom)}`);
        if (!res.ok) {
            // Session no longer exists — clear stale credentials
            localStorage.removeItem('cs_operator_room');
            localStorage.removeItem('cs_operator_key');
            return;
        }
        const data = await res.json();

        // Verify key hash
        const enc  = new TextEncoder();
        const buf  = await crypto.subtle.digest('SHA-256', enc.encode(savedKey));
        const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

        if (hash !== data.operator_key_hash) {
            localStorage.removeItem('cs_operator_room');
            localStorage.removeItem('cs_operator_key');
            return;
        }

        // Credentials valid — restore operator state
        isOnlineSession = true;
        isOperator      = true;
        currentRoomCode = savedRoom;
        operatorKey     = savedKey;

        if (data.squad)           squad          = data.squad;
        if (data.current_matches) currentMatches = data.current_matches;
        if (data.round_history)   roundHistory   = data.round_history;

        window._sessionUUIDMap  = data.uuid_map         || {};
        window._approvedPlayers = data.approved_players || {};

        renderSquad();
        document.getElementById('matchContainer').innerHTML = '';
        renderSavedMatches();
        updateUndoButton();
        checkNextButtonState();

        _attachSessionBadge(savedRoom, 'operator');
        subscribeRealtime(savedRoom);
        _startPolling();

        showSessionToast(`🟢 Rejoined session ${savedRoom}`);

    } catch (err) {
        console.error('[CourtSide] tryAutoRejoin failed:', err);
    }
}

// ---------------------------------------------------------------------------
// BOOT APP — called from index.html window.onload (host/spectator path)
// ---------------------------------------------------------------------------

async function bootApp() {
    // Check URL params for join code
    const params   = new URLSearchParams(window.location.search);
    const joinCode = params.get('join') || params.get('room');

    if (joinCode) {
        await joinOnlineSession(joinCode);
        return;
    }

    // Try to reclaim operator session from a previous page load
    await tryAutoRejoin();
}