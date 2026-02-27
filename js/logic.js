// =============================================================================
// COURTSIDE PRO — logic.js  v2
// =============================================================================
// FIXES IN THIS VERSION:
//   #1/#7 — dispatchWinSignals called ONCE per round from processAndNext.
//            clearRoundDedup() called at the top of every new round so the
//            passport dedup set resets and Round 2 "Game 1" isn't blocked.
//   #10   — generateMatches Next Up ticker is built exclusively from the bench
//            pool (players NOT assigned to any court). The fallback that could
//            pull currently-playing players has been replaced with a safe fill
//            that only draws from active non-playing players.
//   #11   — builderSwapFromSideline now also restores waitRounds on the
//            outgoing player so they aren't unfairly penalised in the next
//            round's fairness sort after being swapped out.
// =============================================================================

// ---------------------------------------------------------------------------
// LOOKUP HELPER
// ---------------------------------------------------------------------------

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

        const snapshot = {
            squadSnapshot: squad.map(p => ({ ...p })),
            matches:       currentMatches.map(m => ({ ...m, teams: m.teams.map(t => [...t]) })),
            timestamp:     Date.now(),
        };
        roundHistory.push(snapshot);

        if (typeof archiveRoundToSupabase === 'function') archiveRoundToSupabase(snapshot);

        // FIX #1: dispatch signals ONCE here, at the canonical round-end point.
        // setWinner() deliberately does NOT call dispatchWinSignals to prevent
        // double-counting. This is the only place it fires.
        if (typeof dispatchWinSignals === 'function') {
            currentMatches.forEach((m, idx) => {
                if (m.winnerTeamIndex !== null) dispatchWinSignals(idx);
            });
        }

        applyELOResults();
        updateUndoButton();

        // FIX #7: clear the per-round passport dedup set AFTER signals are
        // dispatched but BEFORE generateMatches() starts the new round.
        // This allows "Game 1" in the next round to be recorded correctly.
        if (typeof PlayerMode !== 'undefined' && typeof PlayerMode.clearRoundDedup === 'function') {
            PlayerMode.clearRoundDedup();
        }
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
// FIX #10: Next Up ticker is built exclusively from the BENCH (sitting players)
// and never falls back to players who are actively assigned to a court.
// ---------------------------------------------------------------------------

