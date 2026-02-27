// =============================================================================
// COURTSIDE PRO — app.js
// Responsibilities: State management, UI rendering, player management,
//                  overlays, menus, persistence.
// Depends on: logic.js (loaded after this file)
// =============================================================================

// ---------------------------------------------------------------------------
// GLOBAL DECLARATIONS — must be at the very top so every function in this
// file and every inline onclick handler can reference these names without a
// ReferenceError, even before initApp() has filled them with real values.
//
// passport  — the player's identity object ({playerUUID, playerName, …})
//             Mirrors the data in localStorage under 'cs_player_passport'.
//             Kept in sync: write localStorage first, then update this ref.
//
// inviteQR  — alias for the InviteQR object defined in passport.js.
//             Assigned in initApp() after passport.js has been parsed.
//             HTML onclick="inviteQR.show(…)" safely resolves to it.
//
// supabase  — reserved for a future Supabase JS client instance.
//             Currently the app uses raw fetch; this slot prevents a
//             ReferenceError if any code path checks `if (supabase)`.
// ---------------------------------------------------------------------------
let passport  = null;
let inviteQR  = null;
let supabase  = null;

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------
let squad = [];
let currentMatches = [];
let roundHistory = [];          // array of completed round snapshots for history + undo
let previousRoundSnapshot = null; // snapshot before last round for undo
let selectedPlayerIndex = null;
let pressTimer = null;
let isLongPress = false;

// ---------------------------------------------------------------------------
// PERSISTENCE
// ---------------------------------------------------------------------------

function saveToDisk() {
    localStorage.setItem('cs_pro_vault', JSON.stringify({ squad, currentMatches, roundHistory }));
}

function loadFromDisk() {
    const saved = localStorage.getItem('cs_pro_vault');
    if (saved) {
        try {
            const data = JSON.parse(saved);
            squad          = data.squad        || [];
            roundHistory   = data.roundHistory || [];
            currentMatches = (data.currentMatches || []).filter(m => {
                return m.teams.flat().every(name => squad.find(p => p.name === name));
            });
            renderSquad();
            renderSavedMatches();
        } catch (e) {
            console.error('CourtSide: Failed to parse saved data.', e);
            squad          = [];
            currentMatches = [];
            roundHistory   = [];
        }
    }
    checkNextButtonState();
    updateUndoButton();
}

/**
 * Re-renders match cards from saved state.
 * Extracted from loadFromDisk for clarity.
 */
function renderSavedMatches() {
    if (currentMatches.length === 0) return;
    const container = document.getElementById('matchContainer');
    container.innerHTML = '';
    currentMatches.forEach((m, i) => {
        const tAObjects = m.teams[0].map(n => findP(n));
        const tBObjects = m.teams[1].map(n => findP(n));
        // findP is safe here because we filtered invalid matches in loadFromDisk
        renderMatchCard(i, tAObjects, tBObjects, m.odds);
        if (m.winnerTeamIndex !== null) {
            const boxes = document.querySelectorAll(`#match-${i} .team-box`);
            if (boxes[m.winnerTeamIndex]) {
                boxes[m.winnerTeamIndex].classList.add('selected');
            }
        }
    });
}

// ---------------------------------------------------------------------------
// PLAYER MANAGEMENT
// ---------------------------------------------------------------------------

function addPlayer() {
    const el = document.getElementById('playerName');
    const name = el.value.trim();
    if (!name) return;
    if (squad.find(p => p.name.toLowerCase() === name.toLowerCase())) {
        // Duplicate check is case-insensitive
        el.value = '';
        return;
    }
    squad.push({
        name,
        active: true,
        wins: 0,
        games: 0,
        streak: 0,
        sessionPlayCount: 0,
        rating: 1200
    });
    el.value = '';
    renderSquad();
    checkNextButtonState();
    saveToDisk();
}

function editPlayerName() {
    const p = squad[selectedPlayerIndex];
    const oldName = p.name; // capture BEFORE rename
    const newName = prompt('Edit Name:', p.name);
    if (newName && newName.trim()) {
        p.name = newName.trim();
        // Update name references in currentMatches using oldName
        currentMatches.forEach(m => {
            m.teams = m.teams.map(team =>
                team.map(n => (n === oldName ? p.name : n))
            );
        });
        closeMenu();
        renderSquad();
        renderSavedMatches();
        saveToDisk();
    }
}

function deletePlayer() {
    if (!confirm('Remove this player?')) return;
    const removed     = squad[selectedPlayerIndex];
    const removedName = removed.name;
    const removedUUID = removed.uuid || null;

    squad.splice(selectedPlayerIndex, 1);
    currentMatches = currentMatches.filter(m => !m.teams.flat().includes(removedName));

    closeMenu();
    renderSquad();
    const container = document.getElementById('matchContainer');
    container.innerHTML = '';
    renderSavedMatches();
    checkNextButtonState();
    saveToDisk();

    // Notify the removed player's screen immediately
    if (isOnlineSession && typeof _broadcast === 'function') {
        _broadcast('player_removed', { playerName: removedName, playerUUID: removedUUID });
    }
}

function toggleRestingState() {
    squad[selectedPlayerIndex].active = !squad[selectedPlayerIndex].active;
    closeMenu();
    renderSquad();
    checkNextButtonState();
    saveToDisk();
}

// ---------------------------------------------------------------------------
// RENDERING
// ---------------------------------------------------------------------------

function renderSquad() {
    const container = document.getElementById('squadList');
    const chips = squad.map((p, i) => `
        <div class="player-chip ${p.active ? 'active' : 'resting'}"
             onmousedown="startPress(${i})"
             onmouseup="endPress(${i})"
             ontouchstart="startPress(${i})"
             ontouchend="endPress(${i})"
             oncontextmenu="return false;">
            ${Avatar.html(p.name)}
            <span class="chip-name">${escapeHTML(p.name)}${!p.active ? ' ☕' : ''}${p.streak >= 4 ? ' 🔥' : ''}</span>
        </div>
    `);
    container.innerHTML = chips.join('');
    updateSideline();
}

function updateSideline() {
    const activeThisRound = new Set();
    currentMatches.forEach(m => m.teams.flat().forEach(n => activeThisRound.add(n)));
    const idle = squad.filter(p => p.active && !activeThisRound.has(p.name));
    document.getElementById('restingList').innerHTML = idle
        .map(p => `
            <div class="player-chip active sideline-chip" data-name="${escapeHTML(p.name)}">
                ${Avatar.html(p.name)}
                <span class="chip-name" style="font-size:0.72rem;">${escapeHTML(p.name)}</span>
            </div>`)
        .join('');
}

