// =============================================================================
// COURTSIDE PRO — sync.js  v4
// =============================================================================
// BROADCAST ARCHITECTURE
// -----------------------------------------------------------------------------
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
let sport             = 'Badminton';
let sbManager         = null; // Instance of SupabaseRealtimeManager
let _isBootingSession = false; // true only during initial rejoin hydration
let _pendingActions   = [];    // Queue for actions attempted while offline
let _dirtyIds         = new Set();
let _fullSyncPending  = false;

// ---------------------------------------------------------------------------
// STATE MIRROR — keeps window.X in sync with module-level `let` vars.
// `let` does NOT create window properties (only `var` does), so any code in
// app.js or passport.js that reads window.isOnlineSession etc. sees undefined
// unless we explicitly write it. Call _syncState() after every assignment.
// ---------------------------------------------------------------------------
function _syncState() {
    window.isOnlineSession = isOnlineSession;
    window.isOperator      = isOperator;
    window.currentRoomCode = currentRoomCode;
    window.operatorKey     = operatorKey;
    window.sport           = sport;
}

// session_members realtime state
// Key: player_uuid → { player_uuid, player_name, status, room_code }
window._sessionMembers = {};

/**
 * Generates a simple hash of the current squad and queue.
 * Used for state drift detection by players.
 */
function _generateStateHash(squad, queue) {
    // Create a deterministic string representing the core state
    const s = (squad || []).map(p => (p.uuid || p.name) + (p.active ? '1' : '0')).sort().join('');
    const q = (queue || []).join(',');
    const str = `${s}|${q}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

// It's best practice to load these from a configuration file or environment variables.
const _RT_URL = 'wss://crqwaqovoqmlyvqeekhk.supabase.co/realtime/v1/websocket';
const _RT_KEY = 'sb_publishable_2NEOSY4wadPb93X55k_uvg_ASydylcv'; // This should be your project's public anon key

// ---------------------------------------------------------------------------
// SUPABASE REALTIME MANAGER CLASS
// ---------------------------------------------------------------------------

class SupabaseRealtimeManager {
    constructor(url, key) {
        this.url = url;
        this.key = key;
        this.socket = null;
        this.roomCode = null;
        
        // Reconnection & Health
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 30000; // Cap at 30s
        this.heartbeatInterval = null;
        this.pendingHeartbeats = new Map();
        this.broadcastQueue = [];
    }

    connect(roomCode) {
        if (this.socket) this.disconnect();
        this.roomCode = roomCode;

        this.socket = new WebSocket(`${this.url}?apikey=${this.key}&vsn=1.0.0`);
        this.socket.onopen    = () => this._onOpen();
        this.socket.onmessage = (msg) => this._onMessage(msg);
        this.socket.onerror   = () => this._onError();
        this.socket.onclose   = () => this._onClose();
    }

    disconnect() {
        if (this.socket) {
            const ws = this.socket;
            this.socket = null; // Prevent auto-reconnect logic
            ws.close();
            this._stopHeartbeat();
        }
    }

    broadcast(type, payload) {
        const message = {
            topic:   `realtime:courtside-${this.roomCode}`,
            event:   'broadcast',
            payload: { type, ...payload },
            ref:     String(Date.now()),
        };

        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            // Queue the broadcast to be sent once connection is restored
            this.broadcastQueue.push(message);
            if (this.broadcastQueue.length > 50) this.broadcastQueue.shift(); // Prevent memory leak
            return;
        }
        
        try {
            this.socket.send(JSON.stringify(message));
        } catch (e) {
            this.broadcastQueue.push(message);
        }
    }

    _onOpen() {
        this.reconnectAttempts = 0;
        if (typeof showReconnectingIndicator === 'function') showReconnectingIndicator(false);
        const roomCode = this.roomCode;

        // RECOVERY: If we were offline, our local state might be stale.
        // Force a background refresh to catch missed broadcasts.
        if (!isOperator && typeof SidelineView !== 'undefined' && roomCode) {
            SidelineView._performRefresh(true);
        }
        this._flushPendingActions();

        // Flush queued broadcasts
        while (this.broadcastQueue.length > 0) {
            const msg = this.broadcastQueue.shift();
            this.socket.send(JSON.stringify(msg));
        }

        // Helper to send Phx Join messages
        const join = (topic, payload) => {
            const ref = `join-${topic}-${Date.now()}`;
            this.socket.send(JSON.stringify({ topic, event: 'phx_join', payload, ref }));
        };

        // 1. Sessions (postgres_changes)
        join('realtime:public:sessions', {
            config: {
                broadcast: { self: false },
                presence: { key: '' },
                postgres_changes: [{ event: 'UPDATE', schema: 'public', table: 'sessions', filter: `room_code=eq."${roomCode}"` }]
            }
        });

        // 2. Broadcast channel
        join(`realtime:courtside-${roomCode}`, { config: { broadcast: { self: false } } });

        // 3. Members
        join('realtime:public:session_members', {
            config: {
                broadcast: { self: false },
                presence: { key: '' },
                postgres_changes: [{ event: '*', schema: 'public', table: 'session_members', filter: `room_code=eq."${roomCode}"` }]
            }
        });

        // 4. Play Requests (Host only)
        if (isOperator) {
            join('realtime:public:play_requests', {
                config: {
                    broadcast: { self: false },
                    presence: { key: '' },
                    postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'play_requests', filter: `room_code=eq."${roomCode}"` }]
                }
            });
        }

        // 5. Passport Signals (Win/Loss notifications)
        join('realtime:public:passport_signals', {
            config: {
                broadcast: { self: false },
                postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'passport_signals', filter: `room_code=eq."${roomCode}"` }]
            }
        });

        // 6. Master Players Table (Global profile updates)
        join('realtime:public:players', {
            config: {
                broadcast: { self: false },
                postgres_changes: [{ event: 'UPDATE', schema: 'public', table: 'players' }]
            }
        });

        this._startHeartbeat();
    }

    _flushPendingActions() {
        if (_pendingActions.length === 0) return;
        console.log(`[CourtSide] Connection restored. Flushing ${_pendingActions.length} pending actions...`);
        while(_pendingActions.length > 0) {
            const { type, payload } = _pendingActions.shift();
            this.broadcast(type, payload);
        }
    }

    _onMessage(msg) {
        try {
            const data = JSON.parse(msg.data);
            
            // Phoenix Reply handling (Joins, Heartbeats)
            if (data.event === 'phx_reply' && data.ref) {
                if (this.pendingHeartbeats.has(data.ref)) this._measureLatency(data.ref);
                if (data.payload?.status === 'error') console.error('[CourtSide] Realtime error:', data.payload.response);
                return;
            }

            // Heartbeat response
            if (data.event === 'heartbeat') {
                this.socket.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: data.ref }));
                return;
            }
            
            // Route payloads to global handlers
            if (data.event === 'postgres_changes') _handlePostgresChange(data.payload);
            else if (data.event === 'broadcast' && data.payload?.type) _handleBroadcast(data.payload);

        } catch (e) {
            console.error('[CourtSide] Realtime: Error processing message', e);
        }
    }

    _onError() { 
        if (typeof showReconnectingIndicator === 'function') 
            showReconnectingIndicator(true, '📡 Signal Lost...'); 
    }

    _onClose() {
        this._stopHeartbeat();
        if (this.socket && isOnlineSession) {
            // Exponential Backoff: 1s, 2s, 4s... up to 30s
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
            this.reconnectAttempts++;
            setTimeout(() => this.connect(this.roomCode), delay);
        }
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
            const ref = `hb-${Date.now()}`;
            this.pendingHeartbeats.set(ref, Date.now());
            this.socket.send(JSON.stringify({
                topic: 'phoenix',
                event: 'heartbeat',
                payload: {},
                ref: ref
            }));
        }, 5000); // 5s ping
    }

    _stopHeartbeat() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
        this.pendingHeartbeats.clear();
    }

    _measureLatency(ref) {
        const start = this.pendingHeartbeats.get(ref);
        this.pendingHeartbeats.delete(ref);
        if (start) {
            const latency = Date.now() - start;
            if (typeof _updateLatencyDisplay === 'function') _updateLatencyDisplay(latency);
            
            // If latency is very high (>1.5s), show a soft warning. Otherwise, clear it.
            if (latency > 1500) {
                if (typeof showReconnectingIndicator === 'function') showReconnectingIndicator(true, '📡 Weak Signal...');
            } else if (this.socket?.readyState === WebSocket.OPEN) {
                // Re-sync network icon for players to show real-time signal quality
                const netIcon = document.getElementById('slNetworkIcon');
                if (netIcon) netIcon.className = 'sl-network-icon ' + (latency > 400 ? 'weak' : 'online');
                
                if (typeof showReconnectingIndicator === 'function') showReconnectingIndicator(false);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// API HELPERS
// ---------------------------------------------------------------------------

async function apiCall(route, options = {}, retries = 2) {
    const url = `/api/${route}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const fetchOpts = {
        method:  options.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body:    options.body ? JSON.stringify(options.body) : undefined,
        signal:  controller.signal
    };

    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, fetchOpts);
            
            // RETRY STRATEGY: Retry on 5xx errors or 429 rate limits
            if (!res.ok && (res.status >= 500 || res.status === 429) && i < retries) {
                throw new Error(`Server error ${res.status}`);
            }
            
            const data = await res.json().catch(() => ({}));
            clearTimeout(timeoutId);
            return { ok: res.ok, status: res.status, data };
        } catch (e) {
            if (e.name === 'AbortError' && i === retries) return { ok: false, status: 0, data: { error: 'Request Timeout' } };
            // Retry on network failures (TypeError)
            if (i === retries) return { ok: false, status: 0, data: { error: 'Network error' } };
            // Backoff: 500ms, 1000ms
            await new Promise(r => setTimeout(r, 500 * (i + 1)));
        }
    }
    clearTimeout(timeoutId);
}

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const seg   = () => Array.from({ length: 4 }, () =>
        chars[Math.floor(Math.random() * chars.length)]).join('');
    return `${seg()}-${seg()}`;
}

