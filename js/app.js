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
    if (p.achievements     == null) p.achievements     = [];
    if (!p.uuid) p.uuid = _generateUUID(); // Ensure everyone has an ID for achievements
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

            const squadPlayerNames = new Set(squad.map(p => p.name));
            currentMatches = (data.currentMatches || []).filter(m =>
                m.teams.flat().every(name => squadPlayerNames.has(name))
            );

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
        alert('Player already exists!');
        el.value = '';
        return;
    }
    squad.push({
        name,
        uuid:             _generateUUID(),
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
        achievements:      [],
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
    const p = squad[selectedPlayerIndex];
    if (!p) return;

    showConfirmationModal({
        title: `Delete ${p.name}?`,
        message: 'This will remove the player from the squad and all current matches. This action cannot be undone.',
        confirmText: 'Yes, Delete Player',
        isDestructive: true,
        onConfirm: () => {
            const removedName = p.name;
            const removedUUID = p.uuid || null;

            squad.splice(selectedPlayerIndex, 1);
            currentMatches = currentMatches.filter(m => !m.teams.flat().includes(removedName));
            playerQueue = playerQueue.filter(n => n !== removedName);

            closeMenu();
            renderSquad();
            rebuildMatchCardIndices(); // Use this to safely re-render matches
            checkNextButtonState();
            saveToDisk();

            if (isOnlineSession && typeof _broadcast === 'function') {
                _broadcast('player_removed', { playerName: removedName, playerUUID: removedUUID });
            }
        }
    });
}

function toggleRestingState() {
    squad[selectedPlayerIndex].active = !squad[selectedPlayerIndex].active;
    closeMenu();
    renderSquad();
    checkNextButtonState();
    saveToDisk();
}

/**
 * Removes a player from the session. Called by the host when a 'player_leaving'
 * broadcast event is received from a player.
 * @param {string} playerUUID - The UUID of the player leaving.
 * @param {string} playerName - The name of the player leaving.
 */
function removePlayerFromSession(playerUUID, playerName) {
    if (!playerUUID && !playerName) return;

    let playerIndex = -1;

    if (playerUUID) {
        playerIndex = squad.findIndex(p => p.uuid === playerUUID);
    }
    // Fallback to name if not found by UUID (e.g., older client)
    if (playerIndex === -1 && playerName) {
        playerIndex = squad.findIndex(p => p.name.toLowerCase() === playerName.toLowerCase());
    }

    if (playerIndex === -1) return; // Player not in squad

    const removedName = squad[playerIndex].name;
    squad.splice(playerIndex, 1);

    currentMatches = currentMatches.filter(m => !m.teams.flat().includes(removedName));
    playerQueue = playerQueue.filter(n => n !== removedName);

    // Ensure any players stranded by a disbanded match are returned to the queue
    if (typeof initQueue === 'function') initQueue();

    renderSquad();
    rebuildMatchCardIndices();
    renderQueueStrip();
    checkNextButtonState();
    saveToDisk();

    // Immediately notify all clients of the change
    if (typeof broadcastGameState === 'function') broadcastGameState();

    showSessionToast(`👋 ${removedName} left the session.`);
    Haptic.bump();
}
window.removePlayerFromSession = removePlayerFromSession;

// ---------------------------------------------------------------------------
// RENDERING
// ---------------------------------------------------------------------------

function renderSquad() {
    const container = document.getElementById('squadList');
    const chips = squad.map((p, i) => {
        const isNew = p.games === 0 && p.wins === 0;
        return `
        <div class="player-chip ${p.active ? 'active' : 'resting'} ${p.forcedRest ? 'forced-rest' : ''}"
             onmousedown="startPress(${i})"
             onmouseup="endPress(${i})"
             ontouchstart="startPress(${i})"
             ontouchend="endPress(${i})"
             oncontextmenu="return false;">
            ${Avatar.html(p.name)}
            <span class="chip-name">${escapeHTML(p.name)}${isNew ? '<span class="new-badge">NEW</span>' : ''}${!p.active ? ' ☕' : ''}${p.forcedRest ? ' 🔄' : ''}${!p.forcedRest && p.streak >= 4 ? ' 🔥' : ''}</span>
        </div>
    `});
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
    const menu = document.getElementById('actionMenu');
    if (!menu) return;

    const onCourt = new Set(currentMatches.flatMap(m => m.teams.flat()));
    const isPlaying = onCourt.has(p.name);

    menu.innerHTML = `
        <div class="menu-card">
            <h2>${escapeHTML(p.name)}</h2>
            <p>${p.active ? (isPlaying ? 'Currently Playing 🏸' : 'Ready for Rotation') : 'Taking a Break ☕'}</p>
            
            <button class="btn-main menu-btn" onclick="toggleRestingState()">
                ${p.active ? 'Take a Break ☕' : 'Return to Play'}
            </button>

            ${p.active && !isPlaying ? `
            <button class="btn-main menu-btn" style="background:var(--surface2); color:var(--text); border:1px solid var(--border);" onclick="movePlayerToFront()">
                Move to Front ⬆
            </button>
            ` : ''}

            <button class="btn-main menu-btn" style="background:var(--surface2); color:var(--text); border:1px solid var(--border);" onclick="editPlayerName()">
                Edit Name
            </button>

            <button class="btn-main menu-btn btn-danger" onclick="deletePlayer()">
                Remove Player
            </button>
            
            <button class="btn-cancel" onclick="closeMenu()">Cancel</button>
        </div>
    `;
    menu.style.display = 'flex';
}

function closeMenu() {
    document.getElementById('actionMenu').style.display = 'none';
    selectedPlayerIndex = null;
}

function movePlayerToFront() {
    const p = squad[selectedPlayerIndex];
    if (!p) return;
    
    // Remove from current spot in queue and add to front
    playerQueue = playerQueue.filter(n => n !== p.name);
    playerQueue.unshift(p.name);
    
    closeMenu();
    renderQueueStrip();
    saveToDisk();
    if (typeof broadcastGameState === 'function') broadcastGameState();
    Haptic.success();
    if (typeof showSessionToast === 'function') showSessionToast(`${p.name} moved to front`);
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
                <div style="text-align: center;">
                    <button class="btn-main" style="width: auto; display: inline-flex; background:rgba(239,68,68,0.1); color:#ef4444; flex: initial;"
                        onclick="confirmEraseAllData()">WIPE ALL DATA</button>
                </div>
                
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
        <div style="margin-top: auto; padding-top: 24px;">
            <hr style="margin:0 0 28px; border:none; border-top:1px solid var(--border);">

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

function showConfirmationModal({ title, message, confirmText, isDestructive, onConfirm }) {
    // Remove existing modal if any
    document.getElementById('confirmationModal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'confirmationModal';
    modal.className = 'actionMenu'; // Reuse styles from actionMenu
    modal.style.zIndex = '10000'; // Ensure it's on top of all overlays, including player view (z-index: 6000)

    const confirmBtnClass = isDestructive ? 'btn-main btn-danger' : 'btn-main';

    modal.innerHTML = `
        <div class="menu-card">
            <h2>${escapeHTML(title)}</h2>
            <p>${escapeHTML(message)}</p>
            <button id="confirmBtn" class="${confirmBtnClass} menu-btn">${escapeHTML(confirmText)}</button>
            <button id="cancelBtn" class="btn-cancel">Cancel</button>
        </div>
    `;

    document.body.appendChild(modal);

    const confirmBtn = document.getElementById('confirmBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    
    const close = () => modal.remove();

    confirmBtn.onclick = () => {
        close();
        onConfirm();
    };

    cancelBtn.onclick = close;
    
    // Also close if clicking the backdrop
    modal.addEventListener('click', (e) => {
        if (e.target === modal) close();
    });
}

function eraseAllData() {
    localStorage.clear();
    location.reload();
}

function confirmEraseAllData() {
    showConfirmationModal({
        title: 'Wipe All Data?',
        message: 'This will permanently delete all players, matches, and session history. This action cannot be undone.',
        confirmText: 'Yes, Wipe Everything',
        isDestructive: true,
        onConfirm: eraseAllData
    });
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

async function openPlayerCard(idx) {
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
        <div id="pc-achievements-container"></div>
    `;

    document.getElementById('playerCardModal').style.display = 'flex';
    Haptic.bump();

    // Render achievements directly from local squad data
    const achievementsContainer = document.getElementById('pc-achievements-container');
    if (achievementsContainer) {
        if (window.Achievements) {
            const allAchHTML = Object.keys(window.Achievements).map(key => {
                const def = window.Achievements[key];
                const isUnlocked = p.achievements && p.achievements.includes(key);
                return `
                    <div class="pc-achievement-badge ${isUnlocked ? 'unlocked' : 'locked'}" 
                         title="${def.name}: ${def.description}">
                        ${def.icon}
                    </div>
                `;
            }).join('');

            achievementsContainer.innerHTML = `
                <div class="pc-section-title">Achievements</div>
                <div class="pc-achievements-grid">${allAchHTML}</div>
            `;
        }
    }
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

function _resolvePlayerForSession(name, incomingUUID) {
    const validUUID = incomingUUID && incomingUUID.trim().length > 0 ? incomingUUID : null;
    let player = null;
    let finalName = name;

    // 1. Priority: UUID (Canonical Identity)
    if (validUUID) {
        player = squad.find(p => p.uuid === validUUID);
        if (player) {
            // Update name if changed
            if (player.name !== name) {
                console.log(`[CourtSide] Updating name for ${player.uuid}: ${player.name} -> ${name}`);
                player.name = name;
            }
            return player;
        }
    }

    // 2. If not found by UUID, treat as NEW.
    //    Check for name collisions and auto-rename.
    let collision = squad.find(p => p.name.toLowerCase() === finalName.toLowerCase());
    let counter = 1;
    while (collision) {
        finalName = `${name} (${counter})`;
        collision = squad.find(p => p.name.toLowerCase() === finalName.toLowerCase());
        counter++;
    }

    // 3. Create new player
    player = {
        name: finalName,
        uuid: validUUID || _generateUUID(),
    };
    migratePlayer(player);
    squad.push(player);
    
    return player;
}

async function approvePlayRequest(name, id, playerUUID = null) {
    const player = _resolvePlayerForSession(name, playerUUID);
    const finalName = player.name;
    const validUUID = player.uuid;

    // Always fetch/refresh achievements if we have a valid UUID (new or adopted)
    if (player.uuid && window.fetchPlayerAchievements) {
        try {
            const fetched = await window.fetchPlayerAchievements(player.uuid);
            const achievementIds = fetched.map(a => a.achievement_id);
            // Merge with existing to avoid losing session-unlocked ones
            const currentSet = new Set(player.achievements || []);
            achievementIds.forEach(id => currentSet.add(id));
            player.achievements = Array.from(currentSet);
        } catch (e) {
            console.error(`Failed to fetch achievements for ${player.name}`, e);
        }
    }

    window._sessionUUIDMap = window._sessionUUIDMap || {};
    if (validUUID) window._sessionUUIDMap[player.name] = validUUID;

    const token = _makeApprovalToken();
    window._approvedPlayers = window._approvedPlayers || {};
    window._approvedPlayers[validUUID || player.name] = { token, name: player.name, uuid: validUUID, approvedAt: Date.now() };

    renderSquad();
    saveToDisk();
    // Broadcast squad update immediately — don't wait for DB debounce
    if (typeof broadcastGameState === 'function') broadcastGameState();

    showSessionToast(`✅ ${player.name} added`);
    Haptic.success();

    if (typeof memberApprove === 'function' && validUUID) {
        memberApprove(validUUID);
    }

    if (typeof broadcastApproval === 'function') {
        broadcastApproval(validUUID, player.name, token);
    }

    await denyPlayRequest(id);
}

function _makeApprovalToken() {
    const arr = new Uint8Array(12);
    (window.crypto || crypto).getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function _generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
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
    // Ensure the original long-press menu gets the correct class for styling
    document.getElementById('actionMenu')?.classList.add('actionMenu');

    initApp().catch(err => {
        console.error('[CourtSide] initApp() failed:', err);
        if (typeof _csShowError === 'function') {
            _csShowError('App init failed: ' + (err?.message || err));
        }
    });
});