function checkNextButtonState() {
    const btn = document.getElementById('nextRoundBtn');
    if (!btn) return;
    // Enabled when: no matches exist yet, OR every match has a winner
    const canProceed =
        currentMatches.length === 0 ||
        currentMatches.every(m => m.winnerTeamIndex !== null);

    btn.style.opacity        = canProceed ? '1'            : '0.2';
    btn.style.pointerEvents  = canProceed ? 'auto'         : 'none';
    btn.style.cursor         = canProceed ? 'pointer'      : 'not-allowed';
    btn.style.background     = canProceed ? 'var(--accent)': '#475569';
}

// ---------------------------------------------------------------------------
// LONG-PRESS MENU
// ---------------------------------------------------------------------------

function startPress(i) {
    isLongPress = false;
    pressTimer = setTimeout(() => {
        isLongPress = true;
        Haptic.bump();
        openMenu(i);
    }, 600);
}

function endPress(i) {
    clearTimeout(pressTimer);
    if (!isLongPress && !squad[i].active) {
        Haptic.tap();
        squad[i].active = true;
        renderSquad();
        saveToDisk();
    }
}

function openMenu(i) {
    selectedPlayerIndex = i;
    const p = squad[i];
    document.getElementById('menuPlayerName').innerText = p.name;
    document.getElementById('playerStatusText').innerText = p.active
        ? 'Ready for Rotation'
        : 'Taking a Break ☕';
    const restBtn = document.getElementById('restToggleBtn');
    restBtn.innerHTML = p.active ? 'Take a Break ☕' : 'Return to Play';
    restBtn.onclick = toggleRestingState;
    document.getElementById('actionMenu').style.display = 'flex';
}

function closeMenu() {
    document.getElementById('actionMenu').style.display = 'none';
    selectedPlayerIndex = null;
}

// ---------------------------------------------------------------------------
// OVERLAYS — STATS & SYNC
// ---------------------------------------------------------------------------

function showOverlay(type) {
    const title   = document.getElementById('overlayTitle');
    const content = document.getElementById('overlayContent');
    document.getElementById('overlay').classList.add('open');

    if (type === 'stats') {
        title.innerText = 'Stats';
        renderStatsTab('performance');

    } else {
        // SYNC / MULTIPLAYER panel
        title.innerText = 'Session Hub';
        content.innerHTML = `
            <div id="syncStatusMsg" class="sync-status" style="display:none;"></div>

            ${isOnlineSession ? `
                <!-- ACTIVE SESSION VIEW -->
                <div class="session-live-card">
                    <div class="session-live-top">
                        <span class="session-live-dot"></span>
                        <span class="session-live-label">LIVE SESSION</span>
                    </div>
                    <div class="session-room-code">${currentRoomCode}</div>
                    <p style="font-size:0.7rem; color:var(--text-muted); margin:0 0 20px;">
                        ${isOperator ? 'Share this code — anyone can join as spectator' : 'You are viewing as spectator'}
                    </p>
                    <div id="qrcode" style="display:flex;justify-content:center;margin:0 auto 8px;"></div>
                    <button class="btn-main" style="width:100%; margin-top:16px; background:var(--accent); color:#000;"
                        onclick="copySyncToken()">Copy Room Code</button>
                    ${isOperator ? `
                        <button class="btn-main" style="width:100%; margin-top:10px; background:rgba(239,68,68,0.1); color:#ef4444;"
                            onclick="endAndDeleteSession(); closeOverlay();">End Session</button>
                    ` : `
                        <button class="btn-main" style="width:100%; margin-top:10px; background:#334155; color:#fff;"
                            onclick="leaveSession(); closeOverlay();">Leave Session</button>
                    `}
                </div>
            ` : `
                <!-- CREATE / JOIN VIEW -->
                <div style="margin-bottom:24px;">
                    <div class="sync-section-label">Host a New Session</div>
                    <p style="font-size:0.75rem; color:var(--text-muted); margin:0 0 12px;">
                        Start a live session. Anyone with your room code can watch in real time.
                    </p>
                    <button class="btn-main" style="width:100%; background:var(--accent); color:#000;"
                        onclick="createOnlineSession()">
                        🌐 Go Live
                    </button>
                </div>

                <div class="sync-divider"></div>

                <div style="margin-bottom:24px;">
                    <div class="sync-section-label">Join a Session</div>
                    <p style="font-size:0.75rem; color:var(--text-muted); margin:0 0 12px;">
                        Enter a room code to watch a live session anywhere in the world.
                    </p>
                    <input type="text" id="roomCodeInput"
                        placeholder="e.g. ABCD-1234"
                        style="width:100%; background:var(--bg2); border:1.5px solid var(--border);
                               color:#fff; padding:14px; border-radius:12px; margin-bottom:10px;
                               outline:none; font-size:16px; font-family:var(--font-display);
                               letter-spacing:3px; text-transform:uppercase; text-align:center;"
                        autocomplete="off" autocorrect="off" autocapitalize="characters"
                        oninput="this.value=this.value.toUpperCase()"
                    >
                    <button class="btn-main" style="width:100%; background:#475569; color:#fff;"
                        onclick="joinOnlineSession(document.getElementById('roomCodeInput').value)">
                        Join Session
                    </button>
                </div>

                <div class="sync-divider"></div>

                <div>
                    <div class="sync-section-label">Local Backup</div>
                    <button class="btn-main" style="width:100%; background:var(--surface2); color:#fff; margin-bottom:10px;"
                        onclick="copySyncToken()">Copy Sync Token</button>
                    <input type="text" id="syncInput" placeholder="Paste token to import…"
                        style="width:100%; background:var(--bg2); border:1px solid var(--border);
                               color:#fff; padding:14px; border-radius:12px; margin-bottom:10px;
                               outline:none; font-size:16px; font-family:inherit;"
                        autocomplete="off" autocorrect="off">
                    <button class="btn-main" style="width:100%; background:#334155; color:#fff;"
                        onclick="importSyncToken()">Import Token</button>
                </div>

                <hr style="margin:28px 0; border:none; border-top:1px solid var(--border);">
                <button class="btn-main" style="width:100%; background:rgba(239,68,68,0.1); color:#ef4444;"
                    onclick="eraseAllData()">WIPE ALL DATA</button>
            `}
        `;

        if (isOnlineSession) {
            // ── HOST QR CODE ────────────────────────────────────────────────────
            // Null guard: currentRoomCode must be set before we generate the QR.
            // If it's missing the session was never properly created — show an error
            // instead of encoding an invalid URL that leaves players with "No Room Code".
            if (!currentRoomCode) {
                console.error('[CourtSide] generateQR: currentRoomCode is null or undefined — QR not generated');
                const qrDiv = document.getElementById('qrcode');
                if (qrDiv) qrDiv.innerHTML = '<p style="color:#ef4444;font-size:12px;text-align:center;">Room code missing — try ending and restarting the session.</p>';
            } else {
                // URL construction: ?join= is the parameter that index.html,
                // sync.js (tryAutoRejoin), and passport.js (InviteQR) all read.
                // Using ?room= here would break every reader and produce "No Room Code".
                const joinUrl = window.location.origin + window.location.pathname + '?join=' + currentRoomCode + '&role=player';

                // Verify the URL in the host console before the QR renders
                console.log('[CourtSide] Generating QR for:', joinUrl);

                // Use the qrcodejs constructor API as instructed.
                // QRCodeConstructor is saved in index.html before qrcode@1.5.1 overwrites the global.
                const QRCtor = window.QRCodeConstructor || window.QRCode;
                const qrDiv  = document.getElementById('qrcode');
                if (qrDiv && QRCtor) {
                    // Clear any previous QR (e.g. overlay reopened)
                    qrDiv.innerHTML = '';
                    new QRCtor(qrDiv, {
                        text:          joinUrl,
                        width:         200,
                        height:        200,
                        colorDark:     '#000000',
                        colorLight:    '#ffffff',
                        correctLevel:  QRCtor.CorrectLevel?.H || 0,
                    });
                } else if (qrDiv) {
                    // Both QR libraries unavailable (CDN failure) — show the URL as tap-to-copy text
                    console.warn('[CourtSide] QRCode library not loaded, showing plain URL');
                    qrDiv.innerHTML = `<a href="${joinUrl}" style="color:#00ffa3;font-size:11px;word-break:break-all;">${joinUrl}</a>`;
                }
            }
        }
    }
}

