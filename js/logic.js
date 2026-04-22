// =============================================================================
// COURTSIDE PRO — logic.js
// Responsibilities: Match generation, ELO calculation, match rendering,
//                  winner selection, round processing, team builder.
// Depends on: app.js (must be loaded before this file)
// =============================================================================

// ---------------------------------------------------------------------------
// LOOKUP HELPER
// ---------------------------------------------------------------------------

let _findPCache = new Map();
let _lastSquadForCache = null;

/** Finds a player object by UUID or Name. Returns undefined if not found. */
function findP(id) {
    if (!id) return undefined;

    // PERFORMANCE: Optimized incremental cache. Only rebuild if squad reference actually changes.
    if (_lastSquadForCache === StateStore.squad && _findPCache.has(id)) {
        return _findPCache.get(id);
    }

    // Rebuild cache
    _findPCache.clear();
    const squad = StateStore.squad;
    for (let i = 0; i < squad.length; i++) {
        const p = squad[i];
        if (p.uuid) _findPCache.set(p.uuid, p);
        // Map name only if UUID isn't already used as the key to prevent collisions
        if (p.name) _findPCache.set(p.name, p); 
    }
    _lastSquadForCache = squad;

    return _findPCache.get(id);
}

// ---------------------------------------------------------------------------
// ROUND PROCESSING
// ---------------------------------------------------------------------------

// ABOLISHED: ELO is no longer used. This function is now applyStatsForMatch.
// It updates wins, games, streaks, and form, but not ELO.
// The name is kept for now to minimize diff, but its purpose has changed.
// The `rating` field on players will become deprecated and eventually removed.

// ---------------------------------------------------------------------------
// PER-COURT ADVANCEMENT — fires when host taps "Next Game" on one court
// ---------------------------------------------------------------------------
/**
 * Creates a snapshot of the current state for the undo history.
 * @param {object} finishedMatch - The match that just ended.
 * @param {Array} achievements - New achievements earned in this match.
 * @param {Array} preSquad - The squad state BEFORE the match was processed.
 * @param {Array} preQueue - The queue state BEFORE the match was processed.
 */
function _createRoundSnapshot(finishedMatch, achievements = [], preSquad, preQueue) {
    finishedMatch.endedAt = Date.now();
    const snapshot = {
        squadSnapshot: preSquad || JSON.parse(JSON.stringify(StateStore.squad)),
        matches:       JSON.parse(JSON.stringify(StateStore.currentMatches)),
        queueSnapshot: preQueue || [...StateStore.playerQueue],
        timestamp:     Date.now(),
        achievements:  achievements,
    };
    StateStore.set('roundHistory', [...StateStore.roundHistory, snapshot]);
    if (typeof archiveRoundToSupabase === 'function') archiveRoundToSupabase(snapshot);
}

/**
 * Applies stats, checks achievements, signals results, and rotates players for a finished match.
 * @param {object} match - The completed match object.
 * @param {number} mIdx - The index of the match.
 * @param {number} timestamp - The unique resolution timestamp.
 */
function _processFinishedMatch(match, mIdx, timestamp) {
    match.resolvedAt = timestamp;
    applyStatsForMatch(match); // FIX: Call renamed function to prevent crash
    if (typeof dispatchWinSignals === 'function') {
        dispatchWinSignals(mIdx, true, timestamp); // skipBroadcast = true
    }
    _recordMatchStats(match, timestamp);
}

/**
 * Records participation stats and history for a completed match.
 * Moved here from buildMatchFromPlayers to ensure accuracy.
 */
function _recordMatchStats(match, timestamp = Date.now()) {
    const tA = match.teams[0].map(u => findP(u)).filter(Boolean);
    const tB = match.teams[1].map(u => findP(u)).filter(Boolean);
    const allPlayers = [...tA, ...tB];

    allPlayers.forEach(p => {
        p.sessionPlayCount++;
        p.acknowledged = false; // Clear "I'm coming" status once game is recorded
        
        // Performance Lab: Record match for history list using UUIDs
        const isTeamA = tA.includes(p);
        const opponents = isTeamA ? tB : tA;
        const winIdx = match.winnerTeamIndex;
        const isWin = winIdx !== null && winIdx === (isTeamA ? 0 : 1);
        
        let partnerUUID = null;
        // Determine partner UUID if it's a doubles match
        if (isTeamA && tA.length === 2) { // Doubles on Team A
            partnerUUID = tA.find(tp => tp !== p)?.uuid || tA.find(tp => tp !== p)?.name;
        } else if (!isTeamA && tB.length === 2) { // Doubles on Team B
            partnerUUID = tB.find(tp => tp !== p)?.uuid || tB.find(tp => tp !== p)?.name;
        }

        p.matchHistory = p.matchHistory || [];
        p.matchHistory.unshift({ win: isWin, oppUUIDs: opponents.map(o => o.uuid || o.name), partnerUUID: partnerUUID, time: timestamp });
        if (p.matchHistory.length > 10) p.matchHistory.pop();
    });

    const addHistory = (p, teammate, opponents) => {
        p.teammateHistory = p.teammateHistory || {};
        p.opponentHistory = p.opponentHistory || {};
        if (teammate && teammate.uuid) {
            p.teammateHistory[teammate.uuid] = (p.teammateHistory[teammate.uuid] || 0) + 1;
        }
        opponents.forEach(o => {
            if (o.uuid) {
                p.opponentHistory[o.uuid] = (p.opponentHistory[o.uuid] || 0) + 1;
            }
        });
    };

    // Doubles (2v2) logic
    if (tA.length === 2) {
        addHistory(tA[0], tA[1], tB);
        addHistory(tA[1], tA[0], tB);
    }
    if (tB.length === 2) {
        addHistory(tB[0], tB[1], tA);
        addHistory(tB[1], tB[0], tA);
    }
}

