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
let sbManager         = null; // Instance of SupabaseRealtimeManager
let syncDebounceTimer = null;
let _isBootingSession = false; // true only during initial rejoin hydration

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
}

// session_members realtime state
// Key: player_uuid → { player_uuid, player_name, status, room_code }
window._sessionMembers = {};

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
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        this.socket.send(JSON.stringify({
            topic:   `realtime:courtside-${this.roomCode}`,
            event:   'broadcast',
            payload: { type, ...payload },
            ref:     String(Date.now()),
        }));
    }

    _onOpen() {
        this.reconnectAttempts = 0;
        showReconnectingIndicator(false);
        const roomCode = this.roomCode;

        // Helper to send Phx Join messages
        const join = (topic, payload) => {
            this.socket.send(JSON.stringify({ topic, event: 'phx_join', payload, ref: '1' }));
        };

        // 1. Sessions (postgres_changes)
        join('realtime:public:sessions', {
            config: {
                broadcast: { self: false },
                presence: { key: '' },
                postgres_changes: [{ event: 'UPDATE', schema: 'public', table: 'sessions', filter: `room_code=eq.${roomCode}` }]
            }
        });

        // 2. Broadcast channel
        join(`realtime:courtside-${roomCode}`, { config: { broadcast: { self: false } } });

        // 3. Members
        join('realtime:public:session_members', {
            config: {
                broadcast: { self: false },
                presence: { key: '' },
                postgres_changes: [{ event: '*', schema: 'public', table: 'session_members', filter: `room_code=eq.${roomCode}` }]
            }
        });

        // 4. Play Requests (Host only)
        if (isOperator) {
            join('realtime:public:play_requests', {
                config: {
                    broadcast: { self: false },
                    presence: { key: '' },
                    postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'play_requests', filter: `room_code=eq.${roomCode}` }]
                }
            });
        }

        this._startHeartbeat();
    }

    _onMessage(msg) {
        try {
            const data = JSON.parse(msg.data);
            
            // Latency measurement (Reply to our client-side heartbeat)
            if (data.event === 'phx_reply' && data.ref && this.pendingHeartbeats.has(data.ref)) {
                this._measureLatency(data.ref);
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

    _onError() { showReconnectingIndicator(true); }

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
            _updateLatencyDisplay(latency);
        }
    }
}

// ---------------------------------------------------------------------------
// API HELPERS
// ---------------------------------------------------------------------------

async function apiCall(route, options = {}, retries = 2) {
    const url = `/api/${route}`;
    const fetchOpts = {
        method:  options.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body:    options.body ? JSON.stringify(options.body) : undefined,
    };

    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, fetchOpts);
            // If 5xx server error, throw to trigger retry. 4xx (client error) returns immediately.
            if (!res.ok && res.status >= 500 && i < retries) throw new Error(res.statusText);
            
            const data = await res.json().catch(() => ({}));
            return { ok: res.ok, status: res.status, data };
        } catch (e) {
            if (i === retries) return { ok: false, status: 0, data: { error: 'Network error' } };
            // Backoff: 500ms, 1000ms
            await new Promise(r => setTimeout(r, 500 * (i + 1)));
        }
    }
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
        _syncState();
        localStorage.setItem('cs_room_code',    roomCode);
        localStorage.setItem('cs_operator_key', opKey);
        localStorage.setItem('cs_op_key_hash',  operatorKeyHash);
        sbManager.connect(roomCode);
        updateSessionUI();
        closeOverlay();
        showSessionToast(`🌐 Live! Room: ${roomCode}`);
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