function closeOverlay() {
    document.getElementById('overlay').classList.remove('open');
}

// ---------------------------------------------------------------------------
// QR CODE & SYNC TOKEN
// (Previously duplicated — now defined exactly once)
// ---------------------------------------------------------------------------

function generateQR() {
    // Local backup path — encodes squad+matches as a base64 token (not a URL).
    // Uses the same div#qrcode element as the host session QR.
    const token = btoa(JSON.stringify({ squad, currentMatches }));
    const qrDiv = document.getElementById('qrcode');
    if (!qrDiv) return;
    qrDiv.innerHTML = '';
    const QRCtor = window.QRCodeConstructor || window.QRCode;
    if (!QRCtor) { console.error('[CourtSide] generateQR: QRCode library not loaded'); return; }
    new QRCtor(qrDiv, {
        text:         token,
        width:        200,
        height:       200,
        colorDark:    '#000000',
        colorLight:   '#ffffff',
    });
}

function copySyncToken() {
    // In online mode — copy the room code, not the full token
    const text = isOnlineSession
        ? currentRoomCode
        : btoa(JSON.stringify({ squad, currentMatches }));

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
            .then(() => alert(isOnlineSession ? `Room code copied: ${text}` : 'Token copied!'))
            .catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    // Fallback for browsers/devices where clipboard API isn't available
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
        document.execCommand('copy');
        alert('Token copied!');
    } catch (e) {
        alert('Could not copy automatically. Please copy the token manually.');
    }
    document.body.removeChild(ta);
}

function importSyncToken() {
    const val = document.getElementById('syncInput').value.trim();
    if (!val) return;
    try {
        const data = JSON.parse(atob(val));
        if (!data.squad) throw new Error('Missing squad data');
        squad = data.squad;
        currentMatches = data.currentMatches || [];
        saveToDisk();
        closeOverlay();
        // FIX: Full re-render instead of location.reload() — no page flash, no state loss
        renderSquad();
        document.getElementById('matchContainer').innerHTML = '';
        renderSavedMatches();
        checkNextButtonState();
    } catch (e) {
        alert('Invalid Sync Token. Please check the data and try again.');
    }
}

function eraseAllData() {
    if (confirm('Wipe everything? This cannot be undone.')) {
        localStorage.clear();
        location.reload();
    }
}

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------

/**
 * Escapes HTML special characters to prevent XSS when inserting player
 * names (user-supplied strings) into innerHTML.
 */
function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// INIT — see initApp() at the bottom of this file
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// UNDO LAST ROUND
// ---------------------------------------------------------------------------

/**
 * Shows or hides the undo button based on whether there's history to undo.
 */
function updateUndoButton() {
    let btn = document.getElementById('undoRoundBtn');
    if (!btn) return;
    btn.style.display  = roundHistory.length > 0 ? 'inline-flex' : 'none';
}

/**
 * Rolls back the last completed round.
 * Restores squad stats, ELO, and match cards to pre-round state.
 */
function undoLastRound() {
    if (roundHistory.length === 0) return;
    if (!confirm('Undo the last round? This will reverse all ELO changes.')) return;

    const snapshot = roundHistory.pop();

    // Restore squad stats from snapshot
    squad = snapshot.squadSnapshot.map(s => ({ ...s }));

    // Restore match cards so host can re-pick winners
    currentMatches = snapshot.matches.map(m => ({ ...m, winnerTeamIndex: null }));

    // Re-render everything
    renderSquad();
    document.getElementById('matchContainer').innerHTML = '';
    renderSavedMatches();

    // Re-select the previous winners visually so host knows what was picked
    snapshot.matches.forEach((m, i) => {
        if (m.winnerTeamIndex !== null) {
            const boxes = document.querySelectorAll(`#match-${i} .team-box`);
            if (boxes[m.winnerTeamIndex]) {
                boxes[m.winnerTeamIndex].classList.add('selected');
            }
            currentMatches[i].winnerTeamIndex = m.winnerTeamIndex;
        }
    });

    updateUndoButton();
    checkNextButtonState();
    saveToDisk();
    if (isOnlineSession && isOperator) pushStateToSupabase();
    Haptic.bump();
    showSessionToast('↩ Last round undone');
}

// ---------------------------------------------------------------------------
// STATS OVERLAY — TABS
// ---------------------------------------------------------------------------

/**
 * Renders the stats overlay with tabbed navigation.
 * tab: 'performance' | 'history'
 */
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
        const sorted   = [...squad].sort((a, b) => b.rating - a.rating);
        const topCount = Math.max(1, Math.ceil(squad.length * 0.3));
        const peak     = sorted.slice(0, topCount).sort((a, b) => a.name.localeCompare(b.name));
        const active   = sorted.slice(topCount).sort((a, b) => a.name.localeCompare(b.name));
        const winRate  = p => p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0;

        const renderGroup = (label, list) => {
            if (list.length === 0) return '';
            const cards = list.map((p, i) => {
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
                </div>
            `;
        };

        content.innerHTML = tabs + renderGroup('Peak Performers', peak) + renderGroup('Active Roster', active);

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
                    </div>
                `;
            }).join('');

            return `
                <div class="history-round">
                    <div class="history-round-label">Round ${roundNum}</div>
                    ${games}
                </div>
            `;
        }).join('');

        content.innerHTML = tabs + `<div class="history-list">${rounds}</div>`;
    }
}

