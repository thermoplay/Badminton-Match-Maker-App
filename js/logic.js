// =============================================================================
// COURTSIDE PRO — logic.js
// Responsibilities: Match generation, ELO calculation, match rendering,
//                  winner selection, round processing, team builder.
// Depends on: app.js (must be loaded before this file)
// =============================================================================

// ---------------------------------------------------------------------------
// LOOKUP HELPER
// ---------------------------------------------------------------------------

/** Finds a player object by name. Returns undefined if not found. */
function findP(name) {
    return squad.find(p => p.name === name);
}

// ---------------------------------------------------------------------------
// ELO ENGINE
// ---------------------------------------------------------------------------

function calculateELOSift(winnerRating, loserRating) {
    const K = 32;
    const expectedWin = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
    return Math.round(K * (1 - expectedWin));
}

function calculateOdds(teamA, teamB) {
    // Null-safe: if a player object is missing (stale data), default rating to 1200
    const r = p => (p && p.rating != null ? p.rating : 1200);
    const rA = (r(teamA[0]) + r(teamA[1])) / 2;
    const rB = (r(teamB[0]) + r(teamB[1])) / 2;
    const expectedA = 1 / (1 + Math.pow(10, (rB - rA) / 400));
    const probA = Math.round(expectedA * 100);
    return [probA, 100 - probA];
}

// ---------------------------------------------------------------------------
// ROUND PROCESSING
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PER-COURT ADVANCEMENT — fires when host taps "Next Game" on one court
// ---------------------------------------------------------------------------

function processCourtResult(mIdx) {
    const match = currentMatches[mIdx];
    if (!match || match.winnerTeamIndex === null) {
        alert('Select a winner first.');
        return;
    }

    // Snapshot for undo
    const snapshot = {
        squadSnapshot: squad.map(p => ({ ...p })),
        matches:       currentMatches.map(m => ({ ...m, teams: m.teams.map(t => [...t]) })),
        queueSnapshot: [...playerQueue],
        timestamp:     Date.now(),
    };
    roundHistory.push(snapshot);
    if (typeof archiveRoundToSupabase === 'function') archiveRoundToSupabase(snapshot);

    // Apply ELO for this court only
    applyELOForMatch(match);

    // Dispatch win signals
    if (typeof dispatchWinSignals === 'function') dispatchWinSignals(mIdx);

    // Rotate just this court's players back into the queue
    rotateCourtPlayers(match);

    // Pull the next 4 from the queue for this court
    const next4 = pullNextFromQueue();
    if (next4.length < 4) {
        // Not enough players — remove this court slot and collapse
        currentMatches.splice(mIdx, 1);
        rebuildMatchCardIndices();
        renderQueueStrip();
        checkNextButtonState();
        updateUndoButton();
        saveToDisk();
        return;
    }

    // Build new match for this court
    const newMatch = buildMatchFromPlayers(next4);
    currentMatches[mIdx] = newMatch;

    // Replace this card in the DOM
    const tA    = next4.slice(0, 2);
    const tB    = next4.slice(2, 4);
    const cardEl = document.getElementById(`match-${mIdx}`);
    if (cardEl) cardEl.outerHTML = buildMatchCardHTML(mIdx, tA, tB, newMatch.odds);

    renderQueueStrip();
    checkNextButtonState();
    updateUndoButton();
    saveToDisk();
    Haptic.bump();
}

// ---------------------------------------------------------------------------
// FIRST START — fires the first time host presses "Start Session"
// ---------------------------------------------------------------------------

function processAndNext() {
    // If courts are already live, this button is disabled — do nothing
    if (currentMatches.length > 0) return;
    generateMatches();
}

function applyELOForMatch(m) {
    if (m.winnerTeamIndex === null) return;
    const winIdx  = m.winnerTeamIndex;
    const loseIdx = winIdx === 0 ? 1 : 0;

    const winners = m.teams[winIdx].map(n => findP(n)).filter(Boolean);
    const losers  = m.teams[loseIdx].map(n => findP(n)).filter(Boolean);
    if (!winners.length || !losers.length) return;

    const winAvg  = winners.reduce((s, p) => s + p.rating, 0) / winners.length;
    const loseAvg = losers.reduce((s, p)  => s + p.rating, 0) / losers.length;
    const sift    = calculateELOSift(winAvg, loseAvg);

    winners.forEach(p => { p.rating += sift; p.wins++; p.games++; p.streak++; });
    losers.forEach(p  => { p.rating = Math.max(800, p.rating - sift); p.games++; p.streak = 0; });
}

