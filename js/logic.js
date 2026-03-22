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
    return StateStore.squad.find(p => p.name === name);
}

// ---------------------------------------------------------------------------
// ELO ENGINE
// ---------------------------------------------------------------------------

function calculateELODelta(playerRating, opponentAvgRating, actualScore, gamesPlayed) {
    const K = (Number(gamesPlayed) || 0) < 10 ? 60 : 32; // Placement matches move faster
    const expectedScore = 1 / (1 + Math.pow(10, (opponentAvgRating - playerRating) / 400));
    return Math.round(K * (actualScore - expectedScore));
}

function calculateOdds(teamA, teamB) {
    // Null-safe: if a player object is missing (stale data), default rating to 1200
    const r = p => (p && p.rating != null ? Number(p.rating) : 1200);
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
/**
 * Creates a snapshot of the current state for the undo history.
 * @param {object} finishedMatch - The match that just ended.
 */
function _createRoundSnapshot(finishedMatch) {
    finishedMatch.endedAt = Date.now();
    const snapshot = {
        squadSnapshot: StateStore.squad.map(p => ({ ...p })),
        matches:       StateStore.currentMatches.map(m => ({ ...m, teams: m.teams.map(t => [...t]) })),
        queueSnapshot: [...StateStore.playerQueue],
        timestamp:     Date.now(),
    };
    StateStore.roundHistory.push(snapshot);
    if (typeof archiveRoundToSupabase === 'function') archiveRoundToSupabase(snapshot);
}

/**
 * Applies ELO, checks achievements, signals results, and rotates players for a finished match.
 * @param {object} match - The completed match object.
 * @param {number} mIdx - The index of the match.
 */
function _processFinishedMatch(match, mIdx) {
    applyELOForMatch(match);
    if (window.checkAndAwardAchievements) {
        // Fire and forget: check for achievements in the background
        // without blocking the UI update for the next game.
        checkAndAwardAchievements(match, StateStore.squad);
    }
    if (typeof dispatchWinSignals === 'function') {
        dispatchWinSignals(mIdx, true); // skipBroadcast = true
    }
    rotateCourtPlayers(match);
}

/**
 * Handles the case where there are not enough players for the next match on a court.
 * @param {number} mIdx - The index of the court/match being removed.
 */
function _handleInsufficientPlayersForNextMatch(mIdx) {
    StateStore.currentMatches.splice(mIdx, 1);
    rebuildMatchCardIndices();
    _finalizeCourtResultUpdate();
}

/**
 * Generates a new match for a court and renders its card in the DOM.
 * @param {number} mIdx - The index of the court to update.
 * @param {Array<object>} next4 - The four players for the new match.
 */
function _generateAndRenderNextMatchForCourt(mIdx, next4) {
    const newMatch = buildMatchFromPlayers(next4);
    StateStore.currentMatches[mIdx] = newMatch;

    const tA = newMatch.teams[0].map(n => findP(n)).filter(Boolean);
    const tB = newMatch.teams[1].map(n => findP(n)).filter(Boolean);
    const cardEl = document.getElementById(`match-${mIdx}`);
    if (cardEl) {
        const newCardEl = buildMatchCard(mIdx, tA, tB, newMatch.odds, newMatch.startedAt);
        newCardEl.classList.add('card-replace');
        newCardEl.classList.remove('card-entering');
        cardEl.replaceWith(newCardEl);
    } else {
        rebuildMatchCardIndices();
    }
}

/**
 * Finalizes the court result update by refreshing UI, saving state, and broadcasting.
 */
function _finalizeCourtResultUpdate() {
    renderQueueStrip();
    checkNextButtonState();
    updateUndoButton();
    saveToDisk();
    if (typeof broadcastGameState === 'function') broadcastGameState();
    Haptic.bump();
}

async function processCourtResult(mIdx) {
    const match = StateStore.currentMatches[mIdx];
    if (!match || match.winnerTeamIndex === null) {
        alert('Select a winner first.');
        return;
    }

    _createRoundSnapshot(match);
    _processFinishedMatch(match, mIdx);

    const onCourtNow = new Set(
        StateStore.currentMatches
            .filter((_, i) => i !== mIdx)
            .flatMap(m => m.teams.flat())
    );
    const next4 = pullNextFromQueue(onCourtNow);

    if (next4.length < 4) {
        _handleInsufficientPlayersForNextMatch(mIdx);
        return;
    }

    _generateAndRenderNextMatchForCourt(mIdx, next4);
    _finalizeCourtResultUpdate();
}

// ---------------------------------------------------------------------------
// FIRST START — fires the first time host presses "Start Session"
// ---------------------------------------------------------------------------

function processAndNext() {
    // If courts are already live, this button is disabled — do nothing
    if (StateStore.currentMatches.length > 0) return;
    generateMatches();
}

function applyELOForMatch(m) {
    if (m.winnerTeamIndex === null) return;
    const winIdx  = m.winnerTeamIndex;
    const loseIdx = winIdx === 0 ? 1 : 0;

    const winners = m.teams[winIdx].map(n => findP(n)).filter(Boolean);
    const losers  = m.teams[loseIdx].map(n => findP(n)).filter(Boolean);
    if (!winners.length || !losers.length) return;

    const safeRating = p => Number(p.rating) || 1200;
    const winAvg  = winners.reduce((s, p) => s + safeRating(p), 0) / winners.length;
    const loseAvg = losers.reduce((s, p)  => s + safeRating(p), 0) / losers.length;

    // Update Winners
    winners.forEach(p => {
        const cur = safeRating(p);
        p.rating = cur + calculateELODelta(cur, loseAvg, 1, p.games);
        p.wins++; p.games++; p.streak++;
    });
    // Update Losers
    losers.forEach(p => {
        const cur = safeRating(p);
        const delta = calculateELODelta(cur, winAvg, 0, p.games);
        p.rating = Math.max(800, cur + delta); // delta is negative here
        p.games++; p.streak = 0;
    });
}

// Legacy alias — kept for undo path
function applyELOResults() {
    StateStore.currentMatches.forEach(m => applyELOForMatch(m));
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
    const activeNames = StateStore.squad.filter(p => p.active).map(p => p.name);

    // Keep existing queue order for names already in it — only append newcomers
    const inQueue  = new Set(StateStore.playerQueue);
    const newNames = activeNames.filter(n => !inQueue.has(n));

    // Remove names no longer in the active squad
    const newQueue = StateStore.playerQueue.filter(n => StateStore.squad.find(p => p.name === n && p.active));

    // Append newcomers at the back and update the store
    newQueue.push(...newNames);
    StateStore.set('playerQueue', newQueue);
}

// ---------------------------------------------------------------------------
// ROTATE QUEUE — called after every round with results.
// Finished players leave the front of the queue and rejoin at the back:
//   losers first (shorter wait), then winners (earned rest).
// ---------------------------------------------------------------------------

// Rotate a single court's players back into the queue
function rotateCourtPlayers(m) {
    const allNames = m.teams.flat();
    let newQueue = StateStore.playerQueue;
    // Remove from wherever they currently sit
    newQueue = newQueue.filter(n => !allNames.includes(n));

    if (m.winnerTeamIndex === null) {
        newQueue.push(...allNames);
    } else {
        const winIdx  = m.winnerTeamIndex;
        const loseIdx = winIdx === 0 ? 1 : 0;
        // Losers back first (shorter wait), winners after (slight rest)
        newQueue.push(...m.teams[loseIdx], ...m.teams[winIdx]);
    }
    StateStore.set('playerQueue', newQueue);
}

// ---------------------------------------------------------------------------
// VARIETY ENGINE
// ---------------------------------------------------------------------------
//
// The queue decides WHO IS ELIGIBLE to play next — the front half of the
// waiting list. Within that candidate pool we pick the GROUP OF 4 and the
// TEAM SPLIT that together minimise repeated pairings from session history.
//
// CANDIDATE POOL SIZE:
//   We look at the first (4 × POOL_FACTOR) queue-eligible players.
//   POOL_FACTOR = 2 → 8 candidates → C(8,4) = 70 group combinations.
//   Each group has 3 possible team splits → 210 total evaluations per court.
//   Fast enough to run synchronously on any device.
//
// FAIRNESS GUARANTEE:
//   A player can only be a candidate if they're in the top half of the queue.
//   Nobody outside the front pool can be chosen — so wait time is still
//   respected. The variety scoring only operates within the eligible window.

const POOL_FACTOR = 2; // candidate pool = 4 * POOL_FACTOR players

// Score a single team split — lower = fresher matchup
function scoreSplit(tA, tB) {
    const tm  = (a, b) => (a.teammateHistory  || {})[b.name] || 0;
    const opp = (a, b) => (a.opponentHistory  || {})[b.name] || 0;
    return (
        tm(tA[0], tA[1]) * 2 + tm(tB[0], tB[1]) * 2 +
        opp(tA[0], tB[0]) + opp(tA[0], tB[1]) +
        opp(tA[1], tB[0]) + opp(tA[1], tB[1])
    );
}

// Score a group of 4 — best possible split score for this combination
function scoreGroup(g) {
    const splits = [
        { tA: [g[0], g[3]], tB: [g[1], g[2]] },
        { tA: [g[0], g[2]], tB: [g[1], g[3]] },
        { tA: [g[0], g[1]], tB: [g[2], g[3]] },
    ];
    return Math.min(...splits.map(s => scoreSplit(s.tA, s.tB)));
}

// Generate all C(n, 4) combinations from an array
function combinations4(arr) {
    const out = [];
    const n = arr.length;
    for (let a = 0;     a < n - 3; a++)
    for (let b = a + 1; b < n - 2; b++)
    for (let c = b + 1; c < n - 1; c++)
    for (let d = c + 1; d < n;     d++)
        out.push([arr[a], arr[b], arr[c], arr[d]]);
    return out;
}

// Get the candidate pool for one court — front of the queue, excluding
// players already assigned to another court this round.
function getCandidatePool(onCourt) {
    initQueue();
    const pool     = [];
    const poolSet  = new Set();
    const poolSize = 4 * POOL_FACTOR;

    for (const name of StateStore.playerQueue) {
        if (pool.length >= poolSize) break;
        if (onCourt.has(name)) continue;
        if (poolSet.has(name))  continue;
        const p = StateStore.squad.find(s => s.name === name && s.active);
        if (!p) continue;
        pool.push(p);
        poolSet.add(name);
    }
    return pool;
}

// Pick the best group of 4 from the candidate pool using the variety matrix.
// Returns the 4 player objects, or fewer if the pool is too small.
function pickBestGroup(pool) {
    if (pool.length <= 4) return pool; // no choice to make

    const combos = combinations4(pool);

    // Add small random jitter so equal-score combos don't always resolve
    // the same way (keeps things feeling fresh even with zero history)
    combos.sort(() => Math.random() - 0.5);
    combos.sort((a, b) => scoreGroup(a) - scoreGroup(b));

    return combos[0];
}

// Pull the best 4 from the queue front for one court.
// onCourt = Set of names already assigned this round (multi-court guard).
function pullNextFromQueue(onCourt) {
    if (!onCourt) onCourt = new Set(StateStore.currentMatches.flatMap(m => m.teams.flat()));
    const pool = getCandidatePool(onCourt);
    return pickBestGroup(pool);
}

// Build a match object from 4 player objects, applying best-split pairing.
function buildMatchFromPlayers(p4) {
    p4.forEach(p => p.sessionPlayCount++);

    // ELO sort with shuffle for tie-breaking
    p4.sort(() => Math.random() - 0.5);
    p4.sort((a, b) => b.rating - a.rating);

    // All 3 team splits — pick the freshest
    const splits = [
        { tA: [p4[0], p4[3]], tB: [p4[1], p4[2]] },
        { tA: [p4[0], p4[2]], tB: [p4[1], p4[3]] },
        { tA: [p4[0], p4[1]], tB: [p4[2], p4[3]] },
    ];
    splits.sort(() => Math.random() - 0.5);
    splits.sort((a, b) => scoreSplit(a.tA, a.tB) - scoreSplit(b.tA, b.tB));

    const { tA, tB } = splits[0];
    const odds = calculateOdds(tA, tB);

    // Record session history for all 4 players
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
        startedAt: Date.now(),
    };
}

