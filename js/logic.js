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

function processAndNext() {
    if (currentMatches.length > 0) {
        if (!currentMatches.every(m => m.winnerTeamIndex !== null)) {
            alert('Operations Hold: Please select winners for all active games.');
            return;
        }

        // Snapshot state BEFORE applying ELO — needed for undo
        const snapshot = {
            squadSnapshot: squad.map(p => ({ ...p })),
            matches:       currentMatches.map(m => ({ ...m, teams: m.teams.map(t => [...t]) })),
            timestamp:     Date.now(),
        };
        roundHistory.push(snapshot);

        // Archive to Supabase match_history for weekly leaderboard
        if (typeof archiveRoundToSupabase === 'function') archiveRoundToSupabase(snapshot);

        // MATCH_RESOLVED: re-dispatch signals at Next Round time.
        // setWinner fires signals on winner selection, but processAndNext
        // is the canonical "round is over" moment. This is the guaranteed
        // delivery point — all player passports record their stats here.
        if (typeof dispatchWinSignals === 'function') {
            currentMatches.forEach((m, idx) => {
                if (m.winnerTeamIndex !== null) dispatchWinSignals(idx);
            });
        }

        applyELOResults();
        updateUndoButton();
    }
    generateMatches();
}

function applyELOResults() {
    // Players sitting out this round gain a wait round (handled in generateMatches)
    currentMatches.forEach(m => {
        const winIdx  = m.winnerTeamIndex;
        const loseIdx = winIdx === 0 ? 1 : 0;

        const winners = m.teams[winIdx].map(n => findP(n)).filter(Boolean);
        const losers  = m.teams[loseIdx].map(n => findP(n)).filter(Boolean);

        if (winners.length === 0 || losers.length === 0) return;

        const winAvg  = winners.reduce((sum, p) => sum + p.rating, 0) / winners.length;
        const loseAvg = losers.reduce((sum, p) => sum + p.rating, 0) / losers.length;
        const sift    = calculateELOSift(winAvg, loseAvg);

        winners.forEach(p => {
            p.rating += sift;
            p.wins++;
            p.games++;
            p.streak++;
        });
        losers.forEach(p => {
            p.rating = Math.max(800, p.rating - sift);
            p.games++;
            p.streak = 0;
        });
    });
}

// ---------------------------------------------------------------------------
// MATCH GENERATION
// ---------------------------------------------------------------------------

/**
 * FAIRNESS ENGINE — generateMatches()
 *
 * CONSECUTIVE-GAME FATIGUE (new):
 *   A player who has played 3+ rounds in a row is automatically placed on
 *   a mandatory 1-round rest (p.forcedRest = true). They rejoin the eligible
 *   pool next round. This prevents one person dominating every court slot
 *   when the group is just large enough to field multiple games.
 *   forcedRest is cleared as soon as they sit a round out.
 *
 * CROSS-COURT UNIQUENESS GUARANTEE (new):
 *   The `assignedToGame` Set is the single source of truth for who is already
 *   slotted into a game this round. Every court's 4 players are drawn from
 *   the sorted eligible list in strict first-come order, so a player can
 *   never appear in Game 1 AND Game 2 simultaneously.
 *
 * PRIORITY ORDER (unchanged):
 *   1. forcedRest players sit out this round entirely (skipped in selection)
 *   2. Longest wait (highest waitRounds — rounds sitting out)
 *   3. Fewest games played this session (sessionPlayCount)
 *   4. Slight random shuffle to prevent predictability
 *   Teams are then balanced by ELO (snake draft: 1&4 vs 2&3).
 */
