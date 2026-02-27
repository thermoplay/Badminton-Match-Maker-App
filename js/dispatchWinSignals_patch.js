// ─────────────────────────────────────────────────────────────────────────────
// PATCH for app.js — replace the dispatchWinSignals function
//
// BUG: The match_resolved broadcast was missing `loserNames`, so winning players
// always saw "vs —" in their Performance Lab history instead of opponent names.
//
// FIX: Build loserNames string and include it in the _broadcast payload.
// ─────────────────────────────────────────────────────────────────────────────

// REPLACE the existing dispatchWinSignals function in app.js with this:

async function dispatchWinSignals(mIdx) {
    if (!isOperator || !currentRoomCode) return;
    const m = currentMatches[mIdx];
    if (!m || m.winnerTeamIndex === null) return;

    const winIdx  = m.winnerTeamIndex;
    const loseIdx = winIdx === 0 ? 1 : 0;
    const uuidMap = window._sessionUUIDMap || {};
    const label   = `Game ${mIdx + 1}`;

    // UUID resolution: squad member uuid > uuidMap name lookup
    const resolveUUID = (name) => {
        const member = squad.find(p => p.name === name);
        return member?.uuid || uuidMap[name] || null;
    };

    const winnerNames = m.teams[winIdx]  || [];
    const loserNames  = m.teams[loseIdx] || [];
    const winnerUUIDs = winnerNames.map(resolveUUID).filter(Boolean);
    const loserUUIDs  = loserNames .map(resolveUUID).filter(Boolean);

    // Human-readable name strings for Performance Lab history display
    const winnerDisplayNames = winnerNames.join(' & ');
    const loserDisplayNames  = loserNames.join(' & ');   // ← was missing

    // Broadcast MATCH_RESOLVED — carries winnerUUIDs + loserUUIDs so every player
    // can record their own outcome. loserNames allows winners to see who they beat.
    if (typeof _broadcast === 'function' && isOnlineSession) {
        _broadcast('match_resolved', {
            winnerNames:  winnerDisplayNames,
            loserNames:   loserDisplayNames,   // ← added
            winnerUUIDs,
            loserUUIDs,
            gameLabel:    label,
        });
    }

    // Durable DB fallback — uses winner_uuids/loser_uuids matching the API contract
    if (winnerUUIDs.length > 0 || loserUUIDs.length > 0) {
        fetch('/api/passport-signal', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                room_code:    currentRoomCode,
                winner_uuids: winnerUUIDs,
                loser_uuids:  loserUUIDs,
                game_label:   label,
            }),
        }).catch(e => console.error('Signal dispatch failed:', e));
    }
}