// ---------------------------------------------------------------------------
// CHECK-IN MODE (Spectator view)
// ---------------------------------------------------------------------------

/**
 * Renders the check-in UI shown to spectators.
 * Displays all squad members — tap to toggle active/resting for this session.
 * Changes are pushed to Supabase so the host sees them live.
 */

// ---------------------------------------------------------------------------
// PLAYER CARDS
// ---------------------------------------------------------------------------

/**
 * Auto-generates a fun title based on a player's real stats.
 * Everyone gets something — titles aren't only for high performers.
 */
function getPlayerTitle(p) {
    const wr = p.games > 0 ? p.wins / p.games : 0;

    if (p.streak >= 5)              return { title: 'On Fire',       icon: '🔥' };
    if (p.streak >= 3)              return { title: 'Hot Hand',      icon: '⚡' };
    if (p.games === 0)              return { title: 'Fresh Blood',   icon: '🌱' };
    if (p.games >= 10 && wr >= 0.7) return { title: 'The Closer',    icon: '🎯' };
    if (p.games >= 10 && wr >= 0.6) return { title: 'Sharp Shooter', icon: '🏹' };
    if (p.games >= 8)               return { title: 'Iron Man',      icon: '💪' };
    if (wr >= 0.6 && p.games >= 5)  return { title: 'Rising Star',   icon: '⭐' };
    if (wr <= 0.35 && p.games >= 5) return { title: 'Never Quits',   icon: '🛡️' };
    if (p.wins === 0 && p.games > 0)return { title: 'The Underdog',  icon: '🐉' };
    if (p.games >= 6 && wr >= 0.45) return { title: 'Steady Eddie',  icon: '🤝' };
    if (p.sessionPlayCount >= 5)    return { title: 'Always Ready',  icon: '🏃' };
    if (p.streak === 0 && p.games > 3) return { title: 'The Wildcard', icon: '🎲' };
    return { title: 'The Veteran', icon: '🏅' };
}

/**
 * Opens a full-screen player card for a given squad index.
 * Accessible from long-press menu (host) and Performance Lab (anyone).
 */
function openPlayerCard(idx) {
    const p  = squad[idx];
    if (!p) return;

    const { title, icon } = getPlayerTitle(p);
    const wr  = p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0;
    const bg  = Avatar.color(p.name);
    const ini = Avatar.initials(p.name);

    document.getElementById('playerCardContent').innerHTML = `
        <div class="pc-avatar-wrap">
            <div class="pc-avatar" style="background:${bg};">${ini}</div>
            ${p.streak >= 3 ? '<div class="pc-streak-ring"></div>' : ''}
        </div>
        <div class="pc-title-badge">
            <span class="pc-title-icon">${icon}</span>
            <span class="pc-title-text">${title}</span>
        </div>
        <div class="pc-name">${escapeHTML(p.name)}</div>
        <div class="pc-stats-row">
            <div class="pc-stat">
                <div class="pc-stat-val">${p.wins}</div>
                <div class="pc-stat-label">Wins</div>
            </div>
            <div class="pc-stat-divider"></div>
            <div class="pc-stat">
                <div class="pc-stat-val">${p.games}</div>
                <div class="pc-stat-label">Games</div>
            </div>
            <div class="pc-stat-divider"></div>
            <div class="pc-stat">
                <div class="pc-stat-val">${wr}%</div>
                <div class="pc-stat-label">Win Rate</div>
            </div>
        </div>
        ${p.streak > 0 ? `<div class="pc-streak">🔥 ${p.streak} game win streak</div>` : ''}
    `;

    document.getElementById('playerCardModal').style.display = 'flex';
    Haptic.bump();
}

function closePlayerCard() {
    document.getElementById('playerCardModal').style.display = 'none';
}

/**
 * Captures the player card as an image and opens the native share sheet.
 * Uses html2canvas loaded from CDN.
 */
async function sharePlayerCard() {
    const card = document.querySelector('.player-card');
    if (!card) return;

    // Load html2canvas if not already present
    if (!window.html2canvas) {
        await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }

    try {
        const canvas = await html2canvas(card, {
            backgroundColor: '#0a0a0f',
            scale: 2,
            useCORS: true,
            logging: false,
        });

        canvas.toBlob(async (blob) => {
            const file = new File([blob], 'courtside-player-card.png', { type: 'image/png' });
            if (navigator.share && navigator.canShare({ files: [file] })) {
                await navigator.share({
                    title:  'The Court Side',
                    text:   'Check out this player card!',
                    files:  [file],
                });
            } else {
                // Fallback: download the image
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'courtside-player-card.png';
                a.click();
            }
        }, 'image/png');
    } catch (e) {
        console.error('Share failed:', e);
    }
    Haptic.success();
}

// ---------------------------------------------------------------------------
// AURA MATCH POSTER
// ---------------------------------------------------------------------------

async function shareAuraPoster(matchIdx) {
    const m  = currentMatches[matchIdx];
    if (!m) return;

    const tA = m.teams[0];
    const tB = m.teams[1];

    // Populate the hidden poster div
    document.getElementById('auraPosterGame').textContent  = `GAME ${matchIdx + 1}`;
    document.getElementById('auraPosterTeamA').textContent = tA.join(' & ');
    document.getElementById('auraPosterTeamB').textContent = tB.join(' & ');
    document.getElementById('auraPosterOddsA').textContent = `${m.odds[0]}%`;
    document.getElementById('auraPosterOddsB').textContent = `${m.odds[1]}%`;

    // Move poster into view temporarily for capture
    const poster = document.getElementById('auraPoster');
    poster.style.left = '-9999px';
    poster.style.top  = '0';

    try {
        const canvas = await html2canvas(poster.querySelector('.aura-bg'), {
            backgroundColor: null,
            scale:  2,
            width:  390,
            height: 693,
            useCORS: true,
            logging: false,
        });

        canvas.toBlob(async (blob) => {
            const file = new File([blob], 'courtside-aura.png', { type: 'image/png' });
            if (navigator.share && navigator.canShare({ files: [file] })) {
                await navigator.share({
                    title: 'The Court Side Pro',
                    text:  `${tA.join(' & ')} vs ${tB.join(' & ')} — who you got? 🏀`,
                    files: [file],
                });
            } else {
                // Fallback: download
                const a = document.createElement('a');
                a.href     = URL.createObjectURL(blob);
                a.download = 'courtside-aura.png';
                a.click();
            }
            Haptic.success();
        }, 'image/png');

    } catch (e) {
        console.error('Aura poster failed:', e);
        showSessionToast('Could not generate poster');
    }
}

// ---------------------------------------------------------------------------
// WEEKLY LEADERBOARD — rendered in stats overlay
// ---------------------------------------------------------------------------