/**
 * Handles the case where there are not enough players for the next match on a court.
 * @param {number} mIdx - The index of the court/match being removed.
 */
function _handleInsufficientPlayersForNextMatch(mIdx) {
    const updatedMatches = [...StateStore.currentMatches];
    updatedMatches.splice(mIdx, 1);
    StateStore.set('currentMatches', updatedMatches);
    
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
    const updatedMatches = [...StateStore.currentMatches];
    updatedMatches[mIdx] = newMatch;
    StateStore.set('currentMatches', updatedMatches);

    next4.forEach(p => p.acknowledged = false);

    const tA = newMatch.teams[0].map(u => findP(u)).filter(Boolean);
    const tB = newMatch.teams[1].map(u => findP(u)).filter(Boolean);
    const cardEl = document.getElementById(`match-${mIdx}`);
    if (cardEl) {
        const newCardEl = buildMatchCard(mIdx, tA, tB, newMatch.startedAt, newMatch.storyBadges);
        newCardEl.classList.add('card-replace');
        newCardEl.classList.remove('card-entering');
        cardEl.replaceWith(newCardEl);
    } else {
        rebuildMatchCardIndices();
    }
}

/**
 * Finalizes the court result update by refreshing UI, saving state, and broadcasting.
 * @param {number} lastResolvedTS - The timestamp of the match that just finished.
 * @param {Array<string>} playerUUIDs - UUIDs of players involved in the match for differential sync.
 */
function _finalizeCourtResultUpdate(lastResolvedTS = Date.now(), playerUUIDs = null) {
    renderQueueStrip();
    checkNextButtonState();
    updateUndoButton();
    if (typeof renderSquad === 'function') renderSquad();
    // Trigger sync for both matches and squad since stats/history updated
    StateStore.setState({
        currentMatches: [...StateStore.currentMatches],
        squad: [...StateStore.squad]
    });

    // Connectivity Improvement: Force immediate sync to cloud on match resolution.
    // Performance: Pass the UUIDs of the 4 players to perform a differential sync,
    // significantly reducing bandwidth and database load during match transitions.
    if (window.isOnlineSession && window.isOperator && typeof pushStateToSupabase === 'function') {
        pushStateToSupabase(true, playerUUIDs);
    }
    if (typeof broadcastGameState === 'function') broadcastGameState(true, lastResolvedTS);
    Haptic.bump();
}

async function processCourtResult(mIdx) {
    const match = StateStore.currentMatches[mIdx];
    if (!match || match.winnerTeamIndex === null) {
        alert('Select a winner first.');
        return;
    }

    // 1. Capture state for Undo snapshot BEFORE changes are applied
    const preSquad = JSON.parse(JSON.stringify(StateStore.squad));
    const preQueue = [...StateStore.playerQueue];

    const resolutionTS = Date.now();

    // 2. Process finished match and record stats
    _processFinishedMatch(match, mIdx, resolutionTS); // This now calls applyStatsForMatch

    // Performance: Capture UUIDs of the players involved for differential sync
    const matchPlayerUUIDs = match.teams.flat().map(n => findP(n)?.uuid).filter(Boolean);

     // Connectivity Durability: Trigger a state save and broadcast immediately.
    // This ensures that if the host reloads or achievement processing is slow,
    // the player stats are already persisted and visible to spectators.
        StateStore.set('squad', [...StateStore.squad]);
    // 3. Award achievements and capture results for the batch sync
    const newlyUnlocked = await checkAndAwardAchievements(match, StateStore.squad);

    // 4. Create snapshot including the achievements and pre-change state
    _createRoundSnapshot(match, newlyUnlocked, preSquad, preQueue);

    // --- UX IMPROVEMENT: Wait-Round Badges ---
    // Increment waitRounds for everyone currently waiting in the queue (not on ANY court)
    const allPlaying = new Set(StateStore.currentMatches.flatMap(m => m.teams.flat()));
    StateStore.playerQueue.forEach(uuid => {
        if (!allPlaying.has(uuid)) {
            const p = findP(uuid);
            if (p) p.waitRounds = (p.waitRounds || 0) + 1;
        }
    });

    // 5. Rotate players for the next round
    rotateCourtPlayers(match);

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

    // Reset waitRounds for the players entering the court
    next4.forEach(p => p.waitRounds = 0);

    _generateAndRenderNextMatchForCourt(mIdx, next4);
    _finalizeCourtResultUpdate(resolutionTS, matchPlayerUUIDs);
}