// Legacy alias — kept for undo path
function applyELOResults() {
    currentMatches.forEach(m => applyELOForMatch(m));
}

// ---------------------------------------------------------------------------
// QUEUE ENGINE
// ---------------------------------------------------------------------------
//
// playerQueue — ordered array of player NAMES representing the rotation.
// The first N*4 names (enough for courtCount courts) play each round.
// After results are entered, losers go to the back first, then winners,
// ensuring winners wait slightly longer (a small earned rest).
//
// New players added mid-session are appended to the back of the queue.
// Rested (inactive) players are silently skipped when pulling from the
// front, but their queue position is preserved so they re-enter fairly.
//
// The queue persists to localStorage so it survives page reloads.

// playerQueue is declared in app.js (global state) and persisted to disk.

// ---------------------------------------------------------------------------
// INITIALISE QUEUE — called once when first generating matches, or when
// the squad changes in a way that requires a full rebuild.
// ---------------------------------------------------------------------------

function initQueue() {
    const activeNames = squad.filter(p => p.active).map(p => p.name);

    // Keep existing queue order for names already in it — only append newcomers
    const inQueue  = new Set(playerQueue);
    const newNames = activeNames.filter(n => !inQueue.has(n));

    // Remove names no longer in the active squad
    playerQueue = playerQueue.filter(n => squad.find(p => p.name === n && p.active));

    // Append newcomers at the back
    playerQueue.push(...newNames);
}

// ---------------------------------------------------------------------------
// ROTATE QUEUE — called after every round with results.
// Finished players leave the front of the queue and rejoin at the back:
//   losers first (shorter wait), then winners (earned rest).
// ---------------------------------------------------------------------------

// Rotate a single court's players back into the queue
function rotateCourtPlayers(m) {
    const allNames = m.teams.flat();
    // Remove from wherever they currently sit
    playerQueue = playerQueue.filter(n => !allNames.includes(n));

    if (m.winnerTeamIndex === null) {
        playerQueue.push(...allNames);
        return;
    }
    const winIdx  = m.winnerTeamIndex;
    const loseIdx = winIdx === 0 ? 1 : 0;
    // Losers back first (shorter wait), winners after (slight rest)
    playerQueue.push(...m.teams[loseIdx], ...m.teams[winIdx]);
}

// Pull the next 4 eligible active players from the queue front.
// Returns player OBJECTS (not names). Does NOT mutate the queue.
function pullNextFromQueue() {
    initQueue(); // ensure new/departed players are synced first
    const onCourt   = new Set(currentMatches.flatMap(m => m.teams.flat()));
    const pulled    = [];
    const pulledSet = new Set();

    for (const name of playerQueue) {
        if (pulled.length >= 4) break;
        if (onCourt.has(name)) continue;        // already playing another court
        if (pulledSet.has(name)) continue;      // dupe guard
        const p = squad.find(s => s.name === name && s.active);
        if (!p) continue;
        pulled.push(p);
        pulledSet.add(name);
    }
    return pulled;
}