function generateOperatorKey() {
    return Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
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
            body: {
                room_code: roomCode,
                operator_key: opKey,
                sport: StateStore.get('sport') || 'Badminton',
                court_names: StateStore.get('courtNames'),
                squad: StateStore.squad,
                current_matches: StateStore.currentMatches,
                player_queue: StateStore.playerQueue
            },
        });
        if (!result.ok) throw new Error(result.data?.error || 'Create failed');

        // BUG FIX: Clear local history from previous sessions when starting fresh.
        if (typeof window.roundHistory !== 'undefined') {
            window.roundHistory = [];
            if (typeof window.updateUndoButton === 'function') window.updateUndoButton();
            if (typeof window.saveToDisk === 'function') window.saveToDisk();
        }

        // Initialize Manager if needed
        if (!sbManager) sbManager = new SupabaseRealtimeManager(_RT_URL, _RT_KEY);

        currentRoomCode = roomCode;
        const opKeyHash = result.data.operator_key; // Server returns the key
        operatorKey     = opKey;
        operatorKeyHash = opKeyHash;
        isOperator      = true;
        isOnlineSession = true;
        sport           = StateStore.get('sport') || 'Badminton';
        _syncState();
        localStorage.setItem('cs_room_code',    roomCode);
        localStorage.setItem('cs_operator_key', opKey);
        localStorage.setItem('cs_op_key_hash',  operatorKeyHash);
        sbManager.connect(roomCode);
        updateSessionUI();
            window.showLiveSuccessModal(roomCode);
        } else {
            if (typeof closeOverlay === 'function') closeOverlay();
            showSessionToast(`🌐 Live! Room: ${roomCode}`);
        }

        Haptic.success();
        _updatePlayerCount();
    } catch (e) {
        console.error('CourtSide: create failed', e);
        showSyncStatus(e.message || 'Failed to create session. Check connection.', 'error');
        Haptic.error();
    }
}

// ---------------------------------------------------------------------------
// JOIN SESSION
// ---------------------------------------------------------------------------