// ---------------------------------------------------------------------------
// FIRST START — fires the first time host presses "Start Session"
// ---------------------------------------------------------------------------

function processAndNext() {
    // If courts are already live, this button is disabled — do nothing
    if (StateStore.currentMatches.length > 0) return;
    generateMatches();
}
window.processAndNext = processAndNext;
function applyStatsForMatch(m) { // Renamed from applyELOForMatch
    if (m.winnerTeamIndex === null) return;
    const winIdx  = m.winnerTeamIndex;
    const loseIdx = winIdx === 0 ? 1 : 0;

    const winners = m.teams[winIdx].map(u => findP(u)).filter(Boolean); // Player objects
    const losers  = m.teams[loseIdx].map(u => findP(u)).filter(Boolean); // Player objects
    if (!winners.length || !losers.length) return; // Should not happen in 2v2

    // Update Winners
    if (winners.length === 2) {
        const [p1, p2] = winners;
        // Only record partnership stats if BOTH players have real Passports (UUIDs)
        if (p1.uuid && p2.uuid) {
            p1.partnerStats = p1.partnerStats || {};
            p2.partnerStats = p2.partnerStats || {};
            
            const updateStat = (p, partner) => {
                 const s = p.partnerStats[partner.uuid] || { wins: 0, games: 0, name: partner.name };
                 s.games++; s.wins++;
                 s.name = partner.name;
                 p.partnerStats[partner.uuid] = s;
            };
            updateStat(p1, p2);
            updateStat(p2, p1);
        }
    }
    winners.forEach(p => {
        // No ELO update: only update wins, games, streak, form
        p.wins++; p.games++; p.streak++;
        p.form = (p.form || []).concat('W').slice(-5);
    });
    // Update Losers
    if (losers.length === 2) {
        const [p1, p2] = losers;
        // Guard: Guest players do not contribute to partnership "Social Proof"
        if (p1.uuid && p2.uuid) {
            p1.partnerStats = p1.partnerStats || {};
            p2.partnerStats = p2.partnerStats || {};
            const updateLoser = (p, partner) => {
                const s = p.partnerStats[partner.uuid] || { wins: 0, games: 0, name: partner.name };
                s.games++;
                s.name = partner.name;
                p.partnerStats[partner.uuid] = s;
            };
            updateLoser(p1, p2);
            updateLoser(p2, p1);
        }
    }
    losers.forEach(p => {
        // No ELO update: only update games, reset streak, update form
        p.games++; p.streak = 0;
        p.form = (p.form || []).concat('L').slice(-5);
    });
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
    const activeSquad = StateStore.squad.filter(p => p.active);
    const activeUUIDs = new Set(activeSquad.map(p => p.uuid).filter(Boolean));
    const activeNames = new Set(activeSquad.map(p => p.name.toLowerCase()));

    // 1. Process current queue: Resolve names to UUIDs and filter out inactive
    let currentQueue = (StateStore.playerQueue || []).map(item => {
        const p = StateStore.squad.find(x => x.uuid === item || x.name.toLowerCase() === String(item).toLowerCase());
        if (!p || !p.active) return null;
        return p.uuid || p.name;
    }).filter(Boolean);

    // 2. Add active players not yet in queue (by UUID or Name)
    const inQueueUUIDs = new Set(currentQueue.filter(id => activeUUIDs.has(id)));
    const inQueueNames = new Set(currentQueue.map(id => id.toLowerCase()));
    
    const newcomers = activeSquad.filter(p => {
        if (p.uuid) return !inQueueUUIDs.has(p.uuid);
        return !inQueueNames.has(p.name.toLowerCase());
    }).map(p => p.uuid || p.name);

    const finalQueue = [...new Set([...currentQueue, ...newcomers])];
    return StateStore.set('playerQueue', finalQueue);
}

// ---------------------------------------------------------------------------
// ROTATE QUEUE — called after every round with results.
// Finished players leave the front of the queue and rejoin at the back:
//   losers first (shorter wait), then winners (earned rest).
// ---------------------------------------------------------------------------