// Build a match object from 4 player objects, applying history-aware pairing
function buildMatchFromPlayers(p4) {
    p4.forEach(p => p.sessionPlayCount++);

    p4.sort(() => Math.random() - 0.5);
    p4.sort((a, b) => b.rating - a.rating);

    const pairings = [
        { tA: [p4[0], p4[3]], tB: [p4[1], p4[2]] },
        { tA: [p4[0], p4[2]], tB: [p4[1], p4[3]] },
        { tA: [p4[0], p4[1]], tB: [p4[2], p4[3]] },
    ];

    const tmCount  = (a, b) => (a.teammateHistory  || {})[b.name] || 0;
    const oppCount = (a, b) => (a.opponentHistory  || {})[b.name] || 0;
    const scorePairing = ({ tA, tB }) =>
        tmCount(tA[0], tA[1]) * 2 + tmCount(tB[0], tB[1]) * 2 +
        oppCount(tA[0], tB[0]) + oppCount(tA[0], tB[1]) +
        oppCount(tA[1], tB[0]) + oppCount(tA[1], tB[1]);

    pairings.sort(() => Math.random() - 0.5);
    pairings.sort((a, b) => scorePairing(a) - scorePairing(b));

    const { tA, tB } = pairings[0];
    const odds = calculateOdds(tA, tB);

    const addHistory = (p, teammate, opponents) => {
        p.teammateHistory = p.teammateHistory || {};
        p.opponentHistory = p.opponentHistory || {};
        p.teammateHistory[teammate.name] = (p.teammateHistory[teammate.name] || 0) + 1;
        opponents.forEach(o => {
            p.opponentHistory[o.name] = (p.opponentHistory[o.name] || 0) + 1;
        });
    };
    addHistory(tA[0], tA[1], tB); addHistory(tA[1], tA[0], tB);
    addHistory(tB[0], tB[1], tA); addHistory(tB[1], tB[0], tA);

    return {
        teams:           [tA.map(p => p.name), tB.map(p => p.name)],
        winnerTeamIndex: null,
        odds,
    };
}

// Rebuild DOM indices after a court is removed (so id="match-N" stays accurate)
function rebuildMatchCardIndices() {
    const container = document.getElementById('matchContainer');
    container.innerHTML = '';
    currentMatches.forEach((m, i) => {
        const tA = m.teams[0].map(n => findP(n)).filter(Boolean);
        const tB = m.teams[1].map(n => findP(n)).filter(Boolean);
        if (tA.length === 2 && tB.length === 2) {
            container.insertAdjacentHTML('beforeend', buildMatchCardHTML(i, tA, tB, m.odds));
            if (m.winnerTeamIndex !== null) {
                const boxes = document.querySelectorAll(`#match-${i} .team-box`);
                if (boxes[m.winnerTeamIndex]) boxes[m.winnerTeamIndex].classList.add('selected');
            }
        }
    });
}

// Legacy alias for undo — rotates ALL courts at once
function rotateQueue() {
    currentMatches.forEach(m => rotateCourtPlayers(m));
}

// ---------------------------------------------------------------------------
// GENERATE MATCHES — queue-based rotation
// ---------------------------------------------------------------------------
//
// 1. Initialise / sync the queue with the current active squad.
// 2. Pull the first courtCount*4 active players from the front of the queue.
// 3. For each group of 4, choose the team split that minimises repeat
//    teammates and opponents (full session history, weighted scoring).
// 4. Render match cards and the queue strip below them.

function generateMatches() {
    const activePool = squad.filter(p => p.active);
    if (activePool.length < 4) {
        alert('Requires at least 4 active players.');
        return;
    }

    initQueue();

    currentMatches = [];
    document.getElementById('matchContainer').innerHTML = '';

    // Cap courts to what the active pool can support (need 4 players per court)
    const maxCourts  = Math.floor(activePool.length / 4);
    const courtCount = Math.min(activeCourts, maxCourts);
    const matchData  = [];

    for (let i = 0; i < courtCount; i++) {
        const p4 = pullNextFromQueue();
        if (p4.length < 4) break;
        const match = buildMatchFromPlayers(p4);
        currentMatches.push(match);
        const tA = p4.slice(0, 2);
        const tB = p4.slice(2, 4);
        matchData.push({ idx: i, tA, tB, odds: match.odds });
    }

    renderAllMatchCards(matchData);
    renderQueueStrip();
    checkNextButtonState();
    renderSquad();
    saveToDisk();
    Haptic.bump();
}

// ---------------------------------------------------------------------------
// QUEUE STRIP — visible list of who's waiting and in what order
// ---------------------------------------------------------------------------