async function joinOnlineSession(roomCode, initialSession = null) {
    let code = (roomCode || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (code.length === 8) {
        code = code.slice(0, 4) + '-' + code.slice(4);
    }

    if (!code) return;

    // Skip fetch if session data was already provided by PlayerMode.boot
    if (initialSession) {
        currentRoomCode = code;
        isOnlineSession = true;
        sport = initialSession.sport || 'Badminton';
        _syncState();
        if (!sbManager) sbManager = new SupabaseRealtimeManager(_RT_URL, _RT_KEY);
        applyRemoteState(initialSession);
        sbManager.connect(code);
        updateSessionUI();
        return;
    }

    showSyncStatus('Joining…', 'info');
    try {
        const result = await apiCall(`session-get?code=${encodeURIComponent(code)}`);
        if (!result.ok) {
            const msg = result.status === 0 ? 'Network error. Retrying...' : 'Room not found. Check code.';
            showSyncStatus(msg, 'error');
            Haptic.error();
            return;
        }
        // session-get returns { ok, session: {...} }
        const session = result.data?.session || result.data;
        
        if (!session) {
            throw new Error('Invalid session data received from server.');
        }

        const savedCode  = localStorage.getItem('cs_room_code');
        const savedOpKey = localStorage.getItem('cs_operator_key');
        const savedHash  = localStorage.getItem('cs_op_key_hash');
        currentRoomCode = code;
        isOnlineSession = true;
        sport           = session.sport || 'Badminton';
        if (savedCode === code && savedHash && savedHash === session.operator_key) {
            isOperator      = true;
            operatorKey     = savedOpKey;
            operatorKeyHash = savedHash;
            showSessionToast(`✅ Reconnected as host`);
        } else {
            isOperator      = false;
            operatorKey     = null;
            operatorKeyHash = null;
        showSessionToast(`👁 Joined court ${code}`);
        }
        _syncState();

        if (!sbManager) sbManager = new SupabaseRealtimeManager(_RT_URL, _RT_KEY);

        _isBootingSession = true;
        applyRemoteState(session);
        _isBootingSession = false;
        sbManager.connect(code);
        updateSessionUI();
        closeOverlay();
        // Note: refresh() is already triggered inside applyRemoteState -> PlayerMode._onSessionUpdate
        Haptic.success();
    } catch (e) {
        console.error('CourtSide: join failed', e);
        showSyncStatus('Could not join. Try again.', 'error');
        Haptic.error();
    }
}

// ---------------------------------------------------------------------------
// PUSH STATE — heavy sync, debounced
// ---------------------------------------------------------------------------

const _doPushToSupabase = async () => {
    if (!currentRoomCode || !operatorKey) return;

    // Determine which players to sync based on tracking sets
    let squadToSend;
    const syncIsFull = _fullSyncPending || _dirtyIds.size === 0;
    
    if (syncIsFull) {
        squadToSend = StateStore.squad;
    } else {
        // Targeted Sync: only send modified players. 
        // The server-side SMART SQUAD MERGE handles integrating these into the full list.
        const currentDirty = Array.from(_dirtyIds);
        squadToSend = StateStore.squad.filter(p => currentDirty.includes(p.uuid || p.name));
    }

    _fullSyncPending = false;
    _dirtyIds.clear();

    try {
        const res = await apiCall('session-update', {
            method: 'PATCH',
            body: {
                room_code:        currentRoomCode,
                operator_key:     operatorKey,
                sport:            StateStore.get('sport') || 'Badminton',
                squad:            squadToSend,
                is_partial_sync:  !syncIsFull,
                current_matches:  StateStore.currentMatches,
                player_queue:     StateStore.playerQueue,
                uuid_map:         window._sessionUUIDMap  || {},
                court_names:      StateStore.get('courtNames'),
                is_open_party:    StateStore.get('isOpenParty') || false,
                guest_list:       StateStore.get('guestList') || [],
                approved_players: window._approvedPlayers || {},
            },
        });
        
        if (res.ok) {
            localStorage.removeItem('cs_pending_sync');

            // IMMEDIATE GHOST RECOVERY: Verify that the server's final state matches our local state.
            // If they differ, it means a partial sync missed a deletion or a race condition occurred.
            const serverHash = res.data?.hash;
            const localHash = _generateStateHash(StateStore.squad, StateStore.playerQueue);
            if (serverHash && serverHash !== localHash) {
                console.warn('[CourtSide] State drift detected on server. Triggering immediate corrective full sync.');
                _fullSyncPending = true;
                // We bypass the debounce and call _doPushToSupabase directly to heal the state now.
                _doPushToSupabase();
                return; 
            }
            
            const now = new Date();
            const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
            window._lastSyncTime = timeStr;
            
            showSyncStatus(`Saved to cloud at ${timeStr}`, 'success');
            setTimeout(() => {
                const el = document.getElementById('syncStatusMsg');
                if (el && el.textContent.includes('Saved to cloud')) el.style.display = 'none';
            }, 2000);
        }
    } catch (e) { 
        console.error('CourtSide: push failed', e); 
        localStorage.setItem('cs_pending_sync', 'true');
        _fullSyncPending = true; // Fallback to full sync on next attempt to ensure consistency
        showSyncStatus('Sync failed. Retrying...', 'error');
    }
};

const _debouncedPush = window.debounce(_doPushToSupabase, 800);

/**
 * Pushes session state to the cloud. 
 * @param {boolean} force - If true, bypasses the 800ms debounce.
 * @param {Array<string>} targetIds - Optional list of UUIDs or Names for differential sync.
 * If omitted, a full squad sync is performed.
 */
function pushStateToSupabase(force = false, targetIds = null) {
    if (!isOnlineSession || !isOperator) return;

    if (targetIds && Array.isArray(targetIds)) {
        targetIds.forEach(id => _dirtyIds.add(id));
    } else {
        _fullSyncPending = true;
    }

    // OFFLINE GUARD: Queue changes if offline
    if (!navigator.onLine) {
        localStorage.setItem('cs_pending_sync', 'true');
        showSyncStatus('Offline. Changes queued.', 'info');
        return;
    }

    if (force) {
        _debouncedPush.cancel();
        _doPushToSupabase();
    } else {
        _debouncedPush();
    }
}

// ---------------------------------------------------------------------------
// BROADCAST — instant events, no DB write, <100ms delivery
// ---------------------------------------------------------------------------

// Internal: send any broadcast event
function _broadcast(type, payload) {
    if (sbManager) sbManager.broadcast(type, payload);
}
window.broadcastEvent = _broadcast;

/**
 * BUG FIX: Feature #5 - Player self-service break
 * Player broadcasts their status intent (active/resting) to the host.
 */
function broadcastStatusUpdate(playerUUID, isActive) {
    const payload = { playerUUID, isActive };
    if (sbManager && sbManager.socket?.readyState === WebSocket.OPEN) {
        sbManager.broadcast('player_status_update', payload);
    } else {
        // Queue for later if offline
        _pendingActions.push({ type: 'player_status_update', payload });
        if (typeof showSessionToast === 'function') showSessionToast('📡 Offline. Update will sync on reconnect.');
    }
}

/**
 * Player broadcasts their spirit animal update to the host.
 */
function broadcastSpiritAnimalUpdate(playerUUID, emoji) {
    const payload = { playerUUID, emoji };
    if (sbManager && sbManager.socket?.readyState === WebSocket.OPEN) {
        sbManager.broadcast('spirit_animal_update', payload);
    } else {
        // Queue for later if offline
        _pendingActions.push({ type: 'spirit_animal_update', payload });
        if (typeof showSessionToast === 'function') showSessionToast('📡 Offline. Emoji will sync on reconnect.');
    }
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
        courtNames: StateStore.get('courtNames'),
        squad: StateStore.squad,
        current_matches: StateStore.currentMatches,
    });
}

/**
 * Informs the host that a player has auto-joined via Open Party.
 */
function broadcastAutoJoin(playerUUID, playerName) {
    const p = (typeof Passport !== 'undefined') ? Passport.get() : null;
    const animal = p ? p.spiritAnimal : null;
    _broadcast('player_auto_joined', { 
        playerUUID: playerUUID, 
        playerName: playerName, 
        spiritAnimal: animal,
    });
}
window.broadcastAutoJoin = broadcastAutoJoin;

/**
 * BUG 2 FIX — broadcast live game state whenever matches change.
 * Called by saveToDisk hook, setWinner, processAndNext.
 * Players update their live feed immediately without waiting for DB.
 */
let _broadcastThrottleTimer = null;
function broadcastGameState(immediate = false, lastResolvedTS = null) {
    if (!isOperator || !isOnlineSession) return;

    if (!immediate && _broadcastThrottleTimer) return;

    // Helper to calculate "Next Up" names from state instead of DOM
    const getNextUpNames = () => {
        const onCourt = new Set(StateStore.currentMatches.flatMap(m => m.teams.flat()));
        if (typeof pullNextFromQueue === 'function') {
            const next4 = pullNextFromQueue(onCourt);
            if (next4.length === 0) return "";
            if (next4.length <= 2) return next4.map(p => p.name).join(' & ');
            return next4.slice(0, -1).map(p => p.name).join(', ') + ' & ' + next4[next4.length - 1].name;
        }
        return "";
    };

    const doBroadcast = () => {
    // PERFORMANCE: Lightweight Serialization
    // Only send the minimal match data needed for player rendering.
    // Stripping deep stats from the broadcast reduces WebSocket frame size by ~60%.
    const safeMatches = StateStore.currentMatches.map(m => ({
        ...m,
        storyBadges: m.storyBadges,
        teams: m.teams ? [ [...(m.teams[0] || [])], [...(m.teams[1] || [])] ] : [[], []]
    }));

    _broadcast('game_state', {
        type: 'game_state',
        squad: StateStore.squad,
        current_matches: safeMatches,
        player_queue: StateStore.playerQueue,
        courtNames: StateStore.get('courtNames'),
        next_up: getNextUpNames(),
        is_open_party: StateStore.get('isOpenParty') || false,
        hash: _generateStateHash(StateStore.squad, StateStore.playerQueue),
        lastResolvedTS: lastResolvedTS || Date.now()
    });
        _broadcastThrottleTimer = null;
    };

    if (immediate) {
        clearTimeout(_broadcastThrottleTimer);
        doBroadcast();
    } else {
        // 200ms throttle to prevent broadcast storms during rapid UI actions
        _broadcastThrottleTimer = setTimeout(doBroadcast, 200);
    }
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
    if (sbManager) sbManager.broadcast('name_update', { playerUUID, oldName, newName });
}

/**
 * Host pokes a player to get their attention.
 */
function broadcastPoke(playerUUID) {
    if (!isOperator) return;
    _broadcast('player_poke', { playerUUID });
}
window.broadcastPoke = broadcastPoke;