function generateMatches() {
    // ── 1. Build the eligible pool ─────────────────────────────────────────
    // "active" = host hasn't manually rested them.
    const pool = squad.filter(p => p.active);
    if (pool.length < 4) {
        alert('Requires at least 4 active players.');
        return;
    }

    currentMatches = [];
    document.getElementById('matchContainer').innerHTML = '';

    // ── 2. LATE-JOINER CATCH-UP THROTTLE ──────────────────────────────────
    // Problem: a player who joins mid-session can play 3+ games back-to-back
    // and leapfrog everyone else's game count before others get a fair turn.
    //
    // Rule: force a 1-round rest ONLY when BOTH conditions are true:
    //   a) The player has played 3+ consecutive rounds without a break, AND
    //   b) Their sessionPlayCount is strictly above the group average —
    //      meaning they are genuinely ahead of the pack, not just part of
    //      the normal rotation everyone else is also going through.
    //
    // A founding member who plays every round alongside everyone else will
    // never be above average, so they are never throttled.
    // A late joiner who plays 3 in a row while others have only played 1-2
    // will be above average, triggering exactly one forced rest to let the
    // field catch up.

    const CONSEC_THRESHOLD = 3; // consecutive games before eligibility check

    // Calculate group average sessionPlayCount for the active pool
    const avgPlayCount = pool.reduce((sum, p) => sum + (p.sessionPlayCount || 0), 0) / pool.length;

    pool.forEach(p => {
        // If they sat out last round, reset their consecutive streak
        if ((p.waitRounds || 0) > 0) {
            p.consecutiveGames = 0;
            p.forcedRest       = false; // served their rest — eligible again
        }
    });

    // ── 3. Increment waitRounds for everyone — playing will reset it ───────
    pool.forEach(p => { p.waitRounds = (p.waitRounds || 0) + 1; });

    // ── 4. Split into eligible vs forced-rest ─────────────────────────────
    // A player gets forcedRest only if they are BOTH on a 3+ game streak AND
    // ahead of the group average. Players at or below average are never
    // throttled, regardless of how many consecutive games they've played.
    pool.forEach(p => {
        if (p.forcedRest) return; // already flagged from last round — leave it
        const onStreak  = (p.consecutiveGames || 0) >= CONSEC_THRESHOLD;
        const aheadOfAvg = (p.sessionPlayCount || 0) > avgPlayCount;
        if (onStreak && aheadOfAvg) p.forcedRest = true;
    });

    const eligible   = pool.filter(p => !p.forcedRest);
    const forcedOut  = pool.filter(p =>  p.forcedRest);

    // Need at least 4 eligible to run even one game; otherwise clear all rests
    // (graceful fallback so the app never deadlocks on small groups)
    const runningPool = eligible.length >= 4 ? eligible : pool;
    if (eligible.length < 4 && eligible.length < pool.length) {
        // Not enough eligible players — lift forced rests and try again
        pool.forEach(p => { p.forcedRest = false; p.consecutiveGames = 0; });
    }

    // ── 5. Sort eligible pool by fairness priority ─────────────────────────
    const sorted = [...runningPool].sort((a, b) => {
        const waitDiff  = (b.waitRounds || 0) - (a.waitRounds || 0);
        if (waitDiff !== 0) return waitDiff;
        const gamesDiff = a.sessionPlayCount - b.sessionPlayCount;
        if (gamesDiff !== 0) return gamesDiff;
        return Math.random() - 0.5;
    });

    // ── 6. Assign players to courts — UNIQUENESS GUARANTEED ────────────────
    // Build `playing` first using a name-keyed Set so duplicate squad entries
    // (possible when applyRemoteState sets squad from remote data without a
    // dupe check) are silently skipped. courtCount is derived from
    // playing.length AFTER the loop — never from sorted.length — so it is
    // always an exact multiple of 4 and playingQueue.splice(0,4) never yields
    // fewer than 4 items, preventing the undefined.name crash on line 270.
    const assignedToGame = new Set(); // name-keyed: one slot per unique name
    const playing        = [];

    for (const p of sorted) {
        if (!p || !p.name) continue;                   // skip corrupt entries
        if (assignedToGame.has(p.name)) continue;      // skip name duplicates
        playing.push(p);
        assignedToGame.add(p.name);
    }

    // courtCount derived from actual unique players collected, not sorted.length
    const courtCount = Math.floor(playing.length / 4);
    // Trim playing to the exact multiple of 4 courts can use
    playing.splice(courtCount * 4);

    // Everyone not selected sits out this round
    const sitting = runningPool.filter(p => p && !assignedToGame.has(p.name));

    // ── 7. Update tracking stats for players who WILL play ─────────────────
    playing.forEach(p => {
        p.waitRounds       = 0;
        p.consecutiveGames = (p.consecutiveGames || 0) + 1;
    });

    // Re-compute average AFTER incrementing sessionPlayCount (happens in step 9)
    // so the threshold check uses the correct post-round counts.
    // We do a look-ahead: sessionPlayCount will be +1 for playing players.
    const avgAfter = pool.reduce((sum, p) => {
        const count = (p.sessionPlayCount || 0) + (playing.includes(p) ? 1 : 0);
        return sum + count;
    }, 0) / pool.length;

    // Flag players who are about to go ahead of the average AND have hit the
    // consecutive streak — they'll sit next round.
    playing.forEach(p => {
        const projectedCount = (p.sessionPlayCount || 0) + 1;
        const onStreak       = p.consecutiveGames >= CONSEC_THRESHOLD;
        const aheadOfAvg     = projectedCount > avgAfter;
        p.forcedRest = onStreak && aheadOfAvg;
    });

    // Players sitting out or on forced rest: reset their consecutive streak
    // since they are NOT playing this round.
    forcedOut.forEach(p => {
        p.consecutiveGames = 0;
        p.forcedRest       = false; // served their rest — eligible next round
    });
    sitting.forEach(p => {
        p.consecutiveGames = 0;
        p.forcedRest       = false;
    });

    // ── 8. "Next Up" ticker ─────────────────────────────────────────────────
    // 4 UNIQUE players from bench, by priority. Index-based dedup prevents
    // the "David bug" (same player appearing twice in the ticker).
    const benchPool = [...sitting, ...forcedOut].sort(
        (a, b) => (b.waitRounds || 0) - (a.waitRounds || 0) || a.sessionPlayCount - b.sessionPlayCount
    );
    const nextUpPicked = new Set();
    const nextUp       = [];
    for (const p of benchPool) {
        const uid = squad.indexOf(p);
        if (!nextUpPicked.has(uid)) {
            nextUpPicked.add(uid);
            nextUp.push(p);
        }
        if (nextUp.length === 4) break;
    }
    // If bench has fewer than 4, fill from the playing pool tail
    if (nextUp.length < 4) {
        for (const p of [...playing].reverse()) {
            const uid = squad.indexOf(p);
            if (!nextUpPicked.has(uid)) {
                nextUpPicked.add(uid);
                nextUp.push(p);
            }
            if (nextUp.length === 4) break;
        }
    }
    updateNextUpTicker(nextUp);

    // ── 9. Build match cards ────────────────────────────────────────────────
    // Deep-copy `playing` so splice doesn't mutate the original array.
    const playingQueue = [...playing];
    const matchData    = [];

    for (let i = 0; i < courtCount; i++) {
        const p4 = playingQueue.splice(0, 4);
        // Safety net: if splice returned fewer than 4 (should never happen
        // after the courtCount fix above, but guards against any future edge
        // case), skip this court rather than crash with undefined.name.
        if (p4.length < 4 || p4.some(p => !p)) continue;
        p4.forEach(p => p.sessionPlayCount++);

        // Snake draft ELO balance: sort by rating desc, pair 1&4 vs 2&3
        p4.sort((a, b) => b.rating - a.rating);

        const tA   = [p4[0], p4[3]];
        const tB   = [p4[1], p4[2]];
        const odds = calculateOdds(tA, tB);

        currentMatches.push({
            teams:           [tA.map(p => p.name), tB.map(p => p.name)],
            winnerTeamIndex: null,
            odds,
        });
        matchData.push({ idx: i, tA, tB, odds });
    }

    renderAllMatchCards(matchData);
    checkNextButtonState();
    renderSquad();
    saveToDisk();
    Haptic.bump();
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
                <span class="match-label">Game ${idx + 1}</span>
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

    // Haptic: short tap on winner select
    Haptic.tap();

    // Confetti: burst from the center of the winning team-box
    const winBox = boxes[tIdx];
    if (winBox) {
        const rect = winBox.getBoundingClientRect();
        const cx = rect.left + rect.width  / 2;
        const cy = rect.top  + rect.height / 2;
        Confetti.burst(cx, cy, 55);
    }

    checkNextButtonState();
    saveToDisk();
    // NOTE: dispatchWinSignals is intentionally NOT called here.
    // It fires exactly once from processAndNext() after all winners are set.
    // Calling it here too would double-count every win.
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