function renderQueueStrip() {
    let strip = document.getElementById('queueStrip');
    if (!strip) {
        strip = document.createElement('div');
        strip.id = 'queueStrip';
        strip.className = 'queue-strip';
        const container = document.getElementById('matchContainer');
        container.insertAdjacentElement('afterend', strip);
    }

    // Players currently on a court
    const onCourt = new Set(currentMatches.flatMap(m => m.teams.flat()));

    // Queue: active players not on court, in queue order
    const waiting = playerQueue
        .map(name => squad.find(p => p.name === name))
        .filter(p => p && p.active && !onCourt.has(p.name));

    if (waiting.length === 0) {
        strip.style.display = 'none';
        return;
    }

    strip.style.display = 'block';

    strip.innerHTML = `
        <div class="queue-strip-header">
            <span class="queue-strip-title">⏳ Queue</span>
            <span class="queue-strip-count">${waiting.length} waiting</span>
        </div>
        <div class="queue-strip-list">
            ${waiting.map((p, idx) => `
                <div class="queue-item">
                    <span class="queue-pos">${idx + 1}</span>
                    ${Avatar.html(p.name)}
                    <span class="queue-name">${escapeHTML(p.name)}</span>
                    ${idx < activeCourts * 4 ? '<span class="queue-next-badge">NEXT</span>' : ''}
                </div>
            `).join('')}
        </div>
    `;

}
// ---------------------------------------------------------------------------
// MATCH CARD RENDERING
// ---------------------------------------------------------------------------

function renderAllMatchCards(matchData) {
    const container = document.getElementById('matchContainer');
    container.innerHTML = matchData.map(({ idx, tA, tB, odds }) =>
        buildMatchCardHTML(idx, tA, tB, odds)
    ).join('');
}

function renderMatchCard(idx, tA, tB, odds) {
    const container = document.getElementById('matchContainer');
    container.insertAdjacentHTML('beforeend', buildMatchCardHTML(idx, tA, tB, odds));
}

function buildMatchCardHTML(idx, tA, tB, odds) {
    const hA = odds[0] > odds[1] ? 'highlight' : '';
    const hB = odds[1] > odds[0] ? 'highlight' : '';

    return `
        <div class="match-card" id="match-${idx}">
            <div class="match-header">
                <span class="match-label">Court ${idx + 1}</span>
                <div class="prob-container">
                    <div class="prob-pill ${hA}">${odds[0]}%</div>
                    <div class="prob-pill ${hB}">${odds[1]}%</div>
                </div>
                <button class="aura-share-btn" onclick="shareAuraPoster(${idx})" title="Share Aura Poster">✦ Share</button>
                <button class="edit-teams-btn" onclick="openTeamBuilder(${idx})">✎ Edit</button>
            </div>
            <div class="team-box" onclick="setWinner(${idx}, 0)">
                <b>${escapeHTML(tA[0].name)} <span class="amp">&amp;</span> ${escapeHTML(tA[1].name)}</b>
            </div>
            <div class="vs-badge">VS</div>
            <div class="team-box" onclick="setWinner(${idx}, 1)">
                <b>${escapeHTML(tB[0].name)} <span class="amp">&amp;</span> ${escapeHTML(tB[1].name)}</b>
            </div>
            <div class="court-next-row" id="court-next-${idx}">
                <button class="court-next-btn" onclick="processCourtResult(${idx})" disabled>
                    Next Game →
                </button>
            </div>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// WINNER SELECTION
// ---------------------------------------------------------------------------

function setWinner(mIdx, tIdx) {
    const boxes = document.querySelectorAll(`#match-${mIdx} .team-box`);
    boxes.forEach((box, i) => box.classList.toggle('selected', i === tIdx));
    currentMatches[mIdx].winnerTeamIndex = tIdx;

    Haptic.tap();

    // Confetti burst from the winning team-box
    const winBox = boxes[tIdx];
    if (winBox) {
        const rect = winBox.getBoundingClientRect();
        Confetti.burst(rect.left + rect.width / 2, rect.top + rect.height / 2, 55);
    }

    // Enable this court's Next Game button now that a winner is selected
    const nextBtn = document.querySelector(`#court-next-${mIdx} .court-next-btn`);
    if (nextBtn) nextBtn.disabled = false;

    checkNextButtonState();
    saveToDisk();
}