async function joinOnlineSession(roomCode) {
    let code = (roomCode || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (code.length === 8) {
        code = code.slice(0, 4) + '-' + code.slice(4);
    }

    if (!code) return;
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
        if (savedCode === code && savedHash && savedHash === session.operator_key) {
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

        if (!sbManager) sbManager = new SupabaseRealtimeManager(_RT_URL, _RT_KEY);

        _isBootingSession = true;
        applyRemoteState(session);
        _isBootingSession = false;
        sbManager.connect(code);
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

    // OFFLINE GUARD: Queue changes if offline
    if (!navigator.onLine) {
        localStorage.setItem('cs_pending_sync', 'true');
        showSyncStatus('Offline. Changes queued.', 'info');
        return;
    }

    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(async () => {
        try {
            const res = await apiCall('session-update', {
                method: 'PATCH',
                body: {
                    room_code:        currentRoomCode,
                    operator_key:     operatorKey,
                    squad:            StateStore.squad,
                    current_matches:  StateStore.currentMatches,
                    // round_history intentionally excluded — undo is local only,
                    // removing this cuts DB payload size significantly
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
                showSyncStatus('Saved to cloud', 'success');
                // Clear success message after 2s
                setTimeout(() => {
                    const el = document.getElementById('syncStatusMsg');
                    if (el && el.textContent === 'Saved to cloud') el.style.display = 'none';
                }, 2000);
            }
        } catch (e) { 
            console.error('CourtSide: push failed', e); 
            localStorage.setItem('cs_pending_sync', 'true');
            showSyncStatus('Sync failed. Retrying...', 'error');
        }
    }, 800);
}

// ---------------------------------------------------------------------------
// BROADCAST — instant events, no DB write, <100ms delivery
// ---------------------------------------------------------------------------

// Internal: send any broadcast event
function _broadcast(type, payload) {
    if (sbManager) sbManager.broadcast(type, payload);
}

/**
 * BUG FIX: Feature #5 - Player self-service break
 * Player broadcasts their status intent (active/resting) to the host.
 */
function broadcastStatusUpdate(playerUUID, isActive) {
    if (sbManager) sbManager.broadcast('player_status_update', { playerUUID, isActive });
}

/**
 * Player broadcasts their spirit animal update to the host.
 */
function broadcastSpiritAnimalUpdate(playerUUID, emoji) {
    if (sbManager) sbManager.broadcast('spirit_animal_update', { playerUUID, emoji });
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
 * BUG 2 FIX — broadcast live game state whenever matches change.
 * Called by saveToDisk hook, setWinner, processAndNext.
 * Players update their live feed immediately without waiting for DB.
 */
function broadcastGameState() {
    if (!isOperator || !isOnlineSession) return;
    // Serialize matches with explicit teamA/teamB keys so the player view never
    // has to infer team assignment from position or sort order.
    const safeMatches = StateStore.currentMatches.map(m => ({
        ...m,
        teams: [
            Array.isArray(m.teams[0]) ? [...m.teams[0]] : [],
            Array.isArray(m.teams[1]) ? [...m.teams[1]] : [],
        ],
    }));
    _broadcast('game_state', {
        squad: StateStore.squad,
        current_matches: safeMatches,
        courtNames: StateStore.get('courtNames'),
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
    if (sbManager) sbManager.broadcast('name_update', { playerUUID, oldName, newName });
}

function broadcastPlayerLeaving(playerUUID, playerName) {
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

/**
 * Called by passportRename() in app.js after the player updates their name.
 * Updates session_members.player_name → triggers host realtime listener.
 */
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

/**
 * Called by PlayerMode.boot() in passport.js.
 * Upserts a session_members row (pending if new, preserves active if returning).
 * Returns { status: 'pending' | 'active', member } — caller uses this
 * to decide whether to bypass the pending screen.
 */
async function memberUpsert(playerUUID, playerName, explicitRoomCode) {
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

    // BUG 1: Player approved — flip from pending → active
    if (type === 'session_joined') {
        if (!isOperator && typeof PlayerMode !== 'undefined') {
            PlayerMode._onApprovalReceived(payload);
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
    const trimmed = newName.trim();

    // 1. Find player by UUID (stored on squad member at approval) — rename-safe
    let player = StateStore.squad.find(p => p.uuid === playerUUID);
    // 2. Fallback: find by oldName if uuid not yet on squad member
    if (!player) player = StateStore.squad.find(p => p.name === oldName);

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

    // Update active matches if the player is currently in a game
    let matchUpdated = false;
    if (StateStore.currentMatches) {
        StateStore.currentMatches.forEach(m => {
            m.teams.forEach((team, tIdx) => {
                if (team.includes(prevName)) {
                    m.teams[tIdx] = team.map(n => n === prevName ? trimmed : n);
                    matchUpdated = true;
                }
            });
        });
    }

    renderSquad();
    saveToDisk();
    if (matchUpdated) broadcastGameState(); // Ensure players see the new name on match cards
    showSessionToast(`✏️ ${prevName} → ${trimmed}`);
}

// Host applies a spirit animal update broadcast from a player
function _applySpiritAnimalUpdate(playerUUID, emoji) {
    const player = StateStore.squad.find(p => p.uuid === playerUUID);
    if (!player) return;

    if (player.spiritAnimal !== emoji) {
        player.spiritAnimal = emoji;
        renderSquad();
        saveToDisk();
        broadcastGameState();
    }
}

// Host applies a status change broadcast from a player
function _applyStatusUpdate(playerUUID, isActive) {
    const player = StateStore.squad.find(p => p.uuid === playerUUID);
    if (!player) return;

    const oldStatus = player.active;
    player.active = !!isActive;

    if (oldStatus !== player.active) {
        renderSquad();
        checkNextButtonState();
        saveToDisk();
        broadcastGameState(); // Push new squad state to all players
        showSessionToast(`${player.name} is now ${player.active ? 'Ready 🏸' : 'Resting ☕'}`);
    }
}

// ---------------------------------------------------------------------------
// HANDLER FOR POSTGRES CHANGES (Called by Manager)
// ---------------------------------------------------------------------------

function _handlePostgresChange(payload) {
    const table  = payload?.data?.table || payload?.table;
    const record = payload?.data?.record;
    const old    = payload?.data?.old_record;
    const type   = payload?.eventType || payload?.type;

    if (table === 'session_members' || payload?.data?.table === 'session_members') {
        if (type === 'DELETE' && old) _handleMemberChange(old, null, type);
        else if (record) _handleMemberChange(record, old, type);
        return;
    }

    if (table === 'play_requests' || payload?.data?.table === 'play_requests') {
        if (isOperator && record && typeof window.onPlayRequestInsert === 'function') {
            window.onPlayRequestInsert(record);
        }
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
    // Only allow host to apply remote state during initial boot/rejoin hydration.
    if (isOperator && !_isBootingSession) {
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
    const loadedQueue = (session.player_queue || []).filter(name => loadedSquad.find(p => p.name === name));
    const loadedCourtNames = session.court_names || {};
    let loadedCourts = 1;
    if (Number.isInteger(session.active_courts) && session.active_courts >= 1) {
        loadedCourts = session.active_courts;
        setTimeout(() => {
            const courtInput = document.getElementById('courtCountInput');
            if (courtInput) courtInput.value = loadedCourts;
        }, 0);
    }

    StateStore.setState({ 
        squad: loadedSquad, 
        currentMatches: loadedMatches, 
        playerQueue: loadedQueue, 
        activeCourts: loadedCourts, 
        courtNames: loadedCourtNames,
        isOpenParty: session.is_open_party || false,
        guestList: session.guest_list || []
    });
    // Also update window globals for player view, which doesn't use StateStore
    if (!isOperator) {
        window.squad = loadedSquad;
        window.currentMatches = loadedMatches;
        window.courtNames = loadedCourtNames;
    }

    // round_history is no longer synced to DB — keep local undo history intact
    // roundHistory stays as-is on rejoin

    // Migrate: remote squad rows may come from an older client that didn't
    // save rating / consecutiveGames / forcedRest. migratePlayer() is defined
    // in app.js and backfills any missing fields so calculateOdds never sees
    // undefined.rating regardless of where the data came from.
    if (typeof migratePlayer === 'function') StateStore.squad.forEach(migratePlayer);
    window._sessionUUIDMap  = session.uuid_map         || {};
    window._approvedPlayers = session.approved_players || {};

    if (!isOperator) {
        // Ensure the player view is active and visible if matches are available
        if (typeof SidelineView !== 'undefined' && !SidelineView._visible) {
            SidelineView.show();
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
            // No immediate squad change — host approves via the notification
            // (play_requests table still drives the approval UI)

        } else if (eventType === 'UPDATE') {
            const prev = window._sessionMembers[uuid] || {};
            window._sessionMembers[uuid] = record;

            // Name change? Update squad in-memory and re-render.
            if (prev.player_name && name && prev.player_name !== name) {
                // Delegate to _applyNameUpdate which handles uuid_map + squad + render
                _applyNameUpdate(uuid, prev.player_name, name);
                showSessionToast(`✏️ ${prev.player_name} → ${name}`);
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
        count = (typeof StateStore.squad !== 'undefined' ? StateStore.squad : []).length;
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
            localStorage.removeItem('cs_room_code');
            localStorage.removeItem('cs_operator_key');
            localStorage.removeItem('cs_op_key_hash');
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
        } else {
            isOperator = false;
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
        showSyncStatus('Online. Syncing queued changes...', 'info');
        pushStateToSupabase();
    } 
    // If we were completely disconnected/offline boot, try to reconnect session
    else if (!isOnlineSession && localStorage.getItem('cs_room_code')) {
        tryAutoRejoin();
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
    if (!currentRoomCode) return;
    try {
        await fetch('/api/match-history', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code: currentRoomCode,
                operator_key: operatorKey,
                timestamp: snapshot.timestamp,
                matches:   snapshot.matches,
                squad:     snapshot.squadSnapshot,
            }),
        });
    } catch (e) { console.error('CourtSide: archive failed', e); }
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
    el.textContent = `${ms}ms`;
}