async function renderLeaderboardTab() {
    const content = document.getElementById('overlayContent');

    const tabs = `
        <div class="stats-tabs">
            <button class="stats-tab" onclick="renderStatsTab('performance')">Performance</button>
            <button class="stats-tab" onclick="renderStatsTab('history')">History</button>
            <button class="stats-tab active" onclick="renderLeaderboardTab()">Leaderboard</button>
        </div>
    `;

    content.innerHTML = tabs + `<div style="text-align:center;padding:30px 0;color:var(--text-muted);font-size:0.8rem;">Loading leaderboard…</div>`;

    try {
        const res  = await fetch('/api/leaderboard-get');
        const data = await res.json();

        if (!data || !data.players || data.players.length === 0) {
            content.innerHTML = tabs + `
                <div style="text-align:center;padding:40px 0;color:var(--text-muted);font-size:0.85rem;">
                    No leaderboard data yet.<br>Complete sessions to build the all-time rankings.
                </div>`;
            return;
        }

        const winRate = p => p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0;
        const rows = data.players
            .sort((a, b) => b.wins - a.wins || winRate(b) - winRate(a))
            .map((p, i) => `
                <div class="lb-row ${i === 0 ? 'lb-top' : ''}">
                    <span class="lb-rank">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}</span>
                    <span class="lb-name">${escapeHTML(p.name)}</span>
                    <span class="lb-stats">${p.wins}W · ${p.games}G · ${winRate(p)}%</span>
                </div>
            `).join('');

        content.innerHTML = tabs + `
            <div class="lb-subtitle">All-time across all sessions</div>
            <div class="lb-list">${rows}</div>
        `;

    } catch (e) {
        content.innerHTML = tabs + `
            <div style="text-align:center;padding:40px 0;color:var(--text-muted);font-size:0.85rem;">
                Leaderboard unavailable. Are you online?
            </div>`;
    }
}

// ---------------------------------------------------------------------------
// "I WANT TO PLAY" — Spectator feature
// ---------------------------------------------------------------------------

let playRequests = []; // host-side list of pending requests

// updateIWTPVisibility is defined once below in the Passport Integration
// section where it also calls checkIWTPSmartRecognition. A second definition
// here would be a duplicate function declaration — a SyntaxError in strict
// mode that causes the entire script to fail silently on Vercel.

// ---------------------------------------------------------------------------
// IWTP — DECISION FLOW (Zero-assumption, clean collapse)
// ---------------------------------------------------------------------------

/** Helper: show only one IWTP sub-view, hide all others */
function _iwtpShow(id) {
    ['iwtpChoiceView','iwtpNewPlayerView','iwtpExistingView','iwtpSpectatorView'].forEach(v => {
        const el = document.getElementById(v);
        if (el) el.style.display = v === id ? 'block' : 'none';
    });
}

function showIWTPChoice() {
    _iwtpShow('iwtpChoiceView');
}

function showIWTPNewPlayer() {
    _iwtpShow('iwtpNewPlayerView');
    Haptic.tap();
    setTimeout(() => document.getElementById('iwtpNameInput')?.focus(), 120);
}

function showIWTPExisting() {
    _iwtpShow('iwtpExistingView');
    Haptic.tap();
    const list = document.getElementById('iwtpPlayerList');
    if (!list) return;
    if (squad.length === 0) {
        list.innerHTML = `<p class="iwtp-empty">No players yet.<br>Ask the host to add players first.</p>`;
        return;
    }
    list.innerHTML = squad.map(p => `
        <button class="iwtp-player-chip" onclick="confirmSpectateAs('${escapeHTML(p.name)}')">
            ${Avatar.html(p.name)}
            <span>${escapeHTML(p.name)}</span>
        </button>
    `).join('');
}

/**
 * Player picks their name → instant collapse to confirmed read-only view.
 * Screen is 100% clear of forms. Spectator mode enforced.
 */
function confirmSpectateAs(name) {
    localStorage.setItem('cs_spectator_name', name);
    document.getElementById('iwtpSpectatorName').textContent    = name.toUpperCase();
    document.getElementById('iwtpSpectatorSubtitle').textContent = 'Live view — read only';
    _iwtpShow('iwtpSpectatorView');
    document.body.classList.add('spectator-mode');
    Haptic.success();
    showSessionToast(`👁 Watching as ${name}`);
}

/**
 * Collapse the entire IWTP sheet off-screen.
 * Called when spectator taps "Enter Live View".
 */
function collapseIWTPSheet() {
    const sheet = document.getElementById('iwantToPlaySheet');
    if (!sheet) return;
    sheet.style.transition = 'transform 0.4s cubic-bezier(0.22,1,0.36,1), opacity 0.3s ease';
    sheet.style.transform  = 'translateY(100%)';
    sheet.style.opacity    = '0';
    setTimeout(() => { sheet.style.display = 'none'; }, 420);
    Haptic.tap();
}

/**
 * New player submits join request.
 * On success: entire sheet collapses immediately — toast confirms.
 */
async function submitIWantToPlay() {
    const input = document.getElementById('iwtpNameInput');
    const name  = (input?.value || '').trim();
    const btn   = document.getElementById('iwtpSendBtn');

    if (!name) {
        showSessionToast('Please enter your name first.');
        input?.focus();
        return;
    }
    if (!currentRoomCode) {
        showSessionToast('Not connected to a session.');
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

    try {
        const res = await fetch('/api/play-request', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ room_code: currentRoomCode, name }),
        });

        if (res.ok) {
            localStorage.setItem('cs_spectator_name', name);
            // INSTANT: collapse entire sheet — screen is clean
            collapseIWTPSheet();
            // Small toast confirms action
            setTimeout(() => showSessionToast('🏀 Request sent! Pending host approval…'), 300);
            Haptic.success();
        } else {
            throw new Error('Failed');
        }
    } catch {
        if (btn) { btn.disabled = false; btn.textContent = 'Send Request'; }
        showSessionToast('Could not send request. Try again.');
        Haptic.error();
    }
}

/**
 * On load: check if returning spectator — skip choice, restore their view.
 * Otherwise show the two-choice landing.
 */
function checkIWTPSmartRecognition() {
    const sheet = document.getElementById('iwantToPlaySheet');
    if (!sheet || !isOnlineSession || isOperator) return;

    const savedName = localStorage.getItem('cs_spectator_name');
    if (savedName) {
        const match = squad.find(p => p.name.toLowerCase() === savedName.toLowerCase());
        if (match) {
            confirmSpectateAs(match.name);
            return;
        }
    }
    // First time — show choice
    showIWTPChoice();
}

/**
 * Host: poll for pending play requests and show badge.
 */
let _lastSeenRequestIds = new Set();

