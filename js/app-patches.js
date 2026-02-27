// =============================================================================
// APP.JS PATCH — targeted fixes for bugs #8 and #14
// Apply these changes to the relevant functions in app.js
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// BUG #8 FIX — editPlayerName
// BEFORE (broken on iOS PWA — prompt() is silently blocked):
//   const newName = prompt('Edit Name:', p.name);
//   if (!newName || !newName.trim()) return;
//   ...
//
// AFTER — use the same inline DOM pattern used everywhere else in the app:
// ─────────────────────────────────────────────────────────────────────────────

function editPlayerName(playerIndex) {
    const p = squad[playerIndex];
    if (!p) return;

    // Find the player card element
    const cards = document.querySelectorAll('.player-card');
    const card  = cards[playerIndex];
    if (!card) return;

    const nameEl = card.querySelector('.player-name');
    if (!nameEl) return;

    // Build an inline edit field in place of the name text
    const prevName = p.name;
    const input    = document.createElement('input');
    input.type         = 'text';
    input.value        = prevName;
    input.className    = 'player-name-edit-input';
    input.maxLength    = 30;
    input.autocomplete = 'off';
    input.autocorrect  = 'off';
    input.autocapitalize = 'words';
    input.setAttribute('inputmode', 'text');

    const commit = () => {
        const newName = input.value.trim();
        input.replaceWith(nameEl);
        if (!newName || newName === prevName) return;

        p.name = newName;

        // Sync into any active matches
        currentMatches.forEach(m => {
            m.teams = m.teams.map(team => team.map(n => n === prevName ? newName : n));
        });

        // Sync into uuid map for online sessions
        const uuidMap = window._sessionUUIDMap || {};
        if (uuidMap[prevName]) {
            uuidMap[newName] = uuidMap[prevName];
            delete uuidMap[prevName];
            window._sessionUUIDMap = uuidMap;
        }

        renderSquad();
        renderSavedMatches();
        saveToDisk();

        // Broadcast rename to online session
        if (typeof broadcastNameUpdate === 'function' && window.isOnlineSession) {
            const uuid = (window._sessionUUIDMap || {})[newName] || null;
            broadcastNameUpdate(uuid, prevName, newName);
        }

        Haptic.success();
    };

    const cancel = () => {
        input.replaceWith(nameEl);
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
// BUG #14 FIX — renderStatsTab ('performance' section)
// BEFORE:
//   New players start at ELO 1200 and immediately appear as "Peak Performers"
//   because they haven't lost yet.
//
// AFTER:
//   Only players with at least 1 completed game are eligible for Peak Performer.
//   New players (games === 0) are shown in a separate "Unranked" group.
// ─────────────────────────────────────────────────────────────────────────────

function renderStatsTab(tab) {
    const container = document.getElementById('statsTabContent');
    if (!container) return;

    if (tab === 'performance') {
        const activePlayers = squad.filter(p => p.active);

        // FIX #14: only rank players who have actually played a game
        const ranked   = activePlayers.filter(p => (p.games || 0) > 0)
                                       .sort((a, b) => b.rating - a.rating);
        const unranked = activePlayers.filter(p => (p.games || 0) === 0);

        if (activePlayers.length === 0) {
            container.innerHTML = '<div class="stats-empty">No active players yet.</div>';
            return;
        }

        const topCount = Math.max(1, Math.ceil(ranked.length * 0.3));

        const renderPlayer = (p, rank) => {
            const wr   = p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0;
            const streakStr = p.streak > 1 ? ` 🔥${p.streak}` : '';
            return `
                <div class="stats-player-row">
                    ${Avatar.render(p.name, 32)}
                    <div class="stats-player-info">
                        <div class="stats-player-name">${escapeHTML(p.name)}${streakStr}</div>
                        <div class="stats-player-sub">${p.wins}W · ${p.games - p.wins}L · ${wr}% WR</div>
                    </div>
                    <div class="stats-player-elo">${Math.round(p.rating)}</div>
                    ${rank != null ? `<div class="stats-rank">#${rank}</div>` : ''}
                </div>`;
        };

        const peakHTML  = ranked.slice(0, topCount).map((p, i) => renderPlayer(p, i + 1)).join('');
        const rosterHTML = ranked.slice(topCount).map(p => renderPlayer(p, null)).join('');
        const unrankedHTML = unranked.map(p => `
            <div class="stats-player-row stats-player-unranked">
                ${Avatar.render(p.name, 32)}
                <div class="stats-player-info">
                    <div class="stats-player-name">${escapeHTML(p.name)}</div>
                    <div class="stats-player-sub">No games yet</div>
                </div>
                <div class="stats-player-elo" style="opacity:0.4">—</div>
            </div>`).join('');

        container.innerHTML = `
            ${ranked.length > 0 ? `
                <div class="stats-section-label">⚡ Peak Performers</div>
                ${peakHTML}
                ${rosterHTML.length > 0 ? `
                    <div class="stats-section-label" style="margin-top:12px">Active Roster</div>
                    ${rosterHTML}
                ` : ''}
            ` : ''}
            ${unranked.length > 0 ? `
                <div class="stats-section-label" style="margin-top:12px;opacity:0.5">Unranked (no games yet)</div>
                ${unrankedHTML}
            ` : ''}
        `;
        return;
    }

    // Other tabs (wins, winrate, streak) remain unchanged — they already
    // show 0 values for new players without artificially boosting their rank.
    if (tab === 'wins' || tab === 'winrate' || tab === 'streak') {
        const sorted = [...squad]
            .filter(p => p.active)
            .sort((a, b) => {
                if (tab === 'wins')    return b.wins - a.wins;
                if (tab === 'winrate') {
                    const wrA = a.games > 0 ? a.wins / a.games : 0;
                    const wrB = b.games > 0 ? b.wins / b.games : 0;
                    return wrB - wrA;
                }
                if (tab === 'streak') return (b.streak || 0) - (a.streak || 0);
                return 0;
            });

        container.innerHTML = sorted.map((p, i) => {
            const val = tab === 'wins'    ? `${p.wins}W`
                      : tab === 'winrate' ? (p.games > 0 ? Math.round((p.wins / p.games) * 100) + '%' : '—')
                      : tab === 'streak'  ? (p.streak > 0 ? `🔥 ${p.streak}` : '—')
                      : '';
            return `
                <div class="stats-player-row">
                    <div class="stats-rank">#${i + 1}</div>
                    ${Avatar.render(p.name, 32)}
                    <div class="stats-player-info">
                        <div class="stats-player-name">${escapeHTML(p.name)}</div>
                        <div class="stats-player-sub">${p.wins}W · ${p.games - p.wins}L · ${p.games} games</div>
                    </div>
                    <div class="stats-player-elo">${val}</div>
                </div>`;
        }).join('');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG #5/#19 FIX — Boot coordination
// Replace the window.onload + DOMContentLoaded race with a single guarded
// boot function. Drop this into the bottom of app.js, replacing any existing
// boot listeners.
// ─────────────────────────────────────────────────────────────────────────────

let _bootStarted = false;

async function bootApp() {
    if (_bootStarted) return; // idempotency guard — prevents double-boot
    _bootStarted = true;

    // 1. Restore persisted local state
    loadFromDisk();
    renderSquad();
    renderSavedMatches();
    updateUndoButton();
    checkNextButtonState();

    // 2. Kick off online session rejoining (host) or player mode boot
    const urlParams = new URLSearchParams(window.location.search);
    const role      = urlParams.get('role');
    const joinCode  = urlParams.get('join') || localStorage.getItem('cs_player_room_code') || null;

    if (role === 'player' || (joinCode && !localStorage.getItem('cs_room_code'))) {
        // Player mode
        const passport = Passport.init();
        SidelineView.show();
        await PlayerMode.boot(passport, joinCode || window._pendingJoinCode || null);
    } else {
        // Host mode — try to rejoin an existing session
        if (typeof tryAutoRejoin === 'function') await tryAutoRejoin();
    }

    // 3. Register service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
}

// Single entry point — use DOMContentLoaded only (drop window.onload usage)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootApp, { once: true });
} else {
    bootApp(); // DOM already ready (e.g. script loaded async/defer)
}