/**
 * Player acknowledges they are heading to the court.
 */
function broadcastAcknowledge(playerUUID) {
    _broadcast('player_ack', { playerUUID });
}

async function broadcastPlayerLeaving(playerUUID, playerName) {
    // Server-Authoritative Leave: Hit the API first to cleanup the squad array
    if (currentRoomCode) {
        fetch('/api/play-request', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ room_code: currentRoomCode, player_uuid: playerUUID, operator_key: 'LEAVE_ACTION' })
        }).catch(() => {});
    }
    if (sbManager) sbManager.broadcast('player_leaving', { playerUUID, playerName });
}
window.broadcastPlayerLeaving = broadcastPlayerLeaving;

function broadcastSessionEnded(recapData) {
    if (!isOperator) return;
    _broadcast('session_ended', { recap: recapData });
}

// ---------------------------------------------------------------------------
// SESSION MEMBERS — DB operations called from app.js
// ---------------------------------------------------------------------------

/**
 * Called by approvePlayRequest() in app.js after adding the player to squad.
 * Flips session_members.status → 'active' via the serverless API.
 * This DB write triggers a Supabase Realtime postgres_changes UPDATE event
 * that the player's phone receives in _handleMemberChange().
 */
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
window.memberApprove = memberApprove;

/**
 * Called by passportRename() in app.js after the player updates their name.
 * Updates session_members.player_name → triggers host realtime listener.
 */
async function memberRename(playerUUID, newName, spiritAnimal = undefined) {
    if (!currentRoomCode || !playerUUID) return;
    try {
        const r = await fetch('/api/member-rename', {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code:   currentRoomCode,
                player_uuid: playerUUID,
                new_name:    newName || null,
                spirit_animal: spiritAnimal
            }),
        });
        if (!r.ok) console.error('[CourtSide] member-rename failed:', r.status);
    } catch (e) { console.error('[CourtSide] member-rename error:', e); }
}

/**
 * Called by PlayerMode.boot() in passport.js.
 * Upserts a session_members row (pending if new, preserves active if returning).
 * Returns { status: 'pending' | 'active', member } — caller uses this
 * to decide whether to bypass the pending screen.
 */
async function memberUpsert(playerUUID, playerName, explicitRoomCode) {
    const p = (typeof Passport !== 'undefined') ? Passport.get() : null;
    const emoji = (p && p.playerUUID === playerUUID) ? p.spiritAnimal : null;

    // Prefer the explicitly-passed room code (always available in player mode boot)
    // before falling back to the module-level variable or window global.
    // The module-level currentRoomCode may not be set yet if joinOnlineSession()
    // is still in-flight when this is called from PlayerMode.boot().
    let roomCode = explicitRoomCode || currentRoomCode || window.currentRoomCode || null;
    if (roomCode) {
        roomCode = roomCode.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (roomCode.length === 8) roomCode = roomCode.slice(0, 4) + '-' + roomCode.slice(4);
    }
    currentRoomCode        = roomCode; // keep local var in sync
    _syncState();
    try {
        const r = await fetch('/api/member-upsert', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code:   roomCode,
                player_uuid: playerUUID,
                player_name: playerName,
                spirit_animal: emoji
            }),
        });
        if (!r.ok) { console.error('[CourtSide] member-upsert failed:', r.status); return null; }
        return await r.json();  // { ok, status, member }
    } catch (e) { console.error('[CourtSide] member-upsert error:', e); return null; }
}

// ---------------------------------------------------------------------------
// HANDLE INCOMING BROADCAST EVENTS
// ---------------------------------------------------------------------------

