// =============================================================================
// COURTSIDE PRO — state-store.js
// Responsibilities: Manages all global application state.
// Provides a single source of truth and controlled state mutations.
// =============================================================================

const StateStore = (() => {
    let _state = {
        squad: [],
        currentMatches: [],
        playerQueue: [],
        activeCourts: 1,
        roundHistory: [],
        selectedPlayerIndex: null,
        courtNames: {},
    };

    // --- Getters ---
    const get = (key) => _state[key];

    // --- Setters ---
    const set = (key, value) => {
        if (key in _state) {
            _state[key] = value;
        } else {
            console.warn(`[StateStore] Attempted to set unknown state key: ${key}`);
        }
    };

    // --- Direct Accessors for convenience ---
    const getState = () => ({ ..._state });
    const setState = (newState) => {
        _state = { ..._state, ...newState };
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
    };
})();

window.StateStore = StateStore;