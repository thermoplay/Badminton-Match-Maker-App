// REPLACEMENT for dispatchWinSignals in app.js
// Changes:
//   1. roundKey (timestamp) added to both broadcast and DB signal
//      so the dedup set in PlayerMode can distinguish rounds with
//      identical game labels (e.g. "Game 1" every round).
//   2. winnerUUIDs and loserUUIDs are built as mutually exclusive sets.
//      A UUID cannot appear in both — this was the root cause of wins
//      being recorded twice when a player appeared in both arrays.

async function dispatchWinSignals(mIdx) {
    if (!isOperator || !currentRoomCode) return;
    const m = currentMatches[mIdx];
    if (!m || m.winnerTeamIndex === null) return;

    const winIdx  = m.winnerTeamIndex;
    const loseIdx = winIdx === 0 ? 1 : 0;
    const uuidMap = window._sessionUUIDMap || {};
    const label   = `Game ${mIdx + 1}`;

    // FIX: Use a single timestamp as the round key so every game in this
    // round shares the same key. Stored on window so processAndNext() can
    // pass the same value for all games in one button press.
    const roundKey = window._currentRoundKey || String(Date.now());

    const resolveUUID = (name) => {
        const member = squad.find(p => p.name === name);
        return member?.uuid || uuidMap[name] || null;
    };

    const winnerNames = m.teams[winIdx]  || [];
    const loserNames  = m.teams[loseIdx] || [];

    const winnerUUIDs = winnerNames.map(resolveUUID).filter(Boolean);
    const loserUUIDs  = loserNames .map(resolveUUID).filter(Boolean);

    // Safety: remove any UUID that appears in both arrays (shouldn't happen)
    const winnerSet = new Set(winnerUUIDs);
    const safeLoserUUIDs = loserUUIDs.filter(u => !winnerSet.has(u));

    const winnerDisplayNames = winnerNames.join(' & ');

    // Broadcast match_resolved — carries roundKey for dedup
    if (typeof _broadcast === 'function' && isOnlineSession) {
        _broadcast('match_resolved', {
            winnerNames:  winnerDisplayNames,
            winnerUUIDs,
            loserUUIDs:   safeLoserUUIDs,
            gameLabel:    label,
            roundKey,                        // ← NEW: round-scoped dedup key
        });
    }

    // DB fallback signal — also carries round_key
    if (winnerUUIDs.length > 0 || safeLoserUUIDs.length > 0) {
        fetch('/api/passport-signal', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code:    currentRoomCode,
                winner_uuids: winnerUUIDs,
                loser_uuids:  safeLoserUUIDs,
                game_label:   label,
                round_key:    roundKey,       // ← NEW: passed to signal row
            }),
        }).catch(e => console.error('Signal dispatch failed:', e));
    }
}
// REPLACEMENT for processAndNext in logic.js
// FIX: Sets window._currentRoundKey ONCE before dispatching signals
// so all games in the same "Next Round" press share a single round key.
// This prevents "Game 1" in round 2 from being blocked by the dedup
// set that saw "Game 1" in round 1.

function processAndNext() {
    if (currentMatches.length > 0) {
        if (!currentMatches.every(m => m.winnerTeamIndex !== null)) {
            alert('Operations Hold: Please select winners for all active games.');
            return;
        }

        const snapshot = {
            squadSnapshot: squad.map(p => ({ ...p })),
            matches:       currentMatches.map(m => ({ ...m, teams: m.teams.map(t => [...t]) })),
            timestamp:     Date.now(),
        };
        roundHistory.push(snapshot);

        if (typeof archiveRoundToSupabase === 'function') archiveRoundToSupabase(snapshot);

        // FIX: Set a fresh round key ONCE for all games in this round.
        // dispatchWinSignals reads window._currentRoundKey so every game
        // in the same button press shares the same key.
        window._currentRoundKey = String(Date.now());

        if (typeof dispatchWinSignals === 'function') {
            currentMatches.forEach((m, idx) => {
                if (m.winnerTeamIndex !== null) dispatchWinSignals(idx);
            });
        }

        // Clear round key after dispatch so a stale value isn't reused
        window._currentRoundKey = null;

        applyELOResults();
        updateUndoButton();
    }
    generateMatches();
}