function generateMatches() {
    const pool = squad.filter(p => p.active);
    if (pool.length < 4) {
        alert('Requires at least 4 active players.');
        return;
    }

    currentMatches = [];
    document.getElementById('matchContainer').innerHTML = '';

    // Increment waitRounds for everyone before selection
    pool.forEach(p => { p.waitRounds = (p.waitRounds || 0) + 1; });

    // Sort by fairness: most wait first, then fewest games, then random
    const available = [...pool].sort((a, b) => {
        const waitDiff = (b.waitRounds || 0) - (a.waitRounds || 0);
        if (waitDiff !== 0) return waitDiff;
        const gamesDiff = a.sessionPlayCount - b.sessionPlayCount;
        if (gamesDiff !== 0) return gamesDiff;
        return Math.random() - 0.5;
    });

    const courtCount = Math.floor(available.length / 4);
    const playing    = available.slice(0, courtCount * 4);
    const sitting    = available.slice(courtCount * 4);

    // Reset waitRounds for players who are about to play
    playing.forEach(p => { p.waitRounds = 0; });

    // FIX #10: Build Next Up ONLY from the bench (sitting players).
    // Track by squad index to prevent duplicates.
    // If the bench has fewer than 4 players, show what we have — do NOT
    // fall back to on-court players, which causes the "David bug" where
    // a playing player appears in the ticker.
    const benchPool = [...sitting].sort(
        (a, b) => (b.waitRounds || 0) - (a.waitRounds || 0) || a.sessionPlayCount - b.sessionPlayCount
    );

    const nextUpPicked = new Set();
    const nextUp = [];
    for (const p of benchPool) {
        const uid = squad.indexOf(p);
        if (!nextUpPicked.has(uid)) {
            nextUpPicked.add(uid);
            nextUp.push(p);
        }
        if (nextUp.length === 4) break;
    }
    // Show fewer than 4 if the bench is small — DO NOT include on-court players.
    updateNextUpTicker(nextUp);

    const matchData = [];
    for (let i = 0; i < courtCount; i++) {
        const p4 = playing.splice(0, 4);
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

    Haptic.tap();

    const winBox = boxes[tIdx];
    if (winBox) {
        const rect = winBox.getBoundingClientRect();
        const cx = rect.left + rect.width  / 2;
        const cy = rect.top  + rect.height / 2;
        Confetti.burst(cx, cy, 55);
    }

    checkNextButtonState();
    saveToDisk();
    // NOTE: dispatchWinSignals is NOT called here.
    // It fires exactly once from processAndNext() after all winners are confirmed.
}

// ---------------------------------------------------------------------------
// TEAM BUILDER
// ---------------------------------------------------------------------------

let builderMatchIdx  = null;
let builderTeams     = null;
let builderSelected  = null;

function openTeamBuilder(mIdx) {
    builderMatchIdx = mIdx;
    builderTeams    = currentMatches[mIdx].teams.map(t => [...t]);
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

function renderTeamBuilder() {
    const inGame   = new Set([...builderTeams[0], ...builderTeams[1]]);
    const allInGames = new Set(currentMatches.flatMap(match => match.teams.flat()));
    const sideline = squad.filter(p =>
        p.active && !allInGames.has(p.name)
    ).filter(p => !inGame.has(p.name));

    document.getElementById('builderGameLabel').innerText = `Game ${builderMatchIdx + 1}`;

    document.getElementById('builderTeamA').innerHTML = builderTeams[0].map(name => {
        const isSelected = builderSelected && builderSelected.name === name;
        return `<div class="builder-chip ${isSelected ? 'builder-selected' : ''}"
                     onclick="builderSelectPlayer(0, '${escapeHTML(name)}')">
                    ${escapeHTML(name)}
                </div>`;
    }).join('');

    document.getElementById('builderTeamB').innerHTML = builderTeams[1].map(name => {
        const isSelected = builderSelected && builderSelected.name === name;
        return `<div class="builder-chip ${isSelected ? 'builder-selected' : ''}"
                     onclick="builderSelectPlayer(1, '${escapeHTML(name)}')">
                    ${escapeHTML(name)}
                </div>`;
    }).join('');

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

function builderSelectPlayer(teamIdx, name) {
    if (builderSelected && builderSelected.name === name) {
        builderSelected = null;
    } else if (builderSelected && builderSelected.team !== teamIdx) {
        const otherName = builderSelected.name;
        const otherTeam = builderSelected.team;
        builderTeams[teamIdx]   = builderTeams[teamIdx].map(n => n === name ? otherName : n);
        builderTeams[otherTeam] = builderTeams[otherTeam].map(n => n === otherName ? name : n);
        builderSelected = null;
    } else {
        builderSelected = { team: teamIdx, name };
    }
    renderTeamBuilder();
}

// FIX #11: restore waitRounds on the outgoing player so they aren't
// deprioritised in the next round's fairness sort.
function builderSwapFromSideline(sidelineName) {
    if (!builderSelected) {
        document.querySelectorAll('.builder-chip:not(.bench)').forEach(el => {
            el.classList.add('builder-pulse');
            setTimeout(() => el.classList.remove('builder-pulse'), 600);
        });
        return;
    }

    const { team, name: outName } = builderSelected;

    const outPlayer = findP(outName);
    if (outPlayer) {
        outPlayer.sessionPlayCount = Math.max(0, outPlayer.sessionPlayCount - 1);
        // FIX #11: restore waitRounds so this player isn't penalised for being
        // swapped out — they should queue fairly in the next round.
        outPlayer.waitRounds = (outPlayer.waitRounds || 0) + 1;
    }

    const inPlayer = findP(sidelineName);
    if (inPlayer) {
        inPlayer.sessionPlayCount++;
        // The swapped-in player was on the bench; reset their waitRounds as if
        // they were selected normally by generateMatches.
        inPlayer.waitRounds = 0;
    }

    builderTeams[team] = builderTeams[team].map(n => n === outName ? sidelineName : n);
    builderSelected = null;
    renderTeamBuilder();
}

function builderShuffle() {
    const allFour = [...builderTeams[0], ...builderTeams[1]]
        .map(n => findP(n))
        .filter(Boolean);

    allFour.sort(() => Math.random() - 0.5);
    allFour.sort((a, b) => b.rating - a.rating);

    builderTeams = [
        [allFour[0].name, allFour[3].name],
        [allFour[1].name, allFour[2].name]
    ];
    builderSelected = null;
    renderTeamBuilder();
}

function confirmTeamBuilder() {
    const mIdx   = builderMatchIdx;
    const tAObjs = builderTeams[0].map(n => findP(n)).filter(Boolean);
    const tBObjs = builderTeams[1].map(n => findP(n)).filter(Boolean);

    if (tAObjs.length !== 2 || tBObjs.length !== 2) {
        alert('Each team needs exactly 2 players.');
        return;
    }

    const newOdds = calculateOdds(tAObjs, tBObjs);
    currentMatches[mIdx].teams = [
        builderTeams[0],
        builderTeams[1]
    ];
    currentMatches[mIdx].odds = newOdds;
    currentMatches[mIdx].winnerTeamIndex = null;

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