async function pollPlayRequests() {
    if (!isOnlineSession || !isOperator || !currentRoomCode) return;
    try {
        const res  = await fetch(`/api/play-request?room_code=${encodeURIComponent(currentRoomCode)}`);
        const data = await res.json();
        const incoming = data.requests || [];
        playRequests = incoming;

        // Detect NEW requests not seen before — trigger notification
        incoming.forEach(r => {
            if (!_lastSeenRequestIds.has(r.id)) {
                _lastSeenRequestIds.add(r.id);
                showJoinNotification(r.name, r.id, r.player_uuid || null);
            }
        });

        // Update badge count
        const badge = document.getElementById('playRequestsBadge');
        const count = document.getElementById('playRequestsCount');
        if (badge && count) {
            badge.style.display = playRequests.length > 0 ? 'flex' : 'none';
            count.textContent   = playRequests.length;
        }
    } catch { /* silent */ }
}

/**
 * High-visibility slide-down notification for new join requests.
 * Stacks if multiple arrive — each one queues and shows in sequence.
 */
const _notifQueue = [];
let   _notifShowing = false;

function showJoinNotification(name, id, uuid = null) {
    _notifQueue.push({ name, id, uuid });
    if (!_notifShowing) processNotifQueue();
}

function processNotifQueue() {
    if (_notifQueue.length === 0) { _notifShowing = false; return; }
    _notifShowing = true;

    const { name, id, uuid } = _notifQueue.shift();
    const notif = document.getElementById('joinNotification');
    const nameEl = document.getElementById('joinNotifName');
    if (!notif || !nameEl) return;

    nameEl.textContent  = name;
    notif.dataset.id    = id;
    notif.dataset.name  = name;
    notif.dataset.uuid  = uuid || '';
    notif.classList.add('show');
    Haptic.bump();

    const timer = setTimeout(() => dismissJoinNotification(), 12000);
    notif._timer = timer;
}

function dismissJoinNotification() {
    const notif = document.getElementById('joinNotification');
    if (!notif) return;
    clearTimeout(notif._timer);
    notif.classList.remove('show');
    setTimeout(processNotifQueue, 400); // wait for slide-out animation
}

async function notifApprove() {
    const notif = document.getElementById('joinNotification');
    const name  = notif?.dataset.name;
    const id    = notif?.dataset.id;
    const uuid  = notif?.dataset.uuid || null;
    if (name && id) {
        await approvePlayRequest(name, id, uuid);
        _lastSeenRequestIds.delete(id);
    }
    dismissJoinNotification();
}

async function notifDecline() {
    const notif = document.getElementById('joinNotification');
    const id    = notif?.dataset.id;
    if (id) {
        await denyPlayRequest(id);
        _lastSeenRequestIds.delete(id);
    }
    dismissJoinNotification();
}

function showPlayRequests() {
    const modal = document.getElementById('playRequestsModal');
    const list  = document.getElementById('playRequestsList');
    if (!modal || !list) return;

    list.innerHTML = playRequests.length === 0
        ? '<p style="text-align:center;color:var(--text-muted);padding:20px 0;">No pending requests.</p>'
        : playRequests.map(r => `
            <div class="pr-row">
                <span class="pr-name">${escapeHTML(r.name)}</span>
                <button class="pr-add-btn" onclick="approvePlayRequest('${escapeHTML(r.name)}', '${r.id}', '${r.player_uuid||''}')">+ Add</button>
                <button class="pr-deny-btn" onclick="denyPlayRequest('${r.id}')">✕</button>
            </div>
        `).join('');

    modal.style.display = 'flex';
}

function closePlayRequests() {
    document.getElementById('playRequestsModal').style.display = 'none';
}

async function approvePlayRequest(name, id, playerUUID = null) {
    // Add to squad
    if (!squad.find(p => p.name === name)) {
        squad.push({ name, uuid: playerUUID || null, rating: 1000, wins: 0, games: 0, streak: 0, active: true });
    }

    // UUID map for win signal dispatch
    window._sessionUUIDMap = window._sessionUUIDMap || {};
    if (playerUUID) window._sessionUUIDMap[name] = playerUUID;

    // Verification token — stored in session for refresh persistence
    const token = _makeApprovalToken();
    window._approvedPlayers = window._approvedPlayers || {};
    window._approvedPlayers[playerUUID || name] = { token, name, uuid: playerUUID, approvedAt: Date.now() };

    renderSquad();
    saveToDisk();   // triggers pushStateToSupabase + broadcastGameState via hook
    showSessionToast(`✅ ${name} added`);
    Haptic.success();

    // PART 1: Flip session_members.status → 'active' in the database.
    // This DB write triggers a Supabase Realtime postgres_changes event that
    // the player's phone receives in _handleMemberChange() → _onMemberActivated().
    // This is the "Approval Memory" mechanism — survives page refresh.
    if (typeof memberApprove === 'function' && playerUUID) {
        memberApprove(playerUUID);   // non-blocking, fire and forget
    }

    // BUG 1 FIX: broadcast approval INSTANTLY via the broadcast channel.
    // The player's _onApprovalReceived handler catches this, matches UUID,
    // saves token to sessionStorage, and flips UI to active sideline view.
    // This is separate from (and faster than) the debounced DB write.
    if (typeof broadcastApproval === 'function') {
        broadcastApproval(playerUUID, name, token);
    }

    await denyPlayRequest(id);
}

