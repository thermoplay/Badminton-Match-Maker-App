// =============================================================================
// COURTSIDE PRO — state-store.js
// Responsibilities: Manages all global application state.
// Provides a single source of truth and controlled state mutations.
// =============================================================================

const StateStore = (() => {
    let _state = {
        squad: [],
        currentMatches: [],
        playerQueue: [], // Strictly stores player UUIDs
        activeCourts: 1,
        roundHistory: [],
        selectedPlayerIndex: null,
        courtNames: {},
        isOpenParty: false,
        guestList: [],
        batterySaver: false,
        lastUpdated: Date.now(),
    };

    let _syncTimer = null;
    /** Batches sync operations to the next execution tick to prevent redundant calls. */
    const _triggerSync = () => {
        if (_syncTimer) return;
        _syncTimer = setTimeout(() => {
            if (typeof window.saveToDisk === 'function') window.saveToDisk();
            if (typeof window.broadcastGameState === 'function') window.broadcastGameState();
            _syncTimer = null;
        }, 0);
    };

    // --- Getters ---
    const get = (key) => _state[key];

    // --- Setters ---
    const set = (key, value) => {
        if (key in _state) {
            _state[key] = value;
            _state.lastUpdated = Date.now();
            if (['squad', 'currentMatches', 'playerQueue'].includes(key)) {
                _triggerSync();
            }
        } else {
            console.warn(`[StateStore] Attempted to set unknown state key: ${key}`);
        }
    };

    // --- Direct Accessors for convenience ---
    const getState = () => ({ ..._state });
    const setState = (newState) => {
        const syncKeys = ['squad', 'currentMatches', 'playerQueue'];
        const needsSync = Object.keys(newState).some(k => syncKeys.includes(k));

        _state = { ..._state, ...newState, lastUpdated: Date.now() };

        if (needsSync) {
            _triggerSync();
        }
    };

    return {
        get,
        set,
        getState,
        setState,
        // Expose direct access to arrays for push/pop operations if needed,
        // though using setters is preferred.
        get squad() { return _state.squad; },
        get currentMatches() { return _state.currentMatches; },
        get playerQueue() { return _state.playerQueue; },
        get roundHistory() { return _state.roundHistory; },
        get lastUpdated() { return _state.lastUpdated; },
    };
})();

window.StateStore = StateStore;