// ---------------------------------------------------------------------------
// TEAM BUILDER
// ---------------------------------------------------------------------------

// Working state for the builder — separate from currentMatches until confirmed
let builderMatchIdx  = null;  // which game we're editing
let builderTeams     = null;  // [teamA_names[], teamB_names[]]
let builderSelected  = null;  // { team: 0|1, name: string } — player being swapped

/**
 * Opens the team builder modal for a given match.
 * Deep-copies team names so edits don't touch currentMatches until confirmed.
 */
function openTeamBuilder(mIdx) {
    builderMatchIdx = mIdx;
    builderTeams    = currentMatches[mIdx].teams.map(t => [...t]); // deep copy
    builderSelected = null;
    renderTeamBuilder();
    document.getElementById('teamBuilderModal').style.display = 'flex';
}

function closeTeamBuilder() {
    document.getElementById('teamBuilderModal').style.display = 'none';
    builderMatchIdx  = null;
    builderTeams     = null;
    builderSelected  = null;
}

/**
 * Re-renders the team builder UI based on current builderTeams state.
 * Called after every swap or shuffle.
 */
function renderTeamBuilder() {
    const m = currentMatches[builderMatchIdx];

    // All names currently in this game
    const inGame = new Set([...builderTeams[0], ...builderTeams[1]]);

    // Sideline = active players NOT in any game at all
    const allInGames = new Set(currentMatches.flatMap(match => match.teams.flat()));
    const sideline = squad.filter(p =>
        (p.active && !allInGames.has(p.name)) ||
        // also allow swapping players already in THIS game (they're shown in teams, not sideline)
        (p.active && inGame.has(p.name) && !builderTeams[0].includes(p.name) && !builderTeams[1].includes(p.name))
    ).filter(p => !inGame.has(p.name)); // sideline = truly not in this game

    document.getElementById('builderGameLabel').innerText = `Game ${builderMatchIdx + 1}`;

    // Render Team A
    document.getElementById('builderTeamA').innerHTML = builderTeams[0].map(name => {
        const isSelected = builderSelected && builderSelected.name === name;
        return `<div class="builder-chip ${isSelected ? 'builder-selected' : ''}"
                     onclick="builderSelectPlayer(0, '${escapeHTML(name)}')">
                    ${escapeHTML(name)}
                </div>`;
    }).join('');

    // Render Team B
    document.getElementById('builderTeamB').innerHTML = builderTeams[1].map(name => {
        const isSelected = builderSelected && builderSelected.name === name;
        return `<div class="builder-chip ${isSelected ? 'builder-selected' : ''}"
                     onclick="builderSelectPlayer(1, '${escapeHTML(name)}')">
                    ${escapeHTML(name)}
                </div>`;
    }).join('');

    // Render sideline bench
    const sidelineEl = document.getElementById('builderSideline');
    if (sideline.length > 0) {
        sidelineEl.innerHTML = `
            <div class="builder-section-label">Sideline — tap to swap in</div>
            <div class="builder-bench">
                ${sideline.map(p => `
                    <div class="builder-chip bench ${builderSelected ? 'bench-ready' : ''}"
                         onclick="builderSwapFromSideline('${escapeHTML(p.name)}')">
                        ${escapeHTML(p.name)}
                    </div>
                `).join('')}
            </div>
        `;
    } else {
        sidelineEl.innerHTML = '<div class="builder-section-label" style="opacity:0.4;">No players on sideline</div>';
    }

    // Update odds preview
    const tAObjs = builderTeams[0].map(n => findP(n)).filter(Boolean);
    const tBObjs = builderTeams[1].map(n => findP(n)).filter(Boolean);
    if (tAObjs.length === 2 && tBObjs.length === 2) {
        const odds = calculateOdds(tAObjs, tBObjs);
        const hA = odds[0] > odds[1] ? 'highlight' : '';
        const hB = odds[1] > odds[0] ? 'highlight' : '';
        document.getElementById('builderOdds').innerHTML = `
            <div class="prob-container">
                <div class="prob-pill ${hA}">${odds[0]}%</div>
                <div class="prob-pill ${hB}">${odds[1]}%</div>
            </div>
        `;
    }
}