function _makeApprovalToken() {
    const arr = new Uint8Array(12);
    (window.crypto || crypto).getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

async function denyPlayRequest(id) {
    try {
        await fetch('/api/play-request', {
            method:  'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ id, room_code: currentRoomCode }),
        });
        await pollPlayRequests();
        showPlayRequests();
    } catch { /* silent */ }
}

// Start polling when host goes live
const _startPolling = () => {
    pollPlayRequests();
    setInterval(() => { if (isOnlineSession && isOperator) pollPlayRequests(); }, 10000);
};

// ---------------------------------------------------------------------------
// NEXT UP TICKER
// ---------------------------------------------------------------------------

function updateNextUpTicker(players) {
    const ticker = document.getElementById('nextUpTicker');
    if (!ticker) return;
    if (!players || players.length === 0) {
        ticker.style.display = 'none';
        return;
    }
    ticker.style.display = 'flex';
    document.getElementById('nextUpNames').textContent =
        players.map(p => p.name.toUpperCase()).join('  ·  ');
}

// ---------------------------------------------------------------------------
// NEXT UP TICKER — sync update for spectators
// ---------------------------------------------------------------------------

function updateIWTPVisibility() {
    const sheet = document.getElementById('iwantToPlaySheet');
    if (!sheet) return;
    const show = isOnlineSession && !isOperator;
    sheet.style.display = show ? 'flex' : 'none';
    if (show) {
        checkIWTPSmartRecognition();
    }
}

// =============================================================================
// PASSPORT INTEGRATION
// =============================================================================

/**
 * Called on page load and whenever the IWTP sheet is about to show.
 * If the player has a passport, skip name entry entirely.
 */
function passportInit() {
    const passport = Passport.init();
    return passport;
}

/**
 * Rename flow — triggered by tapping the player name in sideline view.
 */
function passportRename() {
    const passport = Passport.get();
    if (!passport) return;

    const newName = prompt('Update your name:', passport.playerName);
    if (!newName || !newName.trim()) return;

    const trimmed = newName.trim();
    const oldName = passport.playerName;

    // BUG 3 FIX: write localStorage FIRST, then update UI, then broadcast.
    // This order prevents any render reading stale data.
    Passport.rename(trimmed);                   // 1. localStorage
    if (typeof PlayerMode !== 'undefined') {
        PlayerMode._renderIdentity(Passport.get()); // 2. identity card
    }
    SidelineView.refresh();                     // 3. full view

    // 4. Broadcast to host via the broadcast channel (not a dead API route)
    if (typeof isOnlineSession !== 'undefined' && isOnlineSession && currentRoomCode) {
        if (typeof broadcastNameUpdate === 'function') {
            broadcastNameUpdate(passport.playerUUID, oldName, trimmed);
        }
    }

    // 5. PART 1: Also write new name to session_members table.
    // This triggers the host's postgres_changes listener (_handleMemberChange)
    // which updates the squad name on the big screen in real-time — no refresh.
    if (typeof isOnlineSession !== 'undefined' && isOnlineSession && currentRoomCode && typeof memberRename === 'function') {
        memberRename(passport.playerUUID, trimmed);   // non-blocking
    }

    showSessionToast(`✅ Name updated to ${trimmed}`);
}

/**
 * Poll for win/loss signals addressed to this passport UUID.
 * Runs every 8 seconds while in an online session.
 */
let _signalPollTimer = null;

function startSignalPolling() {
    const passport = Passport.get();
    if (!passport || !currentRoomCode) return;

    clearInterval(_signalPollTimer);
    _signalPollTimer = setInterval(async () => {
        if (!currentRoomCode) return;
        try {
            const res  = await fetch(
                `/api/passport-signal?player_uuid=${encodeURIComponent(passport.playerUUID)}&room_code=${encodeURIComponent(currentRoomCode)}`
            );
            const data = await res.json();
            if (data.signal) {
                await handlePassportSignal(data.signal, passport);
            }
        } catch { /* silent */ }
    }, 8000);
}

async function handlePassportSignal(signal, passport) {
    if (signal.event === 'WIN') {
        Passport.recordWin();
        VictoryCard.show(passport.playerName);
    } else if (signal.event === 'LOSS') {
        Passport.recordLoss();
    }
    SidelineView.refresh();

    // Acknowledge — clear signal from server
    await fetch('/api/passport-signal', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
            player_uuid: passport.playerUUID,
            room_code:   currentRoomCode,
        }),
    }).catch(() => {});
}

/**
 * Host dispatches win signals after selecting winners.
 * Called from setWinner() in logic.js.
 * Resolves player names → UUIDs using the session's uuid_map.
 */
