// =============================================================================
// COURTSIDE PRO — app.js
// Responsibilities: State management, UI rendering, player management,
//                  overlays, menus, persistence.
// Depends on: logic.js (loaded after this file)
// =============================================================================

let passport  = null;
let inviteQR  = null;
let supabase  = null;

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------
let squad = [];
let currentMatches = [];
let playerQueue   = [];
let activeCourts  = 1;
let roundHistory  = [];
let previousRoundSnapshot = null;
let selectedPlayerIndex = null;
let pressTimer = null;
let isLongPress = false;

// ---------------------------------------------------------------------------
// PERSISTENCE
// ---------------------------------------------------------------------------

function saveToDisk() {
    // Cap roundHistory to last 10 entries — enough for undo, keeps localStorage lean
    const historySlice = roundHistory.slice(-10);
    localStorage.setItem('cs_pro_vault', JSON.stringify({ squad, currentMatches, roundHistory: historySlice, playerQueue, activeCourts }));
}

// ---------------------------------------------------------------------------
// FIELD MIGRATION
// ---------------------------------------------------------------------------
function migratePlayer(p) {
    if (p.rating           == null) p.rating           = 1200;
    if (p.wins             == null) p.wins             = 0;
    if (p.games            == null) p.games            = 0;
    if (p.streak           == null) p.streak           = 0;
    if (p.sessionPlayCount == null) p.sessionPlayCount = 0;
    if (p.waitRounds       == null) p.waitRounds       = 0;
    if (p.consecutiveGames == null) p.consecutiveGames = 0;
    if (p.forcedRest       == null) p.forcedRest       = false;
    if (p.active           == null) p.active           = true;
    if (p.teammateHistory  == null) p.teammateHistory  = {};
    if (p.opponentHistory  == null) p.opponentHistory  = {};
    return p;
}

