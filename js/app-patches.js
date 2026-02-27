// =============================================================================
// APP-PATCHES.JS — targeted fixes applied on top of app.js
// BUG #8  — editPlayerName: inline DOM rename, no prompt()
// BUG #14 — renderStatsTab: new players excluded from Peak Performers
//
// NOTE: bootApp() and the DOMContentLoaded listener that were previously
// in this file have been removed. app.js initApp() is the single boot
// entry point. Having two boot sequences was causing session creation to fail.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// BUG #8 FIX — editPlayerName (inline DOM, no prompt)
// Overrides the version in app.js.
// ─────────────────────────────────────────────────────────────────────────────

function editPlayerName() {
    const p = squad[selectedPlayerIndex];
    if (!p) return;

    const oldName = p.name;

    const chips  = document.querySelectorAll('.player-chip');
    const chip   = chips[selectedPlayerIndex];
    if (!chip) return;

    const nameEl = chip.querySelector('.chip-name');
    if (!nameEl) return;

    const input = document.createElement('input');
    input.type           = 'text';
    input.value          = oldName;
    input.className      = 'player-name-edit-input';
    input.maxLength      = 30;
    input.autocomplete   = 'off';
    input.autocorrect    = 'off';
    input.autocapitalize = 'words';
    input.setAttribute('inputmode', 'text');

    const commit = () => {
        const newName = input.value.trim();
        input.replaceWith(nameEl);
        if (!newName || newName === oldName) return;

        p.name = newName;

        currentMatches.forEach(m => {
            m.teams = m.teams.map(team => team.map(n => n === oldName ? newName : n));
        });

        const uuidMap = window._sessionUUIDMap || {};
        if (uuidMap[oldName]) {
            uuidMap[newName] = uuidMap[oldName];
            delete uuidMap[oldName];
            window._sessionUUIDMap = uuidMap;
        }

        closeMenu();
        renderSquad();
        renderSavedMatches();
        saveToDisk();

        if (typeof broadcastNameUpdate === 'function' && window.isOnlineSession) {
            const uuid = p.uuid || (window._sessionUUIDMap || {})[newName] || null;
            broadcastNameUpdate(uuid, oldName, newName);
        }

        Haptic.success();
    };

    const cancel = () => {
        input.replaceWith(nameEl);
        closeMenu();
    };

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);

    nameEl.replaceWith(input);
    input.select();
    input.focus();
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG #14 FIX — renderStatsTab
// New players (games === 0) never appear in Peak Performers.
// ─────────────────────────────────────────────────────────────────────────────

function renderStatsTab(tab) {
    const content = document.getElementById('overlayContent');

    const tabs = `
        <div class="stats-tabs">
            <button class="stats-tab ${tab === 'performance' ? 'active' : ''}"
                onclick="renderStatsTab('performance')">Performance</button>
            <button class="stats-tab ${tab === 'history' ? 'active' : ''}"
                onclick="renderStatsTab('history')">History</button>
            <button class="stats-tab"
                onclick="renderLeaderboardTab()">Leaderboard</button>
        </div>
    `;

    if (tab === 'performance') {
        const activePlayers = squad.filter(p => p.active);
        const ranked   = activePlayers.filter(p => (p.games || 0) > 0)
                                       .sort((a, b) => b.rating - a.rating);
        const unranked = activePlayers.filter(p => (p.games || 0) === 0);

        if (activePlayers.length === 0) {
            content.innerHTML = tabs + '<div class="stats-empty">No active players yet.</div>';
            return;
        }

        const topCount  = Math.max(1, Math.ceil(ranked.length * 0.3));
        const winRate   = p => p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0;

        const renderGroup = (label, list) => {
            if (list.length === 0) return '';
            const cards = list.map(p => {
                const sqIdx = squad.indexOf(p);
                return `
                    <div class="stats-card" onclick="openPlayerCard(${sqIdx})" style="cursor:pointer;">
                        <div class="stats-name">${escapeHTML(p.name)}${p.streak >= 3 ? ' 🔥' : ''}</div>
                        <div class="stats-meta">${p.wins}W · ${p.games}G · ${winRate(p)}% WR</div>
                    </div>`;
            }).join('');
            return `
                <div class="stats-group">
                    <div class="stats-header">${label}</div>
                    <div class="stats-grid">${cards}</div>
                </div>`;
        };

        const unrankedHTML = unranked.length > 0 ? `
            <div class="stats-group">
                <div class="stats-header" style="opacity:0.5">Unranked (no games yet)</div>
                <div class="stats-grid">
                    ${unranked.map(p => {
                        const sqIdx = squad.indexOf(p);
                        return `<div class="stats-card" onclick="openPlayerCard(${sqIdx})" style="cursor:pointer; opacity:0.6;">
                            <div class="stats-name">${escapeHTML(p.name)}</div>
                            <div class="stats-meta">No games yet</div>
                        </div>`;
                    }).join('')}
                </div>
            </div>` : '';

        content.innerHTML = tabs
            + renderGroup('⚡ Peak Performers', ranked.slice(0, topCount))
            + renderGroup('Active Roster', ranked.slice(topCount))
            + unrankedHTML;

    } else {
        // History tab
        if (roundHistory.length === 0) {
            content.innerHTML = tabs + `
                <div style="text-align:center; padding:40px 0; color:var(--text-muted); font-size:0.85rem;">
                    No rounds played yet this session.
                </div>`;
            return;
        }

        const rounds = [...roundHistory].reverse().map((round, i) => {
            const roundNum = roundHistory.length - i;
            const games = round.matches.map((m, gi) => {
                const winIdx  = m.winnerTeamIndex;
                const loseIdx = winIdx === 0 ? 1 : 0;
                const winners = m.teams[winIdx]?.join(' & ') || '?';
                const losers  = m.teams[loseIdx]?.join(' & ') || '?';
                return `
                    <div class="history-game">
                        <div class="history-game-label">Game ${gi + 1}</div>
                        <div class="history-matchup">
                            <span class="history-winner">${escapeHTML(winners)}</span>
                            <span class="history-vs">def.</span>
                            <span class="history-loser">${escapeHTML(losers)}</span>
                        </div>
                    </div>`;
            }).join('');

            return `
                <div class="history-round">
                    <div class="history-round-label">Round ${roundNum}</div>
                    ${games}
                </div>`;
        }).join('');

        content.innerHTML = tabs + `<div class="history-list">${rounds}</div>`;
    }
}