/**
 * Called from setWinner() in logic.js when host selects a winner.
 * Also called from processAndNext() to ensure signal fires even if
 * setWinner was called before Next Round.
 *
 * UUID RESOLUTION — UUID-first priority chain (survives name changes):
 *   1. squad[n].uuid    — stored at approval time, never changes with renames
 *   2. uuidMap[name]    — fallback, may be stale if name changed
 */
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

    // Broadcast MATCH_RESOLVED — carries winnerUUIDs + loserUUIDs so every player
    // can record their own outcome. This is the single source of truth for stats.
    // (match_result individual broadcasts were removed — they caused double-recording.)
    const winnerDisplayNames = winnerNames.join(' & ');
    if (typeof _broadcast === 'function' && isOnlineSession) {
        _broadcast('match_resolved', {
            winnerNames:  winnerDisplayNames,
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

// =============================================================================
// PASSPORT-AWARE JOIN FLOW OVERRIDE
// =============================================================================

/**
 * Installs the passport-aware override on checkIWTPSmartRecognition.
 *
 * WHY A FUNCTION INSTEAD OF MODULE-LEVEL CODE:
 *   The original pattern was:
 *       const _originalCheckIWTP = checkIWTPSmartRecognition;   ← runs at parse time
 *       checkIWTPSmartRecognition = function() { ... };
 *
 *   On Vercel, scripts are fetched in parallel. If app.js finishes parsing
 *   before passport.js is evaluated, checkIWTPSmartRecognition is captured
 *   before the Passport object exists, and the reassignment is lost when
 *   passport.js later defines its own version of the function.
 *
 *   Moving this into a named function and calling it from initApp() — after
 *   DOMContentLoaded guarantees all scripts are parsed — eliminates the race.
 */
function _installPassportIWTPOverride() {
    const _originalCheckIWTP = checkIWTPSmartRecognition;
    checkIWTPSmartRecognition = function() {
        const passport = Passport.get();
        const sheet    = document.getElementById('iwantToPlaySheet');
        if (!sheet || !isOnlineSession || isOperator) return;

        if (passport && passport.playerName) {
            // Returning player — show welcome-back prompt
            showPassportWelcome(passport);
            return;
        }
        // No passport — show normal choice flow
        _originalCheckIWTP();
    };
}

function showPassportWelcome(passport) {
    const sheet = document.getElementById('iwantToPlaySheet');
    if (!sheet) return;

    // Hijack the choice view with a personalised welcome
    const choiceView = document.getElementById('iwtpChoiceView');
    if (!choiceView) return;

    choiceView.innerHTML = `
        <div class="iwtp-title">Welcome back,</div>
        <div class="iwtp-passport-name">${escapeHTML(passport.playerName)}</div>
        <div class="iwtp-subtitle">Your passport was found on this device.</div>
        <button class="iwtp-btn" onclick="passportJoinSession()">
            🏀 Join Session ${escapeHTML(currentRoomCode || '')}
        </button>
        <button class="iwtp-choice-btn iwtp-choice-existing" style="margin-top:10px;" onclick="passportRenameAndJoin()">
            ✏️ Join with a different name
        </button>
        <button class="iwtp-back-btn" style="margin-top:14px; display:block; text-align:center; width:100%;"
            onclick="spectateOnly()">
            👁 Just spectate
        </button>
    `;

    _iwtpShow('iwtpChoiceView');
    sheet.style.display = 'flex';
}

async function passportJoinSession() {
    const passport = Passport.get();
    if (!passport || !currentRoomCode) return;

    await submitPassportJoinRequest(passport.playerName, passport.playerUUID);
}

async function passportRenameAndJoin() {
    const passport = Passport.get();
    const newName  = prompt('Enter name for this session:', passport?.playerName || '');
    if (!newName || !newName.trim()) return;
    Passport.rename(newName.trim());
    await submitPassportJoinRequest(newName.trim(), passport.playerUUID);
}

async function submitPassportJoinRequest(name, uuid) {
    if (!currentRoomCode) return;
    const btn = document.querySelector('.iwtp-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

    try {
        const res = await fetch('/api/play-request', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ room_code: currentRoomCode, name, player_uuid: uuid }),
        });

        if (res.ok) {
            // Collapse sheet — show sideline view
            collapseIWTPSheet();
            setTimeout(() => {
                SidelineView.show();
                startSignalPolling();
            }, 450);
            showSessionToast('🏀 Request sent! Waiting for host approval…');
            Haptic.success();
        } else {
            throw new Error('Failed');
        }
    } catch {
        if (btn) { btn.disabled = false; btn.textContent = 'Join Session'; }
        showSessionToast('Could not send request. Try again.');
    }
}

function spectateOnly() {
    collapseIWTPSheet();
    document.body.classList.add('spectator-mode');
    showSessionToast('👁 Spectating live');
}
// =============================================================================
// initApp — single async entry point for ALL app initialization
// =============================================================================
//
// EXECUTION GUARANTEE:
//   Called only from the DOMContentLoaded listener at the bottom of this file.
//   By that point the browser has fully parsed every <script> tag in index.html
//   (polish.js → passport.js → app.js → logic.js → sync.js), so Passport,
//   InviteQR, PlayerMode, tryAutoRejoin, and loadFromDisk all exist.
//
// STEP ORDER:
//   1. passport fail-safe  — globals set before any other logic runs
//   2. inviteQR alias      — wire lowercase inviteQR → InviteQR object
//   3. IWTP override       — install passport-aware checkIWTPSmartRecognition
//   4. Disk load           — restore squad/matches from localStorage
//   5. QR deferred         — generateQR() only called after UI is ready
//   6. Boot handoff        — hand off to bootApp() (passport.js) for the
//                            async Supabase / PlayerMode initialisation
// =============================================================================

async function initApp() {

    // ── STEP 1: Passport fail-safe ────────────────────────────────────────────
    // Set the global `passport` variable as the very first thing.
    // Every subsequent step — and every function in this file — can safely
    // read `passport` without checking whether it was ever assigned.
    //
    // Key: 'cs_player_passport' matches the PASSPORT_KEY constant in passport.js.
    // If localStorage throws (private browsing on some iOS), fall back gracefully.
    try {
        const _raw = localStorage.getItem('cs_player_passport');
        passport = _raw ? JSON.parse(_raw) : null;
    } catch (e) {
        console.warn('[CourtSide] initApp: localStorage read failed', e);
        passport = null;
    }

    // If no passport exists yet, create a fresh one via the Passport object
    // (defined in passport.js, guaranteed to exist by DOMContentLoaded timing).
    if (!passport && typeof Passport !== 'undefined') {
        passport = Passport.init();
    }

    // Ensure window._passport is in sync — bootApp() (passport.js) reads this.
    window._passport = passport;

    // ── STEP 2: Wire inviteQR alias ───────────────────────────────────────────
    // InviteQR (capital) is the object literal defined in passport.js.
    // inviteQR (lowercase, declared at the top of this file) is the alias that
    // HTML onclick handlers like onclick="inviteQR.show(…)" resolve against.
    // Without this assignment, any tap on the Invite button throws:
    //   ReferenceError: Can't find variable: inviteQR
    if (typeof InviteQR !== 'undefined') {
        inviteQR = InviteQR;
    }

    // ── STEP 3: Install passport-aware IWTP override ──────────────────────────
    // Must run after all scripts are parsed so checkIWTPSmartRecognition is
    // already defined (it's declared in this file at ~line 970).
    if (typeof _installPassportIWTPOverride === 'function') {
        _installPassportIWTPOverride();
    }

    // ── STEP 4: Restore local state from disk ─────────────────────────────────
    // loadFromDisk reads localStorage → populates squad/currentMatches →
    // calls renderSquad() + checkNextButtonState(). Safe to call here because
    // the DOM is fully parsed (DOMContentLoaded has fired).
    try {
        loadFromDisk();
    } catch (e) {
        console.error('[CourtSide] initApp: loadFromDisk failed', e);
    }

    // ── STEP 5: Deferred QR generation ────────────────────────────────────────
    // generateQR() requires the QRCode library (qrcode.min.js) and a #qrCanvas
    // element. Both are guaranteed to exist after DOMContentLoaded, but the
    // canvas only appears when the sync overlay is open — so we don't call it
    // here; it's called inside showOverlay('sync') when the overlay renders.
    // This comment documents the intent: never call generateQR() at parse time.

    // ── STEP 6: Async boot handoff ────────────────────────────────────────────
    // bootApp() is defined at the bottom of passport.js. It owns everything
    // async: Supabase rejoin, PlayerMode boot, URL parsing.
    // initApp() is synchronous-first; bootApp() handles the network work.
    if (typeof bootApp === 'function') {
        await bootApp();
    } else {
        // bootApp not available (e.g. passport.js failed to load) — fall back
        // to tryAutoRejoin so the host session still reconnects.
        console.warn('[CourtSide] initApp: bootApp not found, falling back to tryAutoRejoin');
        if (typeof tryAutoRejoin === 'function') {
            await tryAutoRejoin().catch(e => console.error('[CourtSide] tryAutoRejoin failed', e));
        }
    }
}

// =============================================================================
// ENTRY POINT
// =============================================================================
//
// DOMContentLoaded fires after the HTML is fully parsed AND all synchronous
// <script> tags have been fetched and executed. This is the correct event for
// Vercel deployments where scripts are fetched in parallel over HTTP/2:
//   - It guarantees polish.js, passport.js, app.js, logic.js, sync.js are
//     all fully evaluated before initApp() touches any of their exports.
//   - It fires before images/fonts finish loading (unlike window 'load'),
//     so there is no perceived delay.
//
// The window 'load' listener in passport.js (bootApp) is intentionally kept
// as a second entry point — DOMContentLoaded calls initApp() for the sync
// work, and 'load' calls bootApp() for the async network work. Both are
// idempotent: if bootApp() runs twice it is a no-op the second time because
// it checks window._passport before re-initialising.
//
// DO NOT add window.onload = ... anywhere in this file. Assigning window.onload
// overwrites any previously assigned handler and causes boot steps to be
// silently skipped.
// =============================================================================

window.addEventListener('DOMContentLoaded', () => {
    initApp().catch(err => {
        console.error('[CourtSide] initApp() failed:', err);
        // Surface the error in the on-screen banner (defined in index.html)
        if (typeof _csShowError === 'function') {
            _csShowError('App init failed: ' + (err?.message || err));
        }
    });
});