function loadFromDisk() {
    const saved = localStorage.getItem('cs_pro_vault');
    if (saved) {
        try {
            const data = JSON.parse(saved);
            squad          = data.squad        || [];
            roundHistory   = data.roundHistory || [];

            squad.forEach(migratePlayer);

            currentMatches = (data.currentMatches || []).filter(m => {
                return m.teams.flat().every(name => squad.find(p => p.name === name));
            });

            playerQueue  = (data.playerQueue || [])
                .filter(name => squad.find(p => p.name === name));
            activeCourts = (Number.isInteger(data.activeCourts) && data.activeCourts >= 1)
                ? data.activeCourts : 1;
            setTimeout(() => {
                const courtInput = document.getElementById('courtCountInput');
                if (courtInput) courtInput.value = activeCourts;
            }, 0);

            renderSquad();
            renderSavedMatches();
            renderQueueStrip();
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

function renderSavedMatches() {
    if (currentMatches.length === 0) return;
    const container = document.getElementById('matchContainer');
    container.innerHTML = '';
    currentMatches.forEach((m, i) => {
        const tAObjects = m.teams[0].map(n => findP(n));
        const tBObjects = m.teams[1].map(n => findP(n));
        if (tAObjects.some(p => !p) || tBObjects.some(p => !p)) return;
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
        el.value = '';
        return;
    }
    squad.push({
        name,
        active:           true,
        wins:             0,
        games:            0,
        streak:           0,
        sessionPlayCount: 0,
        rating:           1200,
        consecutiveGames:  0,
        forcedRest:        false,
        teammateHistory:   {},
        opponentHistory:   {},
    });
    el.value = '';
    if (!playerQueue.includes(name)) playerQueue.push(name);
    renderSquad();
    renderQueueStrip();
    checkNextButtonState();
    saveToDisk();
}

function editPlayerName() {
    const p = squad[selectedPlayerIndex];
    const oldName = p.name;
    const newName = prompt('Edit Name:', p.name);
    if (newName && newName.trim()) {
        p.name = newName.trim();
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
    playerQueue = playerQueue.filter(n => n !== removedName);

    closeMenu();
    renderSquad();
    const container = document.getElementById('matchContainer');
    container.innerHTML = '';
    renderSavedMatches();
    checkNextButtonState();
    saveToDisk();

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
        <div class="player-chip ${p.active ? 'active' : 'resting'} ${p.forcedRest ? 'forced-rest' : ''}"
             onmousedown="startPress(${i})"
             onmouseup="endPress(${i})"
             ontouchstart="startPress(${i})"
             ontouchend="endPress(${i})"
             oncontextmenu="return false;">
            ${Avatar.html(p.name)}
            <span class="chip-name">${escapeHTML(p.name)}${!p.active ? ' ☕' : ''}${p.forcedRest ? ' 🔄' : ''}${!p.forcedRest && p.streak >= 4 ? ' 🔥' : ''}</span>
        </div>
    `);
    container.innerHTML = chips.join('');
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
    const canProceed = currentMatches.length === 0;
    btn.style.opacity       = canProceed ? '1'       : '0.4';
    btn.style.pointerEvents = canProceed ? 'auto'    : 'none';
    btn.style.cursor        = canProceed ? 'pointer' : 'default';
    btn.style.background    = canProceed ? 'var(--accent)' : '#2a2a3a';
    btn.textContent         = currentMatches.length === 0 ? 'Start Session' : 'Running…';
}

function setCourts(n) {
    const val = Math.max(1, parseInt(n) || 1);
    const input = document.getElementById('courtCountInput');
    if (input) input.value = val;
    if (activeCourts === val) return;
    activeCourts = val;
    saveToDisk();

    if (currentMatches.length === 0) {
        if (typeof showSessionToast === 'function') showSessionToast(`🏀 ${activeCourts} court${activeCourts > 1 ? 's' : ''} set`);
        return;
    }

    if (confirm(`Apply ${activeCourts} court${activeCourts > 1 ? 's' : ''} now? This will reset the current round.`)) {
        currentMatches = [];
        document.getElementById('matchContainer').innerHTML = '';
        const onCourt = squad.filter(p => p.active);
        onCourt.forEach(p => {
            if (!playerQueue.includes(p.name)) playerQueue.unshift(p.name);
        });
        generateMatches();
    } else {
        activeCourts = currentMatches.length || 1;
        if (input) input.value = activeCourts;
        saveToDisk();
    }
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
        title.innerText = 'Session Hub';
        content.innerHTML = `
            <div id="syncStatusMsg" class="sync-status" style="display:none;"></div>

            ${isOnlineSession ? `
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

                ${_supportSectionHTML()}
            ` : `
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

                ${_supportSectionHTML()}
            `}
        `;

        if (isOnlineSession) {
            if (!currentRoomCode) {
                console.error('[CourtSide] generateQR: currentRoomCode is null or undefined — QR not generated');
                const qrDiv = document.getElementById('qrcode');
                if (qrDiv) qrDiv.innerHTML = '<p style="color:#ef4444;font-size:12px;text-align:center;">Room code missing — try ending and restarting the session.</p>';
            } else {
                const joinUrl = window.location.origin + window.location.pathname + '?join=' + currentRoomCode + '&role=player';
                console.log('[CourtSide] Generating QR for:', joinUrl);
                const QRCtor = window.QRCodeConstructor || window.QRCode;
                const qrDiv  = document.getElementById('qrcode');
                if (qrDiv && QRCtor) {
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
// ---------------------------------------------------------------------------

function generateQR() {
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

function _supportSectionHTML() {
    return `
        <hr style="margin:28px 0; border:none; border-top:1px solid var(--border);">

        <div style="display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap;">

        <div style="flex:1 1 0; min-width:140px;">
            <div class="sync-section-label">🐛 Report a Bug</div>
            <p style="font-size:0.75rem; color:var(--text-muted); margin:0 0 12px;">
                Something broken? Let the dev know.
            </p>
            <button class="btn-main" style="width:100%; background:#334155; color:#fff;"
                onclick="openBugReportModal()">
                🐛 Report a Bug
            </button>
        </div>

        <div style="flex:1 1 0; min-width:140px;">
            <div class="sync-section-label">☕ Support the Dev</div>
            <p style="font-size:0.75rem; color:var(--text-muted); margin:0 0 16px;">
                If Courtside Pro saves you time, consider buying the dev a coffee.
            </p>
            <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap; justify-content:center;">
                <div style="text-align:center;">
                    <div style="font-size:0.65rem; color:var(--text-muted); margin-bottom:6px; letter-spacing:0.05em;">INSTAPAY / PAYMAYA</div>
                    <img src="data:image/png;base64,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" alt="PayMaya QR"
                        style="width:140px; height:140px; border-radius:10px; display:block;" />
                </div>
                <a href="https://ko-fi.com/willemaaron" target="_blank" rel="noopener"
                    style="display:inline-flex; align-items:center; gap:8px;
                           background:#FF5E5B; color:#fff; font-weight:700;
                           font-size:0.82rem; padding:12px 20px; border-radius:12px;
                           text-decoration:none; white-space:nowrap;">
                    ☕ Ko-fi
                </a>
            </div>
        </div>

        </div>
    `;
}

function openBugReportModal() {
    let modal = document.getElementById('bugReportModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'bugReportModal';
        modal.style.cssText = `
            position:fixed; inset:0; background:rgba(0,0,0,0.7);
            display:flex; align-items:center; justify-content:center;
            z-index:9999; padding:20px; box-sizing:border-box;
        `;
        modal.innerHTML = `
            <div style="background:var(--surface1,#1e293b); border:1px solid var(--border,#334155);
                        border-radius:16px; padding:24px; width:100%; max-width:400px;
                        box-shadow:0 20px 60px rgba(0,0,0,0.5);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                    <div style="font-weight:700; font-size:1rem; color:#fff;">🐛 Report a Bug</div>
                    <button onclick="closeBugReportModal()" style="background:none; border:none;
                            color:var(--text-muted,#94a3b8); font-size:1.2rem; cursor:pointer; padding:4px;">✕</button>
                </div>
                <p style="font-size:0.75rem; color:var(--text-muted,#94a3b8); margin:0 0 12px;">
                    Something broken? Let the dev know.
                </p>
                <textarea id="bugReportModalText"
                    placeholder="Describe what happened…"
                    rows="5"
                    style="width:100%; background:var(--bg2,#0f172a); border:1.5px solid var(--border,#334155);
                           color:#fff; padding:14px; border-radius:12px; margin-bottom:12px;
                           outline:none; font-size:14px; font-family:inherit;
                           resize:vertical; box-sizing:border-box;"
                ></textarea>
                <div style="display:flex; gap:10px;">
                    <button class="btn-main" style="flex:1; background:#334155; color:#fff;"
                        onclick="closeBugReportModal()">Cancel</button>
                    <button class="btn-main" style="flex:1; background:var(--accent,#38bdf8); color:#000;"
                        onclick="submitBugReport()">📨 Send Report</button>
                </div>
            </div>
        `;
        modal.addEventListener('click', function(e) {
            if (e.target === modal) closeBugReportModal();
        });
        document.body.appendChild(modal);
    } else {
        modal.style.display = 'flex';
        const ta = document.getElementById('bugReportModalText');
        if (ta) ta.value = '';
    }
}

function closeBugReportModal() {
    const modal = document.getElementById('bugReportModal');
    if (modal) modal.style.display = 'none';
}

function submitBugReport() {
    const text = (document.getElementById('bugReportModalText')?.value || '').trim();
    if (!text) {
        alert('Please describe the bug before sending.');
        return;
    }
    const subject = encodeURIComponent('[Courtside Pro] Bug Report');
    const body = encodeURIComponent(
        'Bug Description:\n' + text +
        '\n\n---\n' +
        'App version: Courtside Pro\n' +
        'Time: ' + new Date().toLocaleString() + '\n' +
        'Squad size: ' + (squad?.length ?? 'N/A') + '\n' +
        'Active courts: ' + (activeCourts ?? 'N/A')
    );
    window.open('mailto:iamwillempacardo@gmail.com?subject=' + subject + '&body=' + body);
    closeBugReportModal();
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

function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// UNDO LAST ROUND
// ---------------------------------------------------------------------------

function updateUndoButton() {
    let btn = document.getElementById('undoRoundBtn');
    if (!btn) return;
    btn.style.display  = roundHistory.length > 0 ? 'inline-flex' : 'none';
}

function undoLastRound() {
    if (roundHistory.length === 0) return;
    if (!confirm('Undo the last round? This will reverse all ELO changes.')) return;

    const snapshot = roundHistory.pop();

    squad = snapshot.squadSnapshot.map(s => ({ ...s }));
    currentMatches = snapshot.matches.map(m => ({ ...m, winnerTeamIndex: null }));
    if (snapshot.queueSnapshot) playerQueue = [...snapshot.queueSnapshot];

    renderSquad();
    rebuildMatchCardIndices();
    renderQueueStrip();

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
    if (isOnlineSession && isOperator) {
        pushStateToSupabase();
        // Broadcast undo state immediately so players see the reverted matches
        if (typeof broadcastGameState === 'function') broadcastGameState();
    }
    Haptic.bump();
    showSessionToast('↩ Last round undone');
}

// ---------------------------------------------------------------------------
// STATS OVERLAY — TABS
// ---------------------------------------------------------------------------

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
// PLAYER CARDS
// ---------------------------------------------------------------------------

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

async function sharePlayerCard() {
    const card = document.querySelector('.player-card');
    if (!card) return;

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
    const m = currentMatches[matchIdx];
    if (!m) return;

    const tA = (m.teams[0] || []).join(' & ');
    const tB = (m.teams[1] || []).join(' & ');

    try {
        const W = 1080, H = 1920;
        const canvas = document.createElement('canvas');
        canvas.width  = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#08080e';
        ctx.fillRect(0, 0, W, H);

        const glow1 = ctx.createRadialGradient(W/2, 380, 0, W/2, 380, 680);
        glow1.addColorStop(0,   'rgba(0,255,163,0.13)');
        glow1.addColorStop(0.5, 'rgba(0,255,163,0.04)');
        glow1.addColorStop(1,   'rgba(0,255,163,0)');
        ctx.fillStyle = glow1;
        ctx.fillRect(0, 0, W, H);

        const glow2 = ctx.createRadialGradient(W/2, H-200, 0, W/2, H-200, 500);
        glow2.addColorStop(0, 'rgba(0,200,120,0.10)');
        glow2.addColorStop(1, 'rgba(0,200,120,0)');
        ctx.fillStyle = glow2;
        ctx.fillRect(0, 0, W, H);

        if (typeof _drawGrain       === 'function') _drawGrain(ctx, W, H, 0.018);
        if (typeof _drawCourtLines  === 'function') _drawCourtLines(ctx, W, H);
        if (typeof _drawSilhouettes === 'function') _drawSilhouettes(ctx, W, H);

        ctx.save();
        ctx.shadowColor = 'rgba(0,255,163,0.6)';
        ctx.shadowBlur  = 28;
        ctx.fillStyle   = '#00ffa3';
        ctx.font        = 'bold 52px "Arial Narrow", Arial, sans-serif';
        ctx.textAlign   = 'center';
        ctx.fillText('THE COURTSIDE', W/2, 168);
        ctx.restore();

        const lineGrad = ctx.createLinearGradient(W/2-220, 0, W/2+220, 0);
        lineGrad.addColorStop(0,   'rgba(0,255,163,0)');
        lineGrad.addColorStop(0.5, 'rgba(0,255,163,0.5)');
        lineGrad.addColorStop(1,   'rgba(0,255,163,0)');
        ctx.strokeStyle = lineGrad;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(W/2-220, 188); ctx.lineTo(W/2+220, 188);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(W/2-52, 225, 8, 0, Math.PI*2);
        ctx.fillStyle = '#00ffa3';
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = '500 26px Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('LIVE NOW', W/2-30, 232);
        ctx.textAlign = 'center';

        const divGrad = ctx.createLinearGradient(80, 310, W-80, 310);
        divGrad.addColorStop(0,   'rgba(0,255,163,0)');
        divGrad.addColorStop(0.3, 'rgba(0,255,163,0.4)');
        divGrad.addColorStop(0.7, 'rgba(0,255,163,0.4)');
        divGrad.addColorStop(1,   'rgba(0,255,163,0)');
        ctx.strokeStyle = divGrad;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(80, 310); ctx.lineTo(W-80, 310);
        ctx.stroke();

        const midY = H * 0.46;
        if (typeof _drawTeamBlock === 'function') {
            ctx.save(); ctx.textAlign = 'center';
            _drawTeamBlock(ctx, W/2, midY - 260, tA, '#ffffff', W);
            ctx.restore();
        } else {
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 88px "Arial Narrow", Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(tA, W/2, midY - 260);
        }

        ctx.beginPath();
        ctx.arc(W/2, midY, 88, 0, Math.PI*2);
        ctx.strokeStyle = 'rgba(0,255,163,0.15)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(W/2, midY, 72, 0, Math.PI*2);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fill();
        ctx.fillStyle = '#00ffa3';
        ctx.font = 'bold 58px "Arial Narrow", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('VS', W/2, midY + 20);

        if (typeof _drawTeamBlock === 'function') {
            ctx.save(); ctx.textAlign = 'center';
            _drawTeamBlock(ctx, W/2, midY + 160, tB, '#ffffff', W);
            ctx.restore();
        } else {
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 88px "Arial Narrow", Arial, sans-serif';
            ctx.fillText(tB, W/2, midY + 220);
        }

        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.font = '500 28px Arial, sans-serif';
        ctx.fillText('@thecourtsidepro', W/2, H - 80);

        canvas.toBlob(async (blob) => {
            if (!blob) { showSessionToast('Could not generate poster'); return; }
            const file = new File([blob], 'courtside-aura.png', { type: 'image/png' });
            try {
                if (navigator.share && navigator.canShare({ files: [file] })) {
                    await navigator.share({
                        title: 'CourtSide Pro',
                        text:  tA + ' vs ' + tB + ' - who you got?',
                        files: [file],
                    });
                } else {
                    const a = document.createElement('a');
                    a.href     = URL.createObjectURL(blob);
                    a.download = 'courtside-aura.png';
                    a.click();
                }
                if (typeof Haptic !== 'undefined') Haptic.success();
            } catch (shareErr) {
                if (shareErr.name !== 'AbortError') showSessionToast('Could not share poster');
            }
        }, 'image/png');

    } catch (e) {
        console.error('Aura poster failed:', e);
        showSessionToast('Could not generate poster');
    }
}

// ---------------------------------------------------------------------------
// WEEKLY LEADERBOARD
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

let playRequests = [];

function _iwtpShow(id) {
    ['iwtpChoiceView','iwtpNewPlayerView','iwtpExistingView','iwtpSpectatorView'].forEach(v => {
        const el = document.getElementById(v);
        if (el) el.style.display = v === id ? 'block' : 'none';
    });
}

function showIWTPChoice() { _iwtpShow('iwtpChoiceView'); }

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

function confirmSpectateAs(name) {
    localStorage.setItem('cs_spectator_name', name);
    document.getElementById('iwtpSpectatorName').textContent    = name.toUpperCase();
    document.getElementById('iwtpSpectatorSubtitle').textContent = 'Live view — read only';
    _iwtpShow('iwtpSpectatorView');
    document.body.classList.add('spectator-mode');
    Haptic.success();
    showSessionToast(`👁 Watching as ${name}`);
}

function collapseIWTPSheet() {
    const sheet = document.getElementById('iwantToPlaySheet');
    if (!sheet) return;
    sheet.style.transition = 'transform 0.4s cubic-bezier(0.22,1,0.36,1), opacity 0.3s ease';
    sheet.style.transform  = 'translateY(100%)';
    sheet.style.opacity    = '0';
    setTimeout(() => { sheet.style.display = 'none'; }, 420);
    Haptic.tap();
}

async function submitIWantToPlay() {
    const input = document.getElementById('iwtpNameInput');
    const name  = (input?.value || '').trim();
    const btn   = document.getElementById('iwtpSendBtn');

    if (!name) { showSessionToast('Please enter your name first.'); input?.focus(); return; }
    if (!currentRoomCode) { showSessionToast('Not connected to a session.'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

    try {
        const res = await fetch('/api/play-request', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ room_code: currentRoomCode, name }),
        });

        if (res.ok) {
            localStorage.setItem('cs_spectator_name', name);
            collapseIWTPSheet();
            setTimeout(() => showSessionToast('🏀 Request sent! Pending host approval…'), 300);
            Haptic.success();
        } else { throw new Error('Failed'); }
    } catch {
        if (btn) { btn.disabled = false; btn.textContent = 'Send Request'; }
        showSessionToast('Could not send request. Try again.');
        Haptic.error();
    }
}

function checkIWTPSmartRecognition() {
    const sheet = document.getElementById('iwantToPlaySheet');
    if (!sheet || !isOnlineSession || isOperator) return;

    const savedName = localStorage.getItem('cs_spectator_name');
    if (savedName) {
        const match = squad.find(p => p.name.toLowerCase() === savedName.toLowerCase());
        if (match) { confirmSpectateAs(match.name); return; }
    }
    showIWTPChoice();
}

let _lastSeenRequestIds = new Set();

async function pollPlayRequests() {
    if (!isOnlineSession || !isOperator || !currentRoomCode) return;
    try {
        const res  = await fetch(`/api/play-request?room_code=${encodeURIComponent(currentRoomCode)}`);
        const data = await res.json();
        const incoming = data.requests || [];
        playRequests = incoming;

        incoming.forEach(r => {
            if (!_lastSeenRequestIds.has(r.id)) {
                _lastSeenRequestIds.add(r.id);
                showJoinNotification(r.name, r.id, r.player_uuid || null);
            }
        });

        const badge = document.getElementById('playRequestsBadge');
        const count = document.getElementById('playRequestsCount');
        if (badge && count) {
            badge.style.display = playRequests.length > 0 ? 'flex' : 'none';
            count.textContent   = playRequests.length;
        }
    } catch { /* silent */ }
}

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
    const notif  = document.getElementById('joinNotification');
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
    setTimeout(processNotifQueue, 400);
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
    if (!squad.find(p => p.name === name)) {
        squad.push({ name, uuid: playerUUID || null, rating: 1000, wins: 0, games: 0, streak: 0, active: true });
    }

    window._sessionUUIDMap = window._sessionUUIDMap || {};
    if (playerUUID) window._sessionUUIDMap[name] = playerUUID;

    const token = _makeApprovalToken();
    window._approvedPlayers = window._approvedPlayers || {};
    window._approvedPlayers[playerUUID || name] = { token, name, uuid: playerUUID, approvedAt: Date.now() };

    renderSquad();
    saveToDisk();
    // Broadcast squad update immediately — don't wait for DB debounce
    if (typeof broadcastGameState === 'function') broadcastGameState();

    showSessionToast(`✅ ${name} added`);
    Haptic.success();

    if (typeof memberApprove === 'function' && playerUUID) {
        memberApprove(playerUUID);
    }

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

const _startPolling = () => {
    pollPlayRequests();
    setInterval(() => { if (isOnlineSession && isOperator) pollPlayRequests(); }, 10000);
};

function updateIWTPVisibility() {
    const sheet = document.getElementById('iwantToPlaySheet');
    if (!sheet) return;
    const show = isOnlineSession && !isOperator;
    sheet.style.display = show ? 'flex' : 'none';
    if (show) checkIWTPSmartRecognition();
}

// =============================================================================
// PASSPORT INTEGRATION
// =============================================================================

function passportInit() {
    const passport = Passport.init();
    return passport;
}

function passportRename() {
    const passport = Passport.get();
    if (!passport) return;

    const newName = prompt('Update your name:', passport.playerName);
    if (!newName || !newName.trim()) return;

    const trimmed = newName.trim();
    const oldName = passport.playerName;

    Passport.rename(trimmed);
    if (typeof PlayerMode !== 'undefined') {
        PlayerMode._renderIdentity(Passport.get());
    }
    SidelineView.refresh();

    if (typeof isOnlineSession !== 'undefined' && isOnlineSession && currentRoomCode) {
        if (typeof broadcastNameUpdate === 'function') {
            broadcastNameUpdate(passport.playerUUID, oldName, trimmed);
        }
    }

    if (typeof isOnlineSession !== 'undefined' && isOnlineSession && currentRoomCode && typeof memberRename === 'function') {
        memberRename(passport.playerUUID, trimmed);
    }

    showSessionToast(`✅ Name updated to ${trimmed}`);
}

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
    SidelineView.refresh();

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
 * HOST dispatches win signals after selecting winners.
 * Called from setWinner() in logic.js.
 *
 * KEY FIX: broadcastGameState() is called HERE, at the end of dispatchWinSignals(),
 * AFTER the winning team is recorded in currentMatches. This means players see
 * the winner selection on their feed the instant the host taps a team box —
 * not after the next round is generated.
 */
async function dispatchWinSignals(mIdx, skipBroadcast = false) {
    if (!isOperator || !currentRoomCode) return;
    const m = currentMatches[mIdx];
    if (!m || m.winnerTeamIndex === null) return;

    const winIdx  = m.winnerTeamIndex;
    const loseIdx = winIdx === 0 ? 1 : 0;
    const uuidMap = window._sessionUUIDMap || {};
    const label   = `Game ${mIdx + 1}`;

    const resolveUUID = (name) => {
        const member = squad.find(p => p.name === name);
        return member?.uuid || uuidMap[name] || null;
    };

    const winnerNames = m.teams[winIdx]  || [];
    const loserNames  = m.teams[loseIdx] || [];
    const winnerUUIDs = winnerNames.map(resolveUUID).filter(Boolean);
    const loserUUIDs  = loserNames .map(resolveUUID).filter(Boolean);

    // 1. Broadcast match result (winner banner + haptic for players in this game)
    const winnerDisplayNames = winnerNames.join(' & ');
    if (typeof _broadcast === 'function' && isOnlineSession) {
        _broadcast('match_resolved', {
            winnerNames:  winnerDisplayNames,
            winnerUUIDs,
            loserUUIDs,
            gameLabel:    label,
        });
    }

    // 2. Broadcast game state so players see winner selection on match card.
    //    Skip when caller (processCourtResult) will broadcast after building
    //    the new lineup — so players receive one clean update with the next game.
    if (!skipBroadcast && typeof broadcastGameState === 'function' && isOnlineSession) {
        broadcastGameState();
    }

    // 3. Durable DB fallback
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

function _installPassportIWTPOverride() {
    const _originalCheckIWTP = checkIWTPSmartRecognition;
    checkIWTPSmartRecognition = function() {
        const passport = Passport.get();
        const sheet    = document.getElementById('iwantToPlaySheet');
        if (!sheet || !isOnlineSession || isOperator) return;

        if (passport && passport.playerName) {
            showPassportWelcome(passport);
            return;
        }
        _originalCheckIWTP();
    };
}

function showPassportWelcome(passport) {
    const sheet = document.getElementById('iwantToPlaySheet');
    if (!sheet) return;

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
            collapseIWTPSheet();
            setTimeout(() => { SidelineView.show(); startSignalPolling(); }, 450);
            showSessionToast('🏀 Request sent! Waiting for host approval…');
            Haptic.success();
        } else { throw new Error('Failed'); }
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
// initApp
// =============================================================================

async function initApp() {

    try {
        const _raw = localStorage.getItem('cs_player_passport');
        passport = _raw ? JSON.parse(_raw) : null;
    } catch (e) {
        console.warn('[CourtSide] initApp: localStorage read failed', e);
        passport = null;
    }

    if (!passport && typeof Passport !== 'undefined') {
        passport = Passport.init();
    }

    window._passport = passport;

    if (typeof InviteQR !== 'undefined') {
        inviteQR = InviteQR;
    }

    if (typeof _installPassportIWTPOverride === 'function') {
        _installPassportIWTPOverride();
    }

    try {
        loadFromDisk();
    } catch (e) {
        console.error('[CourtSide] initApp: loadFromDisk failed', e);
    }

    if (typeof bootApp === 'function') {
        await bootApp();
    } else {
        console.warn('[CourtSide] initApp: bootApp not found, falling back to tryAutoRejoin');
        if (typeof tryAutoRejoin === 'function') {
            await tryAutoRejoin().catch(e => console.error('[CourtSide] tryAutoRejoin failed', e));
        }
    }
}

// =============================================================================
// ENTRY POINT
// =============================================================================

window.addEventListener('DOMContentLoaded', () => {
    initApp().catch(err => {
        console.error('[CourtSide] initApp() failed:', err);
        if (typeof _csShowError === 'function') {
            _csShowError('App init failed: ' + (err?.message || err));
        }
    });
});