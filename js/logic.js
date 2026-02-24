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
    const rA = (teamA[0].rating + teamA[1].rating) / 2;
    const rB = (teamB[0].rating + teamB[1].rating) / 2;
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
        applyELOResults();
        updateUndoButton();
    }
    generateMatches();
}

function applyELOResults() {
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

function generateMatches() {
    const pool = squad.filter(p => p.active);
    if (pool.length < 4) {
        alert('Requires at least 4 active players.');
        return;
    }

    currentMatches = [];
    document.getElementById('matchContainer').innerHTML = '';

    const available = [...pool].sort(
        (a, b) => a.sessionPlayCount - b.sessionPlayCount || Math.random() - 0.5
    );
    const courtCount = Math.floor(available.length / 4);

    const matchData = [];
    for (let i = 0; i < courtCount; i++) {
        const p4 = available.splice(0, 4);
        p4.forEach(p => p.sessionPlayCount++);
        p4.sort((a, b) => b.rating - a.rating);

        const tA   = [p4[0], p4[3]];
        const tB   = [p4[1], p4[2]];
        const odds = calculateOdds(tA, tB);

        currentMatches.push({
            teams: [tA.map(p => p.name), tB.map(p => p.name)],
            winnerTeamIndex: null,
            odds
        });
        matchData.push({ idx: i, tA, tB, odds });
    }

    renderAllMatchCards(matchData);
    checkNextButtonState();
    renderSquad();
    saveToDisk();
    // Haptic: medium bump to signal round is live
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
        p.active &&
        !allInGames.has(p.name) ||
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