// Rotate a single court's players back into the queue
function rotateCourtPlayers(m) {
    const allUUIDs = m.teams.flat();
    let newQueue = StateStore.playerQueue;
    // Remove from wherever they currently sit
    newQueue = newQueue.filter(u => !allUUIDs.includes(u));

    if (m.winnerTeamIndex === null) {
        newQueue.push(...allUUIDs);
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

function determineStoryBadges(teamA, teamB) {
    const badges = new Set();
    const allPlayers = [...teamA, ...teamB];

    // Badge: Fresh Blood (anyone with 0 completed games)
    if (allPlayers.some(p => p.games === 0)) {
        badges.add('🌱 Fresh Blood');
    }

    // Badge: Rematch (if any player on Team A has played any player on Team B)
    let isRematch = false;
    for (const pA of teamA) {
        for (const pB of teamB) {
            if (pA.opponentHistory && pA.opponentHistory[pB.uuid] > 0) {
                isRematch = true;
                break;
            }
        }
        if (isRematch) break;
    }
    if (isRematch) badges.add('⚔️ Rematch');

    // Badge: Dynamic Duo (if teammates have played together 2+ times)
    if (teamA.length === 2 && teamA[0].teammateHistory && teamA[0].teammateHistory[teamA[1].uuid] >= 2) badges.add('⚡ Dynamic Duo');
    if (teamB.length === 2 && teamB[0].teammateHistory && teamB[0].teammateHistory[teamB[1].uuid] >= 2) badges.add('⚡ Dynamic Duo');

    return Array.from(badges);
}

// Score a single team split — lower = fresher matchup
function scoreSplit(tA, tB) {
    // Pairing Accuracy: Uses player UUIDs for history lookups. This ensures variety 
    // scoring remains consistent even if players rename themselves mid-session.
    const tm  = (a, b) => (a && b && b.uuid) ? (a.teammateHistory  || {})[b.uuid] || 0 : 0;
    const opp = (a, b) => (a && b && b.uuid) ? (a.opponentHistory  || {})[b.uuid] || 0 : 0;

    if (tA.length === 2 && tB.length === 2) {
        return (
            tm(tA[0], tA[1]) * 2 + tm(tB[0], tB[1]) * 2 +
            opp(tA[0], tB[0]) + opp(tA[0], tB[1]) +
            opp(tA[1], tB[0]) + opp(tA[1], tB[1])
        );
    }

    // Fallback for non-doubles configurations
    let totalScore = 0;
    tA.forEach(pa => {
        tB.forEach(pb => {
            totalScore += opp(pa, pb);
        });
    });
    return totalScore;
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
    for (let a = 0; a < n - 3; a++) {
        for (let b = a + 1; b < n - 2; b++) {
            for (let c = b + 1; c < n - 1; c++) {
                for (let d = c + 1; d < n; d++) {
                    out.push([arr[a], arr[b], arr[c], arr[d]]);
                    if (out.length > 500) return out; 
                }
            }
        }
    }
    return out;
}

// Get the candidate pool for one court — front of the queue, excluding
// players already assigned to another court this round.
function getCandidatePool(onCourt) {
    const pool     = [];
    const poolSet  = new Set();
    const poolSize = 4 * POOL_FACTOR;

    // Authoritative Sync: Ensure the queue strictly contains IDs present in the current squad.
    // We use a case-insensitive name fallback for legacy/guest compatibility.
    const squadIds = new Set();
    StateStore.squad.forEach(p => { if (p.uuid) squadIds.add(p.uuid); squadIds.add(p.name.toLowerCase()); });
    
    const sanitizedQueue = StateStore.playerQueue.filter(id => 
        squadIds.has(String(id).toLowerCase())
    );
    if (sanitizedQueue.length !== StateStore.playerQueue.length) {
               StateStore.playerQueue = sanitizedQueue;
    }

    for (const uuid of sanitizedQueue) {
        if (pool.length >= poolSize) break;
        if (onCourt.has(String(uuid))) continue;
        if (poolSet.has(uuid))  continue;
        const p = findP(uuid);
        if (!p || !p.active) continue;
        pool.push(p);
        poolSet.add(uuid);
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
    // If we have 4 or fewer eligible players, there's no choice to make.
    if (pool.length <= 4) return pool;
    
    // Pick best group logic
    return pickBestGroup(pool);
}

// Build a match object from 4 player objects, applying best-split pairing.
function buildMatchFromPlayers(p4) {
    // Randomize player order for team splitting
    p4.sort(() => Math.random() - 0.5);

    // All 3 team splits — pick the freshest
    const splits = [
        { tA: [p4[0], p4[3]], tB: [p4[1], p4[2]] },
        { tA: [p4[0], p4[2]], tB: [p4[1], p4[3]] },
        { tA: [p4[0], p4[1]], tB: [p4[2], p4[3]] },
    ];

    // Splits are now chosen based purely on variety (variety engine/scoreSplit).
    // This ensures the freshest possible matchup within the group of four.
    splits.sort((a, b) => scoreSplit(a.tA, a.tB) - scoreSplit(b.tA, b.tB));

    const { tA, tB } = splits[0];
    const storyBadges = determineStoryBadges(tA, tB);

    return {
        teams:           [tA.map(p => p.uuid || p.name), tB.map(p => p.uuid || p.name)],
        winnerTeamIndex: null,
        storyBadges,
        startedAt: Date.now(),
    };
}

// Rebuild DOM indices after a court is removed (so id="match-N" stays accurate)
function rebuildMatchCardIndices() {
    const matchData = StateStore.currentMatches.map((m, i) => ({
        idx: i,
        tA: m.teams[0].map(u => findP(u)).filter(Boolean),
        tB: m.teams[1].map(u => findP(u)).filter(Boolean),
        startedAt: m.startedAt,
        storyBadges: m.storyBadges,
        winnerTeamIndex: m.winnerTeamIndex
    }));
    
    renderAllMatchCards(matchData, true); // Pass true to skip entry animations
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
    const needed = 4;
    if (activePool.length < needed) {
        alert(`Requires at least ${needed} active players.`);
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
    const perCourt = 4;
    const maxCourts = Math.floor(activePool.length / perCourt);
    const courtCount = Math.min(StateStore.get('activeCourts'), maxCourts);

    if (StateStore.get('activeCourts') > maxCourts && typeof showSessionToast === 'function') {
        showSessionToast(
            `⚠️ Need ${StateStore.get('activeCourts') * perCourt} players — only ${maxCourts} court${maxCourts !== 1 ? 's' : ''} generated`
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
        const players = pullNextFromQueue(assignedThisRound);
        if (players.length < 4) break;

        players.forEach(p => {
            assignedThisRound.add(p.uuid);
            p.waitRounds = 0; // Reset for starting players
        });
        const match = buildMatchFromPlayers(players);
        StateStore.currentMatches.push(match);

        const tA = match.teams[0].map(n => findP(n)).filter(Boolean);
        const tB = match.teams[1].map(n => findP(n)).filter(Boolean);
        matchData.push({ idx: i, tA, tB, startedAt: match.startedAt, storyBadges: match.storyBadges });
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
    StateStore.set('currentMatches', [...StateStore.currentMatches]);
    if (typeof broadcastGameState === 'function') broadcastGameState(true);
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
    const onCourt = new Set(StateStore.currentMatches.flatMap(m => m.teams.flat().map(id => String(id))));

    // Normalize queue IDs before rendering to ensure host/legacy names resolve to UUIDs
    initQueue();

    // Queue: active players not on court, in queue order
    const waiting = StateStore.playerQueue
        // Lookup by UUID or Name to prevent "disappearing" players during ID transitions
        .map(id => StateStore.squad.find(p => p.uuid === id || p.name.toLowerCase() === String(id).toLowerCase()))
        .filter(p => p && p.active && !onCourt.has(String(p.uuid || p.name)));

    if (waiting.length === 0) {
        strip.style.display = 'none';
        return;
    }

    // Only show NEXT badges when there are genuinely open court slots right now.
    // openSlots = courts that need players = (total spots) - (players already on court)
    // If all courts are busy, openSlots = 0 and nobody gets a badge.
    strip.style.display = 'block';
    strip.classList.remove('animating');

    const openSlots = Math.max(0, StateStore.get('activeCourts') * 4 - onCourt.size);
    const currentQueueUUIDs = new Set();
    const fragment = document.createDocumentFragment();
    const existingQueueItems = new Map();
    strip.querySelectorAll('.queue-item').forEach(item => {
        const uuid = item.dataset.uuid;
        if (uuid) existingQueueItems.set(uuid, item);
    });

    strip.innerHTML = `
        <div class="queue-strip-header">
            <span class="queue-strip-title">⏳ Queue</span>
            <span class="queue-strip-count">${waiting.length} waiting</span>
        </div>
        <div class="queue-strip-list">
        </div>
    `;

    const queueListContainer = strip.querySelector('.queue-strip-list');

    waiting.forEach((p, idx) => {
        currentQueueUUIDs.add(p.uuid);
        const itemContent = `
            <span class="queue-pos">${idx + 1}</span>
            ${Avatar.html(p.name, p.spiritAnimal)}
            <span class="queue-name">${escapeHTML(p.name)}</span>
            ${idx < openSlots ? '<span class="queue-next-badge">NEXT</span>' : ''}
        `;
        const itemClasses = `queue-item ${idx < openSlots ? 'queue-item-next' : ''}`;

        let item = existingQueueItems.get(p.uuid);

        if (item) {
            if (item.className !== itemClasses) item.className = itemClasses;
            if (item.innerHTML.trim() !== itemContent.trim()) item.innerHTML = itemContent;
            existingQueueItems.delete(p.uuid);
        } else {
            const newItem = document.createElement('div');
            newItem.className = itemClasses;
            newItem.dataset.uuid = p.uuid;
            newItem.innerHTML = itemContent;
            newItem.setAttribute('draggable', 'true');
            fragment.appendChild(newItem);
        }
    });

    existingQueueItems.forEach(item => item.remove()); // Remove items no longer in the queue
    queueListContainer.appendChild(fragment); // Append new/updated items

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

function renderAllMatchCards(matchData, skipAnimation = false) {
    const container = document.getElementById('matchContainer');
    container.innerHTML = ''; // Clear existing content

    const fragment = document.createDocumentFragment();
    matchData.forEach(({ idx, tA, tB, startedAt, storyBadges, winnerTeamIndex }) => {
        const cardElement = buildMatchCard(idx, tA, tB, startedAt, storyBadges);
        if (skipAnimation) cardElement.classList.remove('card-entering');
        
        if (winnerTeamIndex !== null && winnerTeamIndex !== undefined) {
            const boxes = cardElement.querySelectorAll('.team-box');
            if (boxes[winnerTeamIndex]) boxes[winnerTeamIndex].classList.add('selected');
        }
        fragment.appendChild(cardElement);
    });
    container.appendChild(fragment);

    // Trigger staggered entrance animation
    if (!skipAnimation) requestAnimationFrame(() => {
        container.querySelectorAll('.card-entering').forEach((el, i) => {
            setTimeout(() => el.classList.remove('card-entering'), i * 80);
        });
    });
}

// Note: Other functions like _generateAndRenderNextMatchForCourt, rebuildMatchCardIndices, and confirmTeamBuilder
// should also be updated to use `appendChild` or `replaceWith(buildMatchCard(...))` instead of innerHTML/outerHTML.
function renderMatchCard(idx, tA, tB) {
    const container = document.getElementById('matchContainer');
    container.appendChild(buildMatchCard(idx, tA, tB));
}

function buildMatchCard(idx, tA, tB, startedAt = Date.now(), storyBadges = []) {
    const template = document.getElementById('matchCardTemplate');
    if (!template) {
        console.error('Match Card Template not found in DOM!');
        return document.createElement('div'); // Return empty div to prevent crash
    }

    const card = template.content.cloneNode(true).firstElementChild;

    card.id = `match-${idx}`; 
    card.dataset.started = startedAt;

    const courtNames = StateStore.get('courtNames') || {};
    const courtName = courtNames[idx] || `Court ${idx + 1}`;
    const labelEl = card.querySelector('.match-label'); // This element already has the onclick
    labelEl.innerHTML = `<span class="court-name-text">${escapeHTML(courtName)}</span><span class="edit-court-icon">✏️</span>`;
    labelEl.onclick = () => openCourtRename(idx);

    const header = card.querySelector('.match-header');
    if (header && storyBadges && storyBadges.length > 0) {
        header.insertAdjacentHTML('beforeend', `<div class="match-story-badges">${storyBadges.map(b => `<span class="story-badge">${escapeHTML(b)}</span>`).join('')}</div>`);
    }

    card.querySelector('.aura-share-btn').onclick = () => shareAuraPoster(idx);
    card.querySelector('.edit-teams-btn').onclick = () => openTeamBuilder(idx);

    // Dynamic render for 1 or 2 players per team
    const renderTeam = (team) => team.map(p => escapeHTML(p.name || 'Unknown')).join(' <span class="amp">&amp;</span> ');
    const teamBoxes = card.querySelectorAll('.team-box');
    teamBoxes[0].querySelector('b').innerHTML = renderTeam(tA);
    teamBoxes[0].onclick = () => setWinner(idx, 0);

    teamBoxes[1].querySelector('b').innerHTML = renderTeam(tB);
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
    StateStore.set('currentMatches', StateStore.currentMatches);
}

// ---------------------------------------------------------------------------
// TEAM BUILDER
// ---------------------------------------------------------------------------

// Working state for the builder — separate from currentMatches until confirmed
let builderMatchIdx  = null;  // which game we're editing
let builderTeams     = null;  // [teamA_names[], teamB_names[]]
let builderSelected  = null;  // { team: 0|1, name: string } — player being swapped
let builderOriginalUUIDs = null; // Track original players to handle queue re-insertion

/**
 * Opens the team builder modal for a given match.
 * Deep-copies team names so edits don't touch currentMatches until confirmed.
 */
function openTeamBuilder(mIdx) {
    builderMatchIdx = mIdx;
    builderTeams    = StateStore.currentMatches[mIdx].teams.map(t => [...t]); // deep copy UUIDs
    builderOriginalUUIDs = StateStore.currentMatches[mIdx].teams.flat();
    builderSelected = null;
    renderTeamBuilder();
    document.getElementById('teamBuilderModal').style.display = 'flex';
}
window.openTeamBuilder = openTeamBuilder;
window.closeTeamBuilder = closeTeamBuilder;

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

    // --- UX IMPROVEMENT: Live Odds in Team Builder ---
    const tAObjs = builderTeams[0].map(u => findP(u)).filter(Boolean);
    const tBObjs = builderTeams[1].map(u => findP(u)).filter(Boolean);

    // All names currently in this game
    const inGame = new Set([...builderTeams[0], ...builderTeams[1]]);

    // IMPROVEMENT: Sort sideline by actual Queue order so host knows who is "Next Up"
    const allInGames = new Set(StateStore.currentMatches.flatMap(match => match.teams.flat()));
    
    const sideline = StateStore.playerQueue
        .map(id => findP(id))
        .filter(p => 
            p && p.active && 
            (!allInGames.has(p.uuid) || inGame.has(p.uuid)) && 
            !builderTeams[0].includes(p.uuid) && 
            !builderTeams[1].includes(p.uuid)
        );

    document.getElementById('builderGameLabel').innerText = `Game ${builderMatchIdx + 1}`;

    // Render Team A
    document.getElementById('builderTeamA').innerHTML = builderTeams[0].map(uuid => {
        const isSelected = builderSelected && builderSelected.uuid === uuid;
        const p = findP(uuid);
        return `<div class="builder-chip ${isSelected ? 'builder-selected' : ''}"
                     onclick="builderSelectPlayer(0, '${uuid}')">
                    ${escapeHTML(p?.name || 'Unknown')}
                </div>`;
    }).join('');

    // Render Team B
    document.getElementById('builderTeamB').innerHTML = builderTeams[1].map(uuid => {
        const isSelected = builderSelected && builderSelected.uuid === uuid;
        const p = findP(uuid);
        return `<div class="builder-chip ${isSelected ? 'builder-selected' : ''}"
                     onclick="builderSelectPlayer(1, '${uuid}')">
                    ${escapeHTML(p?.name || 'Unknown')}
                </div>`;
    }).join('');

    // Render sideline bench
    const sidelineEl = document.getElementById('builderSideline');
    if (sideline.length > 0) {
        sidelineEl.innerHTML = `
            <div class="builder-section-label">Waiting Queue — tap to swap in</div>
            <div class="builder-bench">
                ${sideline.map((p, idx) => `
                    <div class="builder-chip bench ${builderSelected ? 'bench-ready' : ''}"
                         onclick="builderSwapFromSideline('${p.uuid}')">
                        <span style="opacity:0.5; margin-right:4px;">#${idx + 1}</span>
                        ${escapeHTML(p.name || 'Unknown')}
                    </div>
                `).join('')}
            </div>
        `;
    } else {
        sidelineEl.innerHTML = '<div class="builder-section-label" style="opacity:0.4;">No players on sideline</div>';
    }

}

/**
 * Selects a player from a team for swapping.
 * If a player from the OTHER team is already selected → swap them.
 * If same team → deselect (toggle).
 * If sideline player was selected first, this clears that and selects in-game player.
 */
function builderSelectPlayer(teamIdx, uuid) {
    if (builderSelected && builderSelected.uuid === uuid) {
        // Toggle off — deselect
        builderSelected = null;
    } else if (builderSelected && builderSelected.team !== teamIdx) {
        // Selected player from opposite team → swap positions
        const otherUUID = builderSelected.uuid;
        const otherTeam = builderSelected.team;

        // Swap: remove UUID from teamIdx, add otherUUID. Remove otherUUID from otherTeam, add UUID.
        builderTeams[teamIdx]  = builderTeams[teamIdx].map(u => u === uuid ? otherUUID : u);
        builderTeams[otherTeam] = builderTeams[otherTeam].map(u => u === otherUUID ? uuid : u);
        builderSelected = null;
    } else {
        // Select this player
        builderSelected = { team: teamIdx, uuid };
    }
    renderTeamBuilder();
}

/**
 * Swaps a sideline player into the game, replacing the currently selected in-game player.
 * If no in-game player is selected yet, shows a subtle prompt.
 */
function builderSwapFromSideline(sidelineUUID) {
    if (!builderSelected) {
        // No in-game player chosen yet — flash all in-game chips to signal "pick one first"
        document.querySelectorAll('.builder-chip:not(.bench)').forEach(el => {
            el.classList.add('builder-pulse');
            setTimeout(() => el.classList.remove('builder-pulse'), 600);
        });
        return;
    }

    const { team, uuid: outUUID } = builderSelected;

    // FIX: sessionPlayCount represents COMPLETED games. 
    // We should not decrement/increment it here because _recordMatchStats 
    // handles it atomically when the match actually ends.
    const outPlayer = findP(outUUID);
    if (outPlayer) {
        outPlayer.consecutiveGames = 0; // They are no longer playing consecutively
    }

    const inPlayer = findP(sidelineUUID);
    if (inPlayer) {
        inPlayer.waitRounds = 0; // Reset wait rounds as they are entering a match
        inPlayer.acknowledged = false; // Reset "I'm coming" status for the new assignment
    }

    // Swap in the team array
    builderTeams[team] = builderTeams[team].map(u => u === outUUID ? sidelineUUID : u);
    builderSelected = null;
    renderTeamBuilder();
}

/**
 * Shuffles only this game's 4 players into new balanced teams.
 * Keeps the same 4 players, re-runs the snake-draft logic.
 */
function builderShuffle() {
    const allPlayers = [...builderTeams[0], ...builderTeams[1]]
        .map(u => findP(u))
        .filter(Boolean);

    // Shuffle randomly first
    allPlayers.sort(() => Math.random() - 0.5); // Randomize for fairness within the builder

        // Use the main engine to ensure the shuffle respects Variety settings
        const tempMatch = buildMatchFromPlayers(allPlayers);
        builderTeams = tempMatch.teams;
    }
    builderSelected = null;
    renderTeamBuilder();

window.confirmTeamBuilder = confirmTeamBuilder;

/**
 * Confirms the team builder changes, updates currentMatches,
 * recalculates odds, and re-renders the affected match card.
 */
function confirmTeamBuilder() {
    const mIdx = builderMatchIdx;
    const tAObjs = builderTeams[0].map(u => findP(u)).filter(Boolean);
    const tBObjs = builderTeams[1].map(u => findP(u)).filter(Boolean);

    // QUEUE MANAGEMENT: Identify players who were removed from the match
    const newUUIDs = [...builderTeams[0], ...builderTeams[1]];
    const removedUUIDs = builderOriginalUUIDs.filter(id => !newUUIDs.includes(id));

    if (removedUUIDs.length > 0) {
        // Move replaced players to the front of the queue
        const currentQueue = StateStore.playerQueue.filter(id => !removedUUIDs.includes(id));
        StateStore.set('playerQueue', [...removedUUIDs, ...currentQueue]);
        showSessionToast(`${removedUUIDs.length} player(s) moved to front of queue`);
    }

    // Validate balanced teams (Doubles 2v2 only)
    const total = tAObjs.length + tBObjs.length;
    if (tAObjs.length !== tBObjs.length || total !== 4) {
        alert(`Teams must be balanced (2v2). Currently ${tAObjs.length} vs ${tBObjs.length}.`);
        return;
    }

    // Update the match in state
    StateStore.currentMatches[mIdx].teams = [
        builderTeams[0],
        builderTeams[1]
    ];
    StateStore.currentMatches[mIdx].winnerTeamIndex = null; // Reset winner since teams changed

    const newBadges = determineStoryBadges(tAObjs, tBObjs);
    StateStore.currentMatches[mIdx].storyBadges = newBadges;

    // Preserve the original start time so the timer doesn't reset
    const originalStartTime = StateStore.currentMatches[mIdx].startedAt;

    // Re-render just this card by replacing it in the DOM
    const cardEl = document.getElementById(`match-${mIdx}`);
    if (cardEl) {
        const newCardEl = buildMatchCard(mIdx, tAObjs, tBObjs, originalStartTime, newBadges);
        cardEl.replaceWith(newCardEl);
    } else {
        rebuildMatchCardIndices();
    }

    closeTeamBuilder();
    renderQueueStrip();

    // Refresh host insights (Director Hub) to reflect the new waiting priorities
    if (typeof renderSquad === 'function') renderSquad();

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
    e.dataTransfer.setData('text/plain', this.dataset.uuid);
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
    const srcUUID = e.dataTransfer.getData('text/plain');
    const destUUID = this.dataset.uuid;
    if (srcUUID && destUUID && srcUUID !== destUUID) {
        reorderPlayerQueue(srcUUID, destUUID);
    }
    return false;
}

function handleDragEnd(e) {
    this.style.opacity = '1';
    document.querySelectorAll('.queue-item').forEach(item => {
        item.classList.remove('queue-over');
    });
}

function reorderPlayerQueue(srcUUID, destUUID) {
    const newQueue = [...StateStore.playerQueue];
    const srcIdx = newQueue.indexOf(srcUUID);
    if (srcIdx === -1) return;
    newQueue.splice(srcIdx, 1);
    const destIdx = newQueue.indexOf(destUUID);
    if (destIdx !== -1) newQueue.splice(destIdx, 0, srcUUID);
    else newQueue.push(srcUUID);
    StateStore.set('playerQueue', newQueue);
    
    renderQueueStrip();
    saveToDisk();
    if (typeof broadcastGameState === 'function') broadcastGameState();
    Haptic.success();
}

// ---------------------------------------------------------------------------
// CROSS-COURT SWAP LOGIC
// ---------------------------------------------------------------------------

function swapActivePlayers(uuidA, uuidB) {
    let locA = null, locB = null;

    // 1. Locate both players in current matches
    StateStore.currentMatches.forEach((m, mIdx) => {
        m.teams.forEach((team, tIdx) => {
            const pIdx = team.indexOf(uuidA);
            if (pIdx !== -1) locA = { mIdx, tIdx, pIdx };
            
            const pIdxB = team.indexOf(uuidB);
            if (pIdxB !== -1) locB = { mIdx, tIdx, pIdx: pIdxB };
        });
    });

    if (!locA || !locB) return false;

    // 2. Perform Swap in State
    const updatedMatches = [...StateStore.currentMatches];
    updatedMatches[locA.mIdx].teams[locA.tIdx][locA.pIdx] = uuidB;
    updatedMatches[locB.mIdx].teams[locB.tIdx][locB.pIdx] = uuidA;
    
    StateStore.set('currentMatches', updatedMatches);

    // 3. Update affected matches (recalc odds, reset winner, re-render)
    const updateMatch = (idx) => {
        const m = StateStore.currentMatches[idx];
        m.winnerTeamIndex = null;
        const tA = m.teams[0].map(n => findP(n)).filter(Boolean);
        const tB = m.teams[1].map(n => findP(n)).filter(Boolean);
        const cardEl = document.getElementById(`match-${idx}`);
        if (cardEl) {
            const newCardEl = buildMatchCard(idx, tA, tB, m.startedAt, m.storyBadges);
            cardEl.replaceWith(newCardEl);
        }
    };

    updateMatch(locA.mIdx);
    if (locA.mIdx !== locB.mIdx) updateMatch(locB.mIdx);

    return true;
}

// Expose for app.js
window.swapActivePlayers = swapActivePlayers;