// =============================================================================
// globals-shim.js — Load this FIRST, before any other app script.
// =============================================================================
// Declares all cross-module globals on `window` with safe default values so
// that any script referencing them as bare names (without `window.` prefix)
// won't throw a ReferenceError regardless of script load order.
//
// This is the permanent fix for the "isOnlineSession is not defined" crash
// (app.js:279) and any similar bare-name references across app.js, logic.js,
// passport.js, and sync.js.
// =============================================================================

// ── Sync / session state ────────────────────────────────────────────────────
window.isOnlineSession   = false;
window.isOperator        = false;
window.currentRoomCode   = null;

// ── Game state ──────────────────────────────────────────────────────────────
window.squad             = window.squad             || [];
window.currentMatches    = window.currentMatches    || [];
window.roundHistory      = window.roundHistory      || [];

// ── Session metadata ─────────────────────────────────────────────────────────
window._sessionUUIDMap   = window._sessionUUIDMap   || {};
window._approvedPlayers  = window._approvedPlayers  || {};
window._sessionMembers   = window._sessionMembers   || {};

// ── UI state ─────────────────────────────────────────────────────────────────
window._lastMatchWinner  = null;
window._lastNextUp       = null;
window._pendingJoinCode  = null;
