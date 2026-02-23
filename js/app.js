// =============================================================================
// COURTSIDE PRO — app.js
// Responsibilities: State management, UI rendering, player management,
//                  overlays, menus, persistence.
// Depends on: logic.js (loaded after this file)
// =============================================================================

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------
let squad = [];
let currentMatches = [];
let selectedPlayerIndex = null;
let pressTimer = null;
let isLongPress = false;

// ---------------------------------------------------------------------------
// PERSISTENCE
// ---------------------------------------------------------------------------

function saveToDisk() {
    localStorage.setItem('cs_pro_vault', JSON.stringify({ squad, currentMatches }));
}

function loadFromDisk() {
    const saved = localStorage.getItem('cs_pro_vault');
    if (saved) {
        try {
            const data = JSON.parse(saved);
            squad = data.squad || [];
            currentMatches = (data.currentMatches || []).filter(m => {
                // FIX: Drop any saved match that references a player who no longer exists.
                // This prevents a crash in renderMatchCard when findP() returns undefined.
                return m.teams.flat().every(name => squad.find(p => p.name === name));
            });
            renderSquad();
            renderSavedMatches();
        } catch (e) {
            console.error('CourtSide: Failed to parse saved data.', e);
            squad = [];
            currentMatches = [];
        }
    }
    checkNextButtonState();
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
    const newName = prompt('Edit Name:', p.name);
    if (newName && newName.trim()) {
        p.name = newName.trim();
        // Also update name references inside currentMatches
        currentMatches.forEach(m => {
            m.teams = m.teams.map(team =>
                team.map(n => (n === p.name ? p.name : n))
            );
        });
        closeMenu();
        renderSquad();
        renderSavedMatches();
        saveToDisk();
    }
}

function deletePlayer() {
    if (!confirm('Remove this athlete?')) return;
    const removedName = squad[selectedPlayerIndex].name;
    squad.splice(selectedPlayerIndex, 1);

    // FIX: Remove any match that included the deleted player to prevent stale references
    currentMatches = currentMatches.filter(
        m => !m.teams.flat().includes(removedName)
    );

    closeMenu();
    renderSquad();

    // Re-render match container — some matches may have been removed
    const container = document.getElementById('matchContainer');
    container.innerHTML = '';
    renderSavedMatches();

    checkNextButtonState();
    saveToDisk();
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
            <div class="player-chip active sideline-chip">
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
        title.innerText = 'Performance Lab';
        const sorted   = [...squad].sort((a, b) => b.rating - a.rating);
        const topCount = Math.max(1, Math.ceil(squad.length * 0.3));
        const peak     = sorted.slice(0, topCount).sort((a, b) => a.name.localeCompare(b.name));
        const active   = sorted.slice(topCount).sort((a, b) => a.name.localeCompare(b.name));

        const winRate = (p) => p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0;

        const renderGroup = (label, list) => {
            if (list.length === 0) return '';
            const cards = list.map(p => `
                <div class="stats-card">
                    <div class="stats-name">${escapeHTML(p.name)}${p.streak >= 3 ? ' 🔥' : ''}</div>
                    <div class="stats-meta">${p.wins}W · ${p.games}G · ${winRate(p)}% WR</div>
                </div>
            `).join('');
            return `
                <div class="stats-group">
                    <div class="stats-header">${label}</div>
                    <div class="stats-grid">${cards}</div>
                </div>
            `;
        };

        content.innerHTML = renderGroup('Peak Performers', peak) + renderGroup('Active Roster', active);

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
                    <canvas id="qrCanvas"></canvas>
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
            // Show QR of room code for easy sharing
            QRCode.toCanvas(document.getElementById('qrCanvas'), currentRoomCode, {
                width: 180, margin: 2,
                color: { dark: '#000000', light: '#ffffff' }
            });
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
    const token = btoa(JSON.stringify({ squad, currentMatches }));
    const canvas = document.getElementById('qrCanvas');
    if (!canvas) return;
    QRCode.toCanvas(canvas, token, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' }
    }, err => {
        if (err) console.error('CourtSide: QR generation failed.', err);
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
// INIT
// ---------------------------------------------------------------------------

window.onload = loadFromDisk;