/**
 * Selects a player from a team for swapping.
 * If a player from the OTHER team is already selected → swap them.
 * If same team → deselect (toggle).
 * If sideline player was selected first, this clears that and selects in-game player.
 */
function builderSelectPlayer(teamIdx, name) {
    if (builderSelected && builderSelected.name === name) {
        // Toggle off — deselect
        builderSelected = null;
    } else if (builderSelected && builderSelected.team !== teamIdx) {
        // Selected player from opposite team → swap positions
        const otherName = builderSelected.name;
        const otherTeam = builderSelected.team;

        // Swap: remove name from teamIdx, add otherName. Remove otherName from otherTeam, add name.
        builderTeams[teamIdx]  = builderTeams[teamIdx].map(n => n === name ? otherName : n);
        builderTeams[otherTeam] = builderTeams[otherTeam].map(n => n === otherName ? name : n);
        builderSelected = null;
    } else {
        // Select this player
        builderSelected = { team: teamIdx, name };
    }
    renderTeamBuilder();
}

/**
 * Swaps a sideline player into the game, replacing the currently selected in-game player.
 * If no in-game player is selected yet, shows a subtle prompt.
 */
function builderSwapFromSideline(sidelineName) {
    if (!builderSelected) {
        // No in-game player chosen yet — flash all in-game chips to signal "pick one first"
        document.querySelectorAll('.builder-chip:not(.bench)').forEach(el => {
            el.classList.add('builder-pulse');
            setTimeout(() => el.classList.remove('builder-pulse'), 600);
        });
        return;
    }

    const { team, name: outName } = builderSelected;

    // The outgoing player goes to sideline — they need their sessionPlayCount decremented
    // since they won't actually be playing this game
    const outPlayer = findP(outName);
    if (outPlayer) outPlayer.sessionPlayCount = Math.max(0, outPlayer.sessionPlayCount - 1);

    // The incoming player gets a sessionPlayCount increment
    const inPlayer = findP(sidelineName);
    if (inPlayer) inPlayer.sessionPlayCount++;

    // Swap in the team array
    builderTeams[team] = builderTeams[team].map(n => n === outName ? sidelineName : n);
    builderSelected = null;
    renderTeamBuilder();
}

/**
 * Shuffles only this game's 4 players into new balanced teams.
 * Keeps the same 4 players, re-runs the snake-draft logic.
 */
function builderShuffle() {
    const allFour = [...builderTeams[0], ...builderTeams[1]]
        .map(n => findP(n))
        .filter(Boolean);

    // Shuffle randomly first, then sort by rating for snake draft
    allFour.sort(() => Math.random() - 0.5);
    allFour.sort((a, b) => b.rating - a.rating);

    builderTeams = [
        [allFour[0].name, allFour[3].name],
        [allFour[1].name, allFour[2].name]
    ];
    builderSelected = null;
    renderTeamBuilder();
}

/**
 * Confirms the team builder changes, updates currentMatches,
 * recalculates odds, and re-renders the affected match card.
 */
function confirmTeamBuilder() {
    const mIdx = builderMatchIdx;
    const tAObjs = builderTeams[0].map(n => findP(n)).filter(Boolean);
    const tBObjs = builderTeams[1].map(n => findP(n)).filter(Boolean);

    if (tAObjs.length !== 2 || tBObjs.length !== 2) {
        alert('Each team needs exactly 2 players.');
        return;
    }

    // Update the match in state
    const newOdds = calculateOdds(tAObjs, tBObjs);
    currentMatches[mIdx].teams = [
        builderTeams[0],
        builderTeams[1]
    ];
    currentMatches[mIdx].odds = newOdds;
    currentMatches[mIdx].winnerTeamIndex = null; // Reset winner since teams changed

    // Re-render just this card by replacing it in the DOM
    const cardEl = document.getElementById(`match-${mIdx}`);
    if (cardEl) {
        cardEl.outerHTML = buildMatchCardHTML(mIdx, tAObjs, tBObjs, newOdds);
    }

    closeTeamBuilder();
    updateSideline();
    checkNextButtonState();
    saveToDisk();
    Haptic.success();
}