function _handleBroadcast(payload) {
    const { type } = payload;

    // Immediate play request notification for Host
    if (type === 'incoming_play_request') {
        if (isOperator && typeof window.onPlayRequestInsert === 'function') {
            window.onPlayRequestInsert(payload);
        }
        return;
    }

    // BUG 1: Player approved — flip from pending → active
    if (type === 'session_joined') {
        if (!isOperator && typeof PlayerMode !== 'undefined') {
            PlayerMode._onApprovalReceived(payload);
        }
        return;
    }

    // Player auto-joined (Open Party): Host reconciles them immediately
    if (type === 'player_auto_joined') {
        if (isOperator && typeof window.handleAutoJoin === 'function') {
            window.handleAutoJoin(payload.playerName, payload.playerUUID, payload.spiritAnimal);
        }
        return;
    }

    // Host pokes player: Player triggers haptics and alert
    if (type === 'player_poke') {
        const p = (typeof Passport !== 'undefined') ? Passport.get() : null;
        if (!isOperator && p && payload.playerUUID === p.playerUUID) {
            if (window.Haptic) {
                Haptic.success(); // Stronger vibration pattern
                setTimeout(() => Haptic.success(), 300);
            }
            showSessionToast('⚡ THE HOST IS CALLING YOU!');
            const banner = document.getElementById('_csYoureUpBanner');
            if (banner) banner.style.background = 'linear-gradient(135deg, #ff3b5c, #ef4444)';
        }
        return;
    }

    // Player acknowledges: Host updates UI
    if (type === 'player_ack') {
        if (isOperator) {
            const p = StateStore.squad.find(x => x.uuid === payload.playerUUID);
            if (p && !p.acknowledged) {
                p.acknowledged = true;
                const hasChanged = StateStore.set('squad', [...StateStore.squad]);
                if (hasChanged) renderSquad();
                if (typeof broadcastGameState === 'function') broadcastGameState(true);
                showSessionToast(`👍 ${p.name} is on the way`);
            }
        }
        return;
    }

    // Player removed by host — update removed player's screen immediately
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

    // Player is leaving the session
    if (type === 'player_leaving') {
        if (isOperator && typeof window.removePlayerFromSession === 'function') {
            window.removePlayerFromSession(payload.playerUUID, payload.playerName);
        }
        return;
    }

    // Session has ended, show recap to players
    if (type === 'session_ended') {
        if (!isOperator && typeof PlayerMode !== 'undefined') {
            PlayerMode._onSessionEnded(payload.recap);
        }
        return;
    }

    // BUG 2: Live game state — update player feed immediately.
    // STRICT RULE: assign window.currentMatches directly from the payload.
    // Never sort, re-order, or infer team assignment on the player side.
    // teams[0] is always Team A, teams[1] is always Team B — exactly as
    // the host stored them.
    if (type === 'game_state') {
        if (!isOperator) {
            // Use StateStore to update global state and detect actual data changes
            const hasChanged = StateStore.setState({
                squad: payload.squad || [],
                currentMatches: payload.current_matches || [],
                playerQueue: payload.player_queue || [],
                courtNames: payload.courtNames || {},
                isOpenParty: payload.is_open_party || false
            });

            // Sync legacy window globals for compatibility with player-view.js logic
            window.squad          = StateStore.squad;
            window.currentMatches = StateStore.currentMatches;
            window.playerQueue    = StateStore.playerQueue;
            window.courtNames     = StateStore.get('courtNames');
            window._isOpenParty   = StateStore.get('isOpenParty');
            window._lastNextUp    = payload.next_up;

            // PERFORMANCE: Bail if state is identical to avoid redundant heavy UI refresh
            if (!hasChanged && !_isBootingSession) return;

            if (typeof PlayerMode !== 'undefined') {
                PlayerMode._onGameStateUpdate(payload);
            } else if (typeof SidelineView !== 'undefined') {
                SidelineView.refresh();
            }
            if (typeof updateIWTPVisibility === 'function') updateIWTPVisibility();
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

    // Feature #4: Spirit animal update — host applies the change
    if (type === 'spirit_animal_update') {
        if (isOperator) {
            _applySpiritAnimalUpdate(payload.playerUUID, payload.emoji);
        }
        return;
    }

    // Feature #5: Status update — host applies the change
    if (type === 'player_status_update') {
        if (isOperator) {
            _applyStatusUpdate(payload.playerUUID, payload.isActive);
        }
        return;
    }
}

// Host applies a name change broadcast from a player
// Issue #3 FIX: UUID-first lookup so name changes survive previous renames.
// squad member has .uuid stored at approval time — that never changes.
function _applyNameUpdate(playerUUID, oldName, newName) {
    if (!newName?.trim() || !playerUUID) return;
    let trimmed = newName.trim();

    let pIdx = StateStore.squad.findIndex(p => p.uuid === playerUUID);
    if (pIdx === -1) pIdx = StateStore.squad.findIndex(p => p.name === oldName && !p.uuid);

    if (pIdx === -1) {
        // If player is pending (not in squad yet), update the local playRequests cache
        // so the Join Notification UI shows the new name immediately.
        if (typeof window.playRequests !== 'undefined') {
            const req = window.playRequests.find(r => r.player_uuid === playerUUID || r.name === oldName);
            if (req) {
                req.name = trimmed;
                if (typeof window.updatePendingRequestUI === 'function') {
                    window.updatePendingRequestUI(playerUUID, trimmed, null);
                }
            }
        }
        return;
    }

    // 3. Collision Protection: If the new name is already taken by someone else
    const collision = StateStore.squad.find(p => 
        p.uuid !== playerUUID && 
        p.name.toLowerCase() === trimmed.toLowerCase()
    );

    if (collision) {
        let counter = 1;
        let finalName = `${trimmed} (${counter})`;
        while (StateStore.squad.find(p => p.name.toLowerCase() === finalName.toLowerCase())) {
            counter++;
            finalName = `${trimmed} (${counter})`;
        }
        trimmed = finalName;
    }

    const player = StateStore.squad[pIdx];
    if (player.name === trimmed) return;

    const prevName = player.name;
    const newSquad = [...StateStore.squad];
    newSquad[pIdx] = { ...player, name: trimmed, uuid: playerUUID };

    // Update uuid_map: rename the key, ensure new key exists
    const uuidMap = window._sessionUUIDMap || {};
    // Remove old name key if it points to this UUID
    if (uuidMap[prevName]) delete uuidMap[prevName];
    if (oldName && uuidMap[oldName]) delete uuidMap[oldName];
    // Always write new name key
    uuidMap[trimmed] = playerUUID;
    window._sessionUUIDMap = uuidMap;

    // KEY FIX: Update name in approved players list (used for DB push)
    if (window._approvedPlayers) {
        const entry = window._approvedPlayers[playerUUID] || window._approvedPlayers[prevName];
        if (entry) {
            entry.name = trimmed;
        }
    }

    const hasChanged = StateStore.set('squad', newSquad);
    if (hasChanged) {
        renderSquad();
        rebuildMatchCardIndices();
        if (typeof renderQueueStrip === 'function') renderQueueStrip();
        if (typeof broadcastGameState === 'function') broadcastGameState(true);
        showSessionToast(`✏️ ${prevName} → ${trimmed}`);
    }
}

window._applyNameUpdate = _applyNameUpdate;
window._generateStateHash = _generateStateHash;

// Host applies a spirit animal update broadcast from a player
function _applySpiritAnimalUpdate(playerUUID, emoji) {
    const pIdx = StateStore.squad.findIndex(p => p.uuid === playerUUID);

    if (pIdx === -1) {
        // If player is pending (not in squad yet), update the local playRequests cache
        if (typeof window.playRequests !== 'undefined') {
            const req = window.playRequests.find(r => r.player_uuid === playerUUID);
            if (req) {
                req.spirit_animal = emoji;
                if (typeof window.updatePendingRequestUI === 'function') {
                    window.updatePendingRequestUI(playerUUID, null, emoji);
                }
            }
        }
        return;
    }

    const player = StateStore.squad[pIdx];
    if (player.spiritAnimal === emoji) return;

    const newSquad = [...StateStore.squad];
    newSquad[pIdx] = { ...player, spiritAnimal: emoji };

    const hasChanged = StateStore.set('squad', newSquad);
    if (hasChanged) {
        renderSquad();
        if (typeof broadcastGameState === 'function') broadcastGameState(true);
    }
}

// Host applies a status change broadcast from a player
function _applyStatusUpdate(playerUUID, isActive) {
    const pIdx = StateStore.squad.findIndex(p => p.uuid === playerUUID);
    if (pIdx === -1) return;

    const player = StateStore.squad[pIdx];
    if (player.active === !!isActive) return;

    const newSquad = [...StateStore.squad];
    newSquad[pIdx] = { ...player, active: !!isActive };

    const hasChanged = StateStore.set('squad', newSquad);
    if (hasChanged) {
        renderSquad();
        checkNextButtonState();
        if (typeof broadcastGameState === 'function') broadcastGameState(true);

        const sIcon = (window.SPORT_ICONS ? window.SPORT_ICONS[window.sport || 'Badminton'] : null) || '🏸';
        showSessionToast(`${player.name} is now ${isActive ? `Ready ${sIcon}` : 'Resting ☕'}`);
    }
}

// ---------------------------------------------------------------------------
// HANDLER FOR POSTGRES CHANGES (Called by Manager)
// ---------------------------------------------------------------------------

function _handlePostgresChange(payload) {
    const table  = payload?.table || payload?.data?.table;
    const type   = payload?.eventType || payload?.type || payload?.data?.type;
    
    // Support both record/old_record and new/old formats for different Realtime versions
    const record = payload?.new || payload?.data?.record || payload?.record;
    const old    = payload?.old || payload?.data?.old_record || payload?.old_record;

    if (table === 'session_members' || payload?.data?.table === 'session_members') {
        if (type === 'DELETE' && old) _handleMemberChange(old, null, type);
        else if (record) _handleMemberChange(record, old, type);
        return;
    }

    if (table === 'play_requests' || payload?.data?.table === 'play_requests') {
        if (isOperator && record && typeof window.onPlayRequestInsert === 'function') {
            console.log('[CourtSide] Realtime: New play request received', record);
            window.onPlayRequestInsert(record);
        }
        return;
    }

    if (table === 'passport_signals' || payload?.data?.table === 'passport_signals') {
        if (!isOperator && record && typeof PlayerMode !== 'undefined') {
            const passport = (typeof Passport !== 'undefined') ? Passport.get() : null;
            if (passport && record.player_uuid === passport.playerUUID) {
                // Trigger the same logic as the old polling loop
                if (typeof handlePassportSignal === 'function') {
                    handlePassportSignal(record, passport);
                }
            }
        }
        return;
    }

    if (table === 'players' || payload?.data?.table === 'players') {
        if (typeof SidelineView !== 'undefined' && SidelineView._visible) SidelineView.refresh();
        return;
    }

    if (!isOperator && record) applyRemoteState(record);
}

// ---------------------------------------------------------------------------
// APPLY REMOTE STATE — globals FIRST, then render
// ---------------------------------------------------------------------------

let _lastRemoteUpdate = 0;

function applyRemoteState(session) {
    // The host is the source of truth during an active session. When their own
    // DB write bounces back via postgres_changes, applying it wipes and
    // re-renders the match container mid-game, causing the "Start Session" flash.
    // Reconciliation: Host adopts new players/queue updates from server (Open Party).
    if (isOperator && !_isBootingSession) {
        if (Array.isArray(session.squad)) {
            let hasChanges = false;
            let newSquad = [...StateStore.squad];

            session.squad.forEach(remoteP => {
                if (!remoteP.uuid) return;
                const localPIdx = newSquad.findIndex(p => p.uuid === remoteP.uuid);
                if (localPIdx === -1) {
                    newSquad.push(remoteP);
                    hasChanges = true;
                    return;
                }

                const localP = newSquad[localPIdx];
                let updatedP = { ...localP };
                let pChanged = false;

                // Reconcile metadata
                if (remoteP.name && remoteP.name !== updatedP.name) { updatedP.name = remoteP.name; pChanged = true; }
                if (remoteP.spiritAnimal && remoteP.spiritAnimal !== updatedP.spiritAnimal) { updatedP.spiritAnimal = remoteP.spiritAnimal; pChanged = true; }

                    // Reconcile achievements
                    const localSet = new Set(updatedP.achievements || []);
                    if (Array.isArray(remoteP.achievements)) {
                        remoteP.achievements.forEach(a => { if (!localSet.has(a)) { localSet.add(a); pChanged = true; } });
                    }
                    if (pChanged) updatedP.achievements = Array.from(localSet);

                    // Deep Stats Merge
                    const merge = (l, r) => { const res = { ...(r || {}) }; for (const [id, count] of Object.entries(l || {})) { res[id] = Math.max(res[id] || 0, count); } return res; };
                    updatedP.teammateHistory = merge(updatedP.teammateHistory, remoteP.teammateHistory);
                    updatedP.opponentHistory = merge(updatedP.opponentHistory, remoteP.opponentHistory);
                    
                    // Reconcile match history
                    const incomingH = remoteP.matchHistory || [];
                    const currentH  = updatedP.matchHistory || [];
                    const hMap = new Map();
                    currentH.forEach(m => m.time && hMap.set(m.time, m));
                    incomingH.forEach(m => m.time && hMap.set(m.time, m));
                    updatedP.matchHistory = Array.from(hMap.values()).sort((a, b) => b.time - a.time);

                    if (pChanged || updatedP.matchHistory.length !== currentH.length) {
                        newSquad[localPIdx] = updatedP;
                        hasChanges = true;
                    }
            });

            // Adopt Server Queue Order: Authoritative sync for Open Party joins/leaves
            if (session.player_queue && JSON.stringify(session.player_queue) !== JSON.stringify(StateStore.playerQueue)) {
                StateStore.set('playerQueue', session.player_queue);
                hasChanges = true;
            }
            if (hasChanges) {
                StateStore.set('squad', newSquad);
                renderSquad();
                if (typeof renderQueueStrip === 'function') renderQueueStrip();
                
                // SNAPPINESS: Force an immediate broadcast so all spectators see the new joiner instantly
                if (typeof broadcastGameState === 'function') broadcastGameState(true);
            }
        }
        _updatePlayerCount();
        return;
    }

    const ts = session.last_active ? new Date(session.last_active).getTime() : 0;
    if (ts > 0 && ts < _lastRemoteUpdate) {
        console.log('CourtSide: ignoring stale remote update');
        return;
    }
    _lastRemoteUpdate = ts || Date.now();
    const prevCount = StateStore.currentMatches.length;

    // Globals FIRST — no render reads stale data
    const loadedSquad = (session.squad || []).filter(p => p && typeof p === 'object');
    const loadedMatches = (session.current_matches || []).map(m => {
        // Ensure teams is strictly an array of two arrays to prevent rendering crashes
        const rawTeams = Array.isArray(m.teams) ? m.teams : [];
        return {
            ...m,
            teams: [
                Array.isArray(rawTeams[0]) ? rawTeams[0] : [],
                Array.isArray(rawTeams[1]) ? rawTeams[1] : []
            ]
        };
    });
    const loadedQueue = (session.player_queue || []).filter(id => 
        // Allow lookup by UUID or Name during hydration to prevent queue loss
        loadedSquad.find(p => p.uuid === id || p.name.toLowerCase() === String(id).toLowerCase())
    );
    const loadedCourtNames = session.court_names || session.data?.court_names || {};
    let loadedCourts = StateStore.get('activeCourts') || 1;
    if (Number.isInteger(session.active_courts) && session.active_courts >= 1) {
        loadedCourts = session.active_courts;
        setTimeout(() => {
            const courtInput = document.getElementById('courtCountInput');
            if (courtInput) courtInput.value = loadedCourts;
        }, 0);
    }

    const hasChanged = StateStore.setState({ 
        squad: loadedSquad, 
        currentMatches: loadedMatches, 
        playerQueue: loadedQueue, 
        activeCourts: loadedCourts, 
        courtNames: loadedCourtNames,
        isOpenParty: session.is_open_party || false,
        sport: session.sport || 'Badminton',
        guestList: session.guest_list || []
    });
    // Also update window globals for player view, which doesn't use StateStore
    if (!isOperator) {
        window.squad = loadedSquad;
        window.currentMatches = loadedMatches;
        window.playerQueue = loadedQueue;
        window.courtNames = loadedCourtNames;
        window.sport = session.sport || 'Badminton';
        window._isOpenParty = session.is_open_party || false;
    }

    // PERFORMANCE: If state is identical to local cache, skip expensive DOM rendering
    if (!hasChanged && !isOperator && !_isBootingSession) return;

    // round_history is no longer synced to DB — keep local undo history intact
    // roundHistory stays as-is on rejoin

    // Migrate: remote squad rows may come from an older client that had legacy
    // fields like skillLevel or rating. migratePlayer() is defined in app.js
    // and purges these fields to ensure the local state remains clean.
    if (typeof migratePlayer === 'function') StateStore.squad.forEach(migratePlayer);
    window._sessionUUIDMap  = session.uuid_map         || {};
    window._approvedPlayers = session.approved_players || {};

    if (!isOperator) {
        // Ensure the player view is active and visible if matches are available
        if (typeof SidelineView !== 'undefined' && !SidelineView._visible) {
            SidelineView.show();
        }

        if (typeof SidelineView !== 'undefined') {
            SidelineView._lastUpdateTS = Date.now();
        }

        if (typeof PlayerMode !== 'undefined') {
            PlayerMode._onSessionUpdate(session);
        } else if (typeof SidelineView !== 'undefined') {
            SidelineView.refresh();
        }
    } else {
        // Host boot/rejoin hydration — restore full UI from DB state
        renderSquad();
        rebuildMatchCardIndices();
        if (typeof renderQueueStrip === 'function') renderQueueStrip();
        checkNextButtonState();
        updateUndoButton();
        if (typeof checkIWTPSmartRecognition === 'function') checkIWTPSmartRecognition();
        if (typeof renderOpenPartyToggle === 'function') renderOpenPartyToggle();
    }
    if (StateStore.currentMatches.length > 0 && StateStore.currentMatches.length !== prevCount) Haptic.bump();
    _updatePlayerCount();
}

// ---------------------------------------------------------------------------
// SESSION MEMBERS — realtime change handler
// Called for ANY postgres_changes event on session_members for this room.
// ---------------------------------------------------------------------------

function _handleMemberChange(record, oldRecord, eventType) {
    if (!record) return;

    const uuid = record.player_uuid;
    const name = record.player_name;

    // ── HOST: member roster update ─────────────────────────────────────────
    // Update _sessionMembers cache, then refresh squad names + notification badge.
    if (isOperator) {
        if (eventType === 'INSERT') {
            // New pending member — add to cache
            window._sessionMembers[uuid] = record;
            
            // If status is active (Auto-join), resolve them into the squad immediately
            if (record.status === 'active' && typeof window.handleAutoJoin === 'function') {
                window.handleAutoJoin(
                    name, 
                    uuid, 
                    record.spirit_animal || null
                );
            }

        } else if (eventType === 'UPDATE') {
            const prev = window._sessionMembers[uuid] || {};
            window._sessionMembers[uuid] = record;

            // Name change? Update squad in-memory and re-render.
            if (prev.player_name && name && prev.player_name !== name) {
                // Delegate to _applyNameUpdate which handles uuid_map + squad + render
                _applyNameUpdate(uuid, prev.player_name, name);
            }

            // Activation via server upsert (Edge function re-entry path)
            if (record.status === 'active' && prev.status !== 'active') {
                if (typeof _applyStatusUpdate === 'function') {
                    _applyStatusUpdate(uuid, true);
                }
            }
        } else if (eventType === 'DELETE') {
            delete window._sessionMembers[uuid];
        }

        // Refresh count after any host-side member change
        _updatePlayerCount();
        return;
    }

    // ── PLAYER: own-row status change ──────────────────────────────────────
    // Check if this record belongs to THIS player's passport.
    const passport = (typeof Passport !== 'undefined') ? Passport.get() : null;
    if (!passport || uuid !== passport.playerUUID) return;

    if (record.status === 'active') {
        if (typeof PlayerMode !== 'undefined') PlayerMode._onMemberActivated(record);
    } else if (eventType === 'DELETE') {
        // Host removed or reset this player
        if (typeof PlayerMode !== 'undefined' && typeof PlayerMode._onRemovedFromSession === 'function') {
            PlayerMode._onRemovedFromSession();
        }
    }

    _updatePlayerCount();
}

// ---------------------------------------------------------------------------
// PLAYER COUNT — live badge inside the session pill
// ---------------------------------------------------------------------------

/**
 * Recomputes and displays the active player count in the session badge.
 *
 * Source of truth priority:
 *   1. window._sessionMembers  — realtime DB cache, updated by _handleMemberChange()
 *                                on every INSERT / UPDATE / DELETE to session_members.
 *                                "Active" = status === 'active' (host-approved players only).
 *   2. squad array             — local fallback when _sessionMembers is empty
 *                                (offline / host-only mode before any realtime events).
 *
 * Badge layout after this runs:
 *   [dot]  [ABCD-1234]  [3 🟢]  [HOST]
 */
function _updatePlayerCount() {
    const badge = document.getElementById('sessionBadge');
    if (!badge || !isOnlineSession) return;

    const members       = window._sessionMembers || {};
    const memberEntries = Object.values(members);

    let count;
    if (memberEntries.length > 0) {
        // DB-driven: only count approved (active) members
        count = memberEntries.filter(m => m.status === 'active').length;
    } else {
        // Fallback: use local squad length (always accurate on the host side)
        count = (typeof StateStore.squad !== 'undefined' ? StateStore.squad.filter(p => p.active).length : 0);
    }

    let countEl = document.getElementById('sessionPlayerCount');
    const prevCount = countEl ? parseInt(countEl.dataset.prevCount || '-1', 10) : -1;

    if (!countEl) {
        countEl = document.createElement('span');
        countEl.id        = 'sessionPlayerCount';
        countEl.className = 'session-player-count';
        // Insert before the role label so layout is: dot · code · count · role
        const roleEl = badge.querySelector('.session-role');
        if (roleEl) badge.insertBefore(countEl, roleEl);
        else badge.appendChild(countEl);
    }

    countEl.textContent       = `${count} 🟢`;
    countEl.dataset.prevCount = count;
    countEl.title             = `${count} active player${count !== 1 ? 's' : ''} in session`;

    // Pop animation whenever the number changes (join or leave)
    if (count !== prevCount && prevCount !== -1) {
        countEl.classList.remove('count-updated');
        void countEl.offsetWidth; // force reflow so re-adding class restarts animation
        countEl.classList.add('count-updated');
           // War Room FOMO Ticker
        const wrTicker = document.getElementById('wrTicker');
        if (wrTicker) {
            wrTicker.classList.remove('glow-bounce');
            void wrTicker.offsetWidth;
            wrTicker.classList.add('glow-bounce');
            wrTicker.textContent = `${count} PARTICIPANTS`;
        }
        countEl.addEventListener('animationend', () => {
            countEl.classList.remove('count-updated');
        }, { once: true });
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
    _syncState();
    if (sbManager) sbManager.disconnect();
    localStorage.removeItem('cs_room_code');
    localStorage.removeItem('cs_operator_key');
    localStorage.removeItem('cs_op_key_hash');
    localStorage.removeItem('cs_pending_sync');
    _pendingActions = [];
    _dirtyIds.clear();
    window._sessionMembers = {}; // Reset member cache to prevent memory leak
    updateSessionUI();
}

function showReconnectingIndicator(show, text = '⟳ Reconnecting…') {
    let el = document.getElementById('reconnectIndicator');
    if (!el) {
        el = document.createElement('div');
        el.id = 'reconnectIndicator';
        el.className = 'reconnect-indicator';
        document.body.appendChild(el);
    }
    el.textContent = text;
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
        <span class="session-code" style="cursor:pointer;" onclick="copyInviteLink()" title="Tap to share invite">${currentRoomCode} 🔗</span>
        <span class="session-role">${isOperator ? 'HOST' : 'LIVE'}</span>
    `;
    if (!isOperator) document.body.classList.add('spectator-mode');
    else document.body.classList.remove('spectator-mode');

    // Inject the count pill immediately after rebuilding badge innerHTML
    _updatePlayerCount();
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

// Hook saveToDisk: push state to DB (debounced). Does NOT broadcast —
// broadcastGameState() is called explicitly by processAndNext() and setWinner()
// in logic.js AFTER the new round state is fully built, so players always
// receive one clean broadcast with the correct final state, not intermediate ones.
const _originalSaveToDisk = saveToDisk;
saveToDisk = function () {
    _originalSaveToDisk();
    if (isOnlineSession && isOperator) {
        pushStateToSupabase();  // debounced 800ms — DB sync only
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
        // In player mode, PlayerMode.boot() (triggered by window.onload) owns the
        // full join flow. We must NOT call joinOnlineSession here because it would
        // race with boot(), call applyRemoteState() with _joinCode=null, and
        // overwrite the sideline view before boot() has set PlayerMode._joinCode.
        // Instead, just pre-seed the room code so memberUpsert() has it available.
        if (role === 'player') {
            currentRoomCode        = joinCode;
            window.currentRoomCode = joinCode;
            // Save joinCode to window so window.onload can read it even after URL is cleaned
            window._pendingJoinCode = joinCode;
            _syncState();
            // Strip ?join= but preserve ?role= so window.onload can still see it
            const cleanUrl = window.location.origin + window.location.pathname + '?role=player';
            window.history.replaceState({}, document.title, cleanUrl);
            return;
        }
        // Host/spectator mode: do the full join
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
            // FIX: Only wipe if the session is confirmed GONE (404).
            // If it's a network error (status 0) or server error (500), 
            // we keep the credentials and will try to reconnect via the online listener.
            if (result.status === 404) {
                localStorage.removeItem('cs_room_code');
                localStorage.removeItem('cs_operator_key');
                localStorage.removeItem('cs_op_key_hash');
                
                // PROACTIVE CLEANUP: Clear session-specific stale data from local vault
                const saved = localStorage.getItem('cs_pro_vault');
                if (saved) {
                    const data = JSON.parse(saved);
                    data.currentMatches = [];
                    data.roundHistory = [];
                    data.guestList = []; // Clear guests to prevent stale data in next session
                    localStorage.setItem('cs_pro_vault', JSON.stringify(data));
                }
            }
            return;
        }
        const session = result.data?.session || result.data;
        currentRoomCode = savedCode;
        isOnlineSession = true;
        const savedHash = localStorage.getItem('cs_op_key_hash');
        if (savedHash && savedHash === session.operator_key) {
            isOperator      = true;
            operatorKey     = localStorage.getItem('cs_operator_key');
            operatorKeyHash = savedHash;
            sport           = session.sport || 'Badminton';
        } else {
            isOperator = false;
            sport      = session.sport || 'Badminton';
        }
        _syncState();

        // CONFLICT RESOLUTION:
        // Enhanced strategy: Check if local state has unsaved changes.
        const hasPending = localStorage.getItem('cs_pending_sync') === 'true';
        
        _isBootingSession = true;
        if (isOperator && hasPending) {
            // Conflict! Prompt host.
            UIManager.confirm({
                title: 'Sync Conflict',
                message: 'You have unsaved local changes from a previous connection. Keep local state or load from server?',
                confirmText: 'Keep Local',
                onConfirm: () => {
                    console.log('[CourtSide] Host choosing local state.');
                    pushStateToSupabase();
                    _finalizeRejoin(savedCode);
                },
                onCancel: () => {
                    console.log('[CourtSide] Host choosing server state.');
                    applyRemoteState(session);
                    localStorage.removeItem('cs_pending_sync');
                    _finalizeRejoin(savedCode);
                }
            });
        } else {
            applyRemoteState(session);
            _finalizeRejoin(savedCode);
        }
    } catch { /* silently stay offline */ }
}

function _finalizeRejoin(savedCode) {
    _isBootingSession = false;
    if (!sbManager) sbManager = new SupabaseRealtimeManager(_RT_URL, _RT_KEY);
    sbManager.connect(savedCode);
    updateSessionUI();
    showSessionToast(isOperator ? `✅ Reconnected as host` : `👁 Rejoined session`);
}

// ---------------------------------------------------------------------------
// CONNECTION MONITORING
// ---------------------------------------------------------------------------

window.addEventListener('online', () => {
    // If we are host and have queued changes, sync immediately
    if (isOnlineSession && isOperator && localStorage.getItem('cs_pending_sync') === 'true') {
        showSyncStatus('Syncing...', 'info');
        pushStateToSupabase();
    } else if (isOnlineSession && isOperator) {
        // Host: provide visual feedback that connection is restored
        showSyncStatus('Connection Restored', 'success');
        pushStateToSupabase();
    } else if (!isOnlineSession && localStorage.getItem('cs_room_code')) {
        tryAutoRejoin();
    }
    
    // Refresh UI state for spectators/players when network returns
    if (isOnlineSession && !isOperator && typeof SidelineView !== 'undefined') {
        SidelineView._performRefresh(true);
    }
});

window.addEventListener('offline', () => {
    if (isOnlineSession && isOperator) {
        showSyncStatus('Offline Mode', 'error');
        // Show the same reconnecting indicator as players for consistency
        if (typeof showReconnectingIndicator === 'function') showReconnectingIndicator(true, '📡 Offline...');
    }
});

// Visibility change handler for mobile sleep/wake cycles
document.addEventListener('visibilitychange', () => {
    const isVisible = document.visibilityState === 'visible';
    if (isVisible) {
        const now = Date.now();
        const wasAwayLong = (window._lastVisibilityHiddenAt && (now - window._lastVisibilityHiddenAt > 30000));
        if (!isOnlineSession) return;
        // If socket is stale or dead, reconnect immediately
        if (!sbManager || !sbManager.socket || sbManager.socket.readyState !== WebSocket.OPEN) {
            console.log('[CourtSide] Tab resumed, reconnecting socket...');
            if (sbManager) sbManager.connect(currentRoomCode);
         } else if ((wasAwayLong || !isOperator) && typeof SidelineView !== 'undefined') {
            // Force a refresh if we were away for a while or if we are a spectator
            SidelineView._performRefresh(true);
        }
         } else {
        window._lastVisibilityHiddenAt = Date.now();
    }
});

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
    if (isOnlineSession && isOperator && typeof window._startPolling === 'function') window._startPolling();
};

// ---------------------------------------------------------------------------
// MATCH HISTORY ARCHIVAL
// ---------------------------------------------------------------------------

async function archiveRoundToSupabase(snapshot) {
    if (!currentRoomCode || !isOperator) return;
    
    // Cleanup matches: remove deprecated 'odds' field before archival
    const cleanMatches = (snapshot.matches || []).map(m => {
        const { odds, ...rest } = m;
        return rest;
    });

    // USE apiCall for retries and resilience on critical data archival
    const res = await apiCall('match-history', {
        method: 'POST',
        body: {
                type: 'match_result',
                room_code: currentRoomCode,
                operator_key: operatorKey,
                timestamp: snapshot.timestamp,
                matches:   cleanMatches,
                achievements: snapshot.achievements || [],
                squad:     snapshot.squadSnapshot || [],
        }
    }, 3); // 3 retries for match history

    if (!res.ok) console.error('[CourtSide] Failed to archive round after retries');
}

// ---------------------------------------------------------------------------
// UI: LATENCY METER
// ---------------------------------------------------------------------------

function _updateLatencyDisplay(ms) {
    let el = document.getElementById('sessionLatency');
    if (!el) {
        const badge = document.getElementById('sessionBadge');
        if (!badge) return;
        el = document.createElement('span');
        el.id = 'sessionLatency';
        el.style.fontSize = '0.55rem';
        el.style.marginLeft = '6px';
        el.style.opacity = '0.8';
        el.style.fontFamily = 'monospace';
        el.style.fontWeight = '700';
        badge.appendChild(el);
    }
    
    let color = '#4ade80'; // Green
    if (ms > 150) color = '#facc15'; // Yellow
    if (ms > 400) color = '#ef4444'; // Red
    
    el.style.color = color;
    
    // Signal icon + value
    const icon = ms < 150 ? '📶' : (ms < 400 ? '⚠️' : '❗');
    const opacity = ms < 150 ? '1' : (ms < 400 ? '0.7' : '0.4');
    el.innerHTML = `<span style="opacity:${opacity}; margin-right:2px;">${icon}</span>${ms}ms`;
}

/**
 * Constructs and shares/copies the player invite link.
 * @param {string} explicitCode - Optional room code to use.
 */
async function copyInviteLink(explicitCode = null) {
    const roomCode = explicitCode || currentRoomCode || window.currentRoomCode;
    if (!roomCode) return;
    const url = window.location.origin + window.location.pathname + '?join=' + roomCode + '&role=player';
    
    const shareData = {
        title: 'CourtSide Pro Session',
        text: `Check-in to our badminton session early! Room Code: ${roomCode}`,
        url: url
    };

    // Use native share sheet if available
    if (navigator.share && navigator.canShare && navigator.canShare(shareData)) {
        try {
            await navigator.share(shareData);
            return;
        } catch (e) {
            if (e.name !== 'AbortError') console.error('Share failed', e);
        }
    }

    // Fallback to clipboard
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url)
            .then(() => showSessionToast('🔗 Invite link copied!'))
            .catch(() => typeof fallbackCopy === 'function' && fallbackCopy(url, '🔗 Invite link copied!'));
    } else {
        if (typeof fallbackCopy === 'function') fallbackCopy(url, '🔗 Invite link copied!');
    }
}
window.copyInviteLink = copyInviteLink;

/**
 * Helper for the player-view "Invite to Court" button.
 * Maintains compatibility with existing onclick handlers.
 */
const InviteQR = {
    show(code) {
        if (typeof copyInviteLink === 'function') {
            copyInviteLink(code);
        }
    }
};
window.InviteQR = InviteQR;