// Rebuild DOM indices after a court is removed (so id="match-N" stays accurate)
function rebuildMatchCardIndices() {
    const container = document.getElementById('matchContainer');
    container.innerHTML = '';
    StateStore.currentMatches.forEach((m, i) => {
        const tA = m.teams[0].map(n => findP(n)).filter(Boolean);
        const tB = m.teams[1].map(n => findP(n)).filter(Boolean);
        if (tA.length === 2 && tB.length === 2) {
            const cardEl = buildMatchCard(i, tA, tB, m.odds, m.startedAt);
            cardEl.classList.remove('card-entering'); // No animation on rebuild
            container.appendChild(cardEl);
            if (m.winnerTeamIndex !== null) {
                const boxes = cardEl.querySelectorAll('.team-box');
                if (boxes[m.winnerTeamIndex]) boxes[m.winnerTeamIndex].classList.add('selected');
            }
        }
    });
}

// Legacy alias for undo — rotates ALL courts at once
function rotateQueue() {
    StateStore.currentMatches.forEach(m => rotateCourtPlayers(m));
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

/**
 * Validates if matches can be generated and prepares the state and UI.
 * @returns {Array<object>|null} The pool of active players, or null if validation fails.
 */
function _prepareForMatchGeneration() {
    const activePool = StateStore.squad.filter(p => p.active);
    if (activePool.length < 4) {
        alert('Requires at least 4 active players.');
        return null;
    }

    initQueue();
    StateStore.set('currentMatches', []);
    document.getElementById('matchContainer').innerHTML = '';
    return activePool;
}

/**
 * Determines how many courts can be run based on available players.
 * @param {Array<object>} activePool - The pool of active players.
 * @returns {number} The number of courts to generate.
 */
function _determineCourtCount(activePool) {
    const maxCourts = Math.floor(activePool.length / 4);
    const courtCount = Math.min(StateStore.get('activeCourts'), maxCourts);

    if (StateStore.get('activeCourts') > maxCourts && typeof showSessionToast === 'function') {
        showSessionToast(
            `⚠️ Need ${activeCourts * 4} players for ${activeCourts} courts — only ${maxCourts} court${maxCourts !== 1 ? 's' : ''} generated with ${activePool.length} active players`
        );
    }
    return courtCount;
}

/**
 * Builds all match objects for the given number of courts.
 * @param {number} courtCount - The number of courts to generate matches for.
 * @returns {Array<object>} An array of data objects for rendering the match cards.
 */
function _createMatchesForCourts(courtCount) {
    const matchData = [];
    const assignedThisRound = new Set();

    for (let i = 0; i < courtCount; i++) {
        const p4 = pullNextFromQueue(assignedThisRound);
        if (p4.length < 4) break;

        p4.forEach(p => assignedThisRound.add(p.name));
        const match = buildMatchFromPlayers(p4);
        StateStore.currentMatches.push(match);

        const tA = match.teams[0].map(n => findP(n)).filter(Boolean);
        const tB = match.teams[1].map(n => findP(n)).filter(Boolean);
        matchData.push({ idx: i, tA, tB, odds: match.odds, startedAt: match.startedAt });
    }
    return matchData;
}

/**
 * Renders the UI and saves the state after matches are generated.
 * @param {Array<object>} matchData - Data for the match cards to be rendered.
 */
function _renderAndFinalizeGeneration(matchData) {
    renderAllMatchCards(matchData);
    renderQueueStrip();
    checkNextButtonState();
    renderSquad();
    saveToDisk();
    Haptic.bump();
}

function generateMatches() {
    const activePool = _prepareForMatchGeneration();
    if (!activePool) return;

    const courtCount = _determineCourtCount(activePool);
    const matchData = _createMatchesForCourts(courtCount);

    _renderAndFinalizeGeneration(matchData);
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
    const onCourt = new Set(StateStore.currentMatches.flatMap(m => m.teams.flat()));

    // Queue: active players not on court, in queue order
    const waiting = StateStore.playerQueue
        .map(name => StateStore.squad.find(p => p.name === name))
        .filter(p => p && p.active && !onCourt.has(p.name));

    if (waiting.length === 0) {
        strip.style.display = 'none';
        return;
    }

    // Only show NEXT badges when there are genuinely open court slots right now.
    // openSlots = courts that need players = (total spots) - (players already on court)
    // If all courts are busy, openSlots = 0 and nobody gets a badge.
    const openSlots = Math.max(0, StateStore.get('activeCourts') * 4 - onCourt.size);

    strip.style.display = 'block';
    strip.classList.remove('animating');

    strip.innerHTML = `
        <div class="queue-strip-header">
            <span class="queue-strip-title">⏳ Queue</span>
            <span class="queue-strip-count">${waiting.length} waiting</span>
        </div>
        <div class="queue-strip-list">
            ${waiting.map((p, idx) => `
                <div class="queue-item" draggable="true" data-name="${escapeHTML(p.name)}">
                    <span class="queue-pos">${idx + 1}</span>
                    ${Avatar.html(p.name)}
                    <span class="queue-name">${escapeHTML(p.name)}</span>
                    ${idx < openSlots ? '<span class="queue-next-badge">NEXT</span>' : ''}
                </div>
            `).join('')}
        </div>
    `;

    // Stagger queue items in
    requestAnimationFrame(() => {
        strip.classList.add('animating');
        strip.querySelectorAll('.queue-item').forEach((el, i) => {
            el.style.animationDelay = `${i * 40}ms`;
        });
    });
    setupQueueDragAndDrop();

}
// ---------------------------------------------------------------------------
// MATCH CARD RENDERING
// ---------------------------------------------------------------------------

function renderAllMatchCards(matchData) {
    const container = document.getElementById('matchContainer');
    container.innerHTML = ''; // Clear existing content

    const fragment = document.createDocumentFragment();
    matchData.forEach(({ idx, tA, tB, odds, startedAt }) => {
        const cardElement = buildMatchCard(idx, tA, tB, odds, startedAt);
        fragment.appendChild(cardElement);
    });
    container.appendChild(fragment);

    // Trigger staggered entrance animation
    requestAnimationFrame(() => {
        container.querySelectorAll('.card-entering').forEach((el, i) => {
            setTimeout(() => el.classList.remove('card-entering'), i * 80);
        });
    });
}

// Note: Other functions like _generateAndRenderNextMatchForCourt, rebuildMatchCardIndices, and confirmTeamBuilder
// should also be updated to use `appendChild` or `replaceWith(buildMatchCard(...))` instead of innerHTML/outerHTML.
function renderMatchCard(idx, tA, tB, odds) {
    const container = document.getElementById('matchContainer');
    container.appendChild(buildMatchCard(idx, tA, tB, odds));
}

function buildMatchCard(idx, tA, tB, odds, startedAt = Date.now()) {
    const template = document.getElementById('matchCardTemplate');
    if (!template) {
        console.error('Match Card Template not found in DOM!');
        return document.createElement('div'); // Return empty div to prevent crash
    }

    const card = template.content.cloneNode(true).firstElementChild;

    card.id = `match-${idx}`;
    card.dataset.started = startedAt;

    card.querySelector('.match-label').textContent = `Court ${idx + 1}`;

    if (odds && odds.length === 2) {
        const hA = odds[0] > odds[1] ? 'highlight' : '';
        const hB = odds[1] > odds[0] ? 'highlight' : '';
        const header = card.querySelector('.match-header');
        if (header) {
            header.insertAdjacentHTML('beforeend', `
                <div class="prob-container">
                    <div class="prob-pill ${hA}">${odds[0]}%</div>
                    <div class="prob-pill ${hB}">${odds[1]}%</div>
                </div>
            `);
        }
    }

    card.querySelector('.aura-share-btn').onclick = () => shareAuraPoster(idx);
    card.querySelector('.edit-teams-btn').onclick = () => openTeamBuilder(idx);

    const teamBoxes = card.querySelectorAll('.team-box');
    teamBoxes[0].querySelector('b').innerHTML = `${escapeHTML(tA[0].name)} <span class="amp">&amp;</span> ${escapeHTML(tA[1].name)}`;
    teamBoxes[0].onclick = () => setWinner(idx, 0);

    teamBoxes[1].querySelector('b').innerHTML = `${escapeHTML(tB[0].name)} <span class="amp">&amp;</span> ${escapeHTML(tB[1].name)}`;
    teamBoxes[1].onclick = () => setWinner(idx, 1);

    const nextRow = card.querySelector('.court-next-row');
    nextRow.id = `court-next-${idx}`;
    nextRow.querySelector('.court-timer').id = `timer-${idx}`;
    nextRow.querySelector('.court-next-btn').onclick = () => processCourtResult(idx);

    return card;
}

// ---------------------------------------------------------------------------
// WINNER SELECTION
// ---------------------------------------------------------------------------

function setWinner(mIdx, tIdx) {
    const boxes = document.querySelectorAll(`#match-${mIdx} .team-box`);
    boxes.forEach((box, i) => box.classList.toggle('selected', i === tIdx));
    StateStore.currentMatches[mIdx].winnerTeamIndex = tIdx;

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

    // Broadcast winner selection immediately so players see it on their feed.
    if (typeof dispatchWinSignals === 'function') dispatchWinSignals(mIdx);
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
    builderTeams    = StateStore.currentMatches[mIdx].teams.map(t => [...t]); // deep copy
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
    const m = StateStore.currentMatches[builderMatchIdx];

    // All names currently in this game
    const inGame = new Set([...builderTeams[0], ...builderTeams[1]]);

    // Sideline = active players NOT in any game at all
    const allInGames = new Set(StateStore.currentMatches.flatMap(match => match.teams.flat()));
    const sideline = StateStore.squad.filter(p =>
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
            <div class="builder-odds-bar ${hA}" style="width:${odds[0]}%">${odds[0]}%</div>
            <div class="builder-odds-bar ${hB}" style="width:${odds[1]}%">${odds[1]}%</div>
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
    StateStore.currentMatches[mIdx].teams = [
        builderTeams[0],
        builderTeams[1]
    ];
    StateStore.currentMatches[mIdx].odds = newOdds;
    StateStore.currentMatches[mIdx].winnerTeamIndex = null; // Reset winner since teams changed

    // Preserve the original start time so the timer doesn't reset
    const originalStartTime = StateStore.currentMatches[mIdx].startedAt;

    // Re-render just this card by replacing it in the DOM
    const cardEl = document.getElementById(`match-${mIdx}`);
    if (cardEl) {
        const newCardEl = buildMatchCard(mIdx, tAObjs, tBObjs, newOdds, originalStartTime);
        cardEl.replaceWith(newCardEl);
    } else {
        rebuildMatchCardIndices();
    }

    closeTeamBuilder();
    renderQueueStrip();
    checkNextButtonState();
    saveToDisk();
    // Broadcast the updated lineup immediately so players see the correct
    // team assignment without waiting for the DB postgres_changes round-trip.
    if (typeof broadcastGameState === 'function') broadcastGameState();
    Haptic.success();
}

// ---------------------------------------------------------------------------
// QUEUE DRAG & DROP
// ---------------------------------------------------------------------------

let _dragSrcEl = null;

function setupQueueDragAndDrop() {
    const items = document.querySelectorAll('.queue-item');
    items.forEach(item => {
        item.addEventListener('dragstart', handleDragStart);
        item.addEventListener('dragenter', handleDragEnter);
        item.addEventListener('dragover', handleDragOver);
        item.addEventListener('dragleave', handleDragLeave);
        item.addEventListener('drop', handleDrop);
        item.addEventListener('dragend', handleDragEnd);
    });
}

function handleDragStart(e) {
    this.style.opacity = '0.4';
    _dragSrcEl = this;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dataset.name);
}

function handleDragOver(e) {
    if (e.preventDefault) e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return false;
}

function handleDragEnter(e) {
    this.classList.add('queue-over');
}

function handleDragLeave(e) {
    this.classList.remove('queue-over');
}

function handleDrop(e) {
    if (e.stopPropagation) e.stopPropagation();
    const srcName = e.dataTransfer.getData('text/plain');
    const destName = this.dataset.name;
    if (srcName && destName && srcName !== destName) {
        reorderPlayerQueue(srcName, destName);
    }
    return false;
}

function handleDragEnd(e) {
    this.style.opacity = '1';
    document.querySelectorAll('.queue-item').forEach(item => {
        item.classList.remove('queue-over');
    });
}

function reorderPlayerQueue(srcName, destName) {
    const newQueue = [...StateStore.playerQueue];
    const srcIdx = newQueue.indexOf(srcName);
    if (srcIdx === -1) return;
    newQueue.splice(srcIdx, 1);
    const destIdx = newQueue.indexOf(destName);
    if (destIdx !== -1) newQueue.splice(destIdx, 0, srcName);
    else newQueue.push(srcName);
    StateStore.set('playerQueue', newQueue);
    
    renderQueueStrip();
    saveToDisk();
    if (typeof broadcastGameState === 'function') broadcastGameState();
    Haptic.success();
}