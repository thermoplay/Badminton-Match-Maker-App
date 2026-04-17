// =============================================================================
// COURTSIDE PRO — app.js
// Responsibilities: State management, UI rendering, player management,
//                  overlays, menus, persistence.
// Depends on: logic.js (loaded after this file)
// =============================================================================

let passport  = null;
let supabase  = null;

// ---------------------------------------------------------------------------
// SKILL TIER DEFINITIONS (Global)
// ---------------------------------------------------------------------------
window.TIER_WEIGHTS = { 'Novice': 1, 'Intermediate': 2, 'Advanced': 3 };
window.SKILL_LEVELS = ['Novice', 'Intermediate', 'Advanced'];
window.SPORT_ICONS  = { 'Badminton': '🏸', 'Tennis': '🎾', 'Pickleball': '🏓' };

window.getSkillWeight = p => window.TIER_WEIGHTS[p?.skillLevel] || window.TIER_WEIGHTS['Intermediate'];
window.getSkillIndex = p => window.SKILL_LEVELS.indexOf(p?.skillLevel || 'Intermediate');

// Global state is now managed by StateStore

let selectedPlayerIndex = null;
let pressTimer = null;
let isLongPress = false;
let swapSourceUUID = null;

// ---------------------------------------------------------------------------
// ACHIEVEMENT PRESS HANDLERS
// ---------------------------------------------------------------------------
let achPressTimer = null;
function startAchPress(key, pUUID = null) {
    achPressTimer = setTimeout(() => {
        if (typeof showAchievementDescription === 'function') {
            let p = null;
            const squad = (typeof StateStore !== 'undefined' ? StateStore.squad : null) || window.squad || [];
            if (pUUID) p = squad.find(x => (x.uuid || x.name) === pUUID);
            else if (typeof selectedPlayerIndex !== 'undefined' && selectedPlayerIndex !== null) p = StateStore.squad[selectedPlayerIndex];
            
            showAchievementDescription(key, p ? (p.achievements || []) : []);
            if (window.Haptic) Haptic.bump();
        }
        achPressTimer = null;
    }, 600);
}
function endAchPress(key) {
    clearTimeout(achPressTimer);
    achPressTimer = null;
}
window.startAchPress = startAchPress;
window.endAchPress = endAchPress;

// ---------------------------------------------------------------------------
// PERSISTENCE
// ---------------------------------------------------------------------------

function saveToDisk() {
    try {
        // Cap roundHistory to last 10 entries — enough for undo, keeps localStorage lean
        const historySlice = StateStore.roundHistory.slice(-10);
        const stateToSave = {
            squad: StateStore.squad,
            currentMatches: StateStore.currentMatches,
            roundHistory: historySlice,
            playerQueue: StateStore.playerQueue,
            activeCourts: StateStore.get('activeCourts'),
            courtNames: StateStore.get('courtNames'),
            isOpenParty: StateStore.get('isOpenParty') || false,
            guestList: StateStore.get('guestList') || [],
            lastUpdated: StateStore.get('lastUpdated'),
        };
        localStorage.setItem('cs_pro_vault', JSON.stringify(stateToSave));
    } catch (e) {
        console.warn('CourtSide: Failed to save to disk. Storage might be full.', e);
        if (typeof showSessionToast === 'function') showSessionToast('⚠️ Storage warning: Data not saved locally.');
    }
}

// ---------------------------------------------------------------------------
// FIELD MIGRATION
// ---------------------------------------------------------------------------
function migratePlayer(p) {
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
    if (p.partnerStats     == null) p.partnerStats     = {};
    if (p.form             == null) p.form             = [];
    if (p.achievements     == null) p.achievements     = [];
    if (p.matchHistory     == null) p.matchHistory     = [];
    if (p.spiritAnimal     == null) p.spiritAnimal     = null;
    return p;
}

function loadFromDisk() {
    const saved = localStorage.getItem('cs_pro_vault');
    if (saved) {
        try {
            const data = JSON.parse(saved);
            const loadedSquad = data.squad || [];
            loadedSquad.forEach(migratePlayer);

            const squadIds = new Set(loadedSquad.map(p => p.uuid || p.name));
            const loadedMatches = (data.currentMatches || []).filter(m =>
                m.teams.flat().every(id => squadIds.has(id))
            );

            const loadedQueue = (data.playerQueue || []).filter(id => loadedSquad.find(p => (p.uuid || p.name) === id));
            const loadedCourts = (Number.isInteger(data.activeCourts) && data.activeCourts >= 1)
                ? data.activeCourts : 1;

            StateStore.setState({
                squad: loadedSquad,
                roundHistory: data.roundHistory || [],
                currentMatches: loadedMatches,
                playerQueue: loadedQueue,
                activeCourts: loadedCourts,
                courtNames: data.courtNames || {},
                isOpenParty: data.isOpenParty || false,
            fairnessMultiplier: data.fairnessMultiplier ?? 5, // Default mid-point
            sport: data.sport || 'Badminton',
                guestList: data.guestList || [],
                lastUpdated: data.lastUpdated || Date.now(),
            });

            setTimeout(() => {
                const courtInput = document.getElementById('courtCountInput');
                if (courtInput) courtInput.value = loadedCourts;
            }, 0);

            renderSquad();
            if (typeof rebuildMatchCardIndices === 'function') rebuildMatchCardIndices();
            if (typeof renderQueueStrip === 'function') renderQueueStrip();
        } catch (e) {
            console.error('CourtSide: Failed to parse saved data.', e);
            StateStore.setState({ squad: [], currentMatches: [], roundHistory: [] });
        }
    }
    checkNextButtonState();
    updateUndoButton();
}

// ---------------------------------------------------------------------------
// PLAYER MANAGEMENT
// ---------------------------------------------------------------------------

function addPlayer() {
    const el = document.getElementById('playerName');
    const name = el.value.trim();
    if (!name) return;
    
    // Check for existing player (case-insensitive)
    const existing = StateStore.squad.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
        if (typeof showSessionToast === 'function') showSessionToast('⚠️ Player already exists!');
        else alert('Player already exists!');
        el.value = '';
        return;
    }

    const newUUID = _generateUUID();
    // Use migratePlayer to ensure all required logic fields (skillLevel, stats) are initialized
    const newPlayer = migratePlayer({
        name: name,
        uuid: newUUID,
        active: true,
        isGuest: true
    });
    
    const pId = newPlayer.uuid || newPlayer.name;
    const newQueue = [...StateStore.playerQueue];
    if (!newQueue.includes(pId)) newQueue.push(pId);

    // Explicitly trigger the StateStore setters to fire cloud sync and local persistence
    StateStore.set('squad', [...StateStore.squad, newPlayer]);
    StateStore.set('playerQueue', newQueue);

    // Connectivity: Force an immediate push to Supabase so spectators see the new player instantly
    if (window.isOnlineSession && window.isOperator && typeof pushStateToSupabase === 'function') {
        pushStateToSupabase(true);
    }

    el.value = '';
    renderSquad();
    if (typeof renderQueueStrip === 'function') renderQueueStrip();
    checkNextButtonState();
    if (window.Haptic) Haptic.success();
}

function editPlayerName() {
    const p = StateStore.squad[selectedPlayerIndex];
    if (!p) return;
    const oldName = p.name;

    closeMenu(); // Close the long-press menu first

    UIManager.prompt({
        title: 'Edit Player Name',
        initialValue: p.name,
        confirmText: 'Save Name',
        onConfirm: (newName) => {
            const trimmedNewName = newName.trim();
            if (!trimmedNewName) return;

            // Check for name collision (case-insensitive, but not against the player's own old name)
            if (StateStore.squad.some(player => player.name.toLowerCase() === trimmedNewName.toLowerCase() && player.name.toLowerCase() !== oldName.toLowerCase())) {
                alert('A player with this name already exists.');
                return;
            }

            if (typeof _applyNameUpdate === 'function') {
                _applyNameUpdate(p.uuid, oldName, trimmedNewName);
            }
        }
    });
}

let _isProcessingOpenPartyBatch = false;

function toggleOpenParty() {
    const current = StateStore.get('isOpenParty') || false;
    const next = !current;
    StateStore.set('isOpenParty', next);
    showSessionToast(`🔓 Open Party: ${next ? 'ON' : 'OFF'}`);

    if (next && window.playRequests?.length > 0 && !_isProcessingOpenPartyBatch) {
        _isProcessingOpenPartyBatch = true;
        (async () => {
            try {
                for (const r of [...window.playRequests]) {
                    // Abort batch approval if the toggle is flipped back OFF mid-process
                    if (!StateStore.get('isOpenParty')) break;
                    await approvePlayRequest(r.name, r.id, r.player_uuid || null);
                }
            } finally {
                _isProcessingOpenPartyBatch = false;
            }
        })();
    }
    renderOpenPartyToggle();
}
window.toggleOpenParty = toggleOpenParty;

function renderOpenPartyToggle() {
    const el = document.getElementById('slOpenPartyToggle');
    if (!el) return;
    const isOpen = StateStore.get('isOpenParty') || false;
    el.className = `open-party-toggle ${isOpen ? 'is-open' : 'is-closed'}`;
    el.innerHTML = isOpen 
        ? '<span>🔓</span> Open Party: ON' 
        : '<span>🔒</span> Open Party: OFF';
}

window.renderOpenPartyToggle = renderOpenPartyToggle;

/**
 * Forces a reconciliation of the player queue with the active squad.
 * Useful for fixing edge-case ordering issues or missing players.
 */
function resyncQueue() {
    if (window.isOperator === false) return;
    if (typeof initQueue === 'function') {
        initQueue();
        if (typeof renderQueueStrip === 'function') renderQueueStrip();
        if (typeof broadcastGameState === 'function') broadcastGameState(true);
        if (window.Haptic) Haptic.success();
    }
}
window.resyncQueue = resyncQueue;

// Expose UI functions to global scope for inline onclick handlers
window.showPlayRequests = showPlayRequests;
window.closePlayRequests = closePlayRequests;
window.notifApprove = notifApprove;
window.notifDecline = notifDecline;

function deletePlayer() {
    const p = StateStore.squad[selectedPlayerIndex];
    if (!p) return;

    UIManager.confirm({
        title: `Delete ${p.name}?`,
        message: 'This will remove the player from the squad and all current matches. This action cannot be undone.',
        confirmText: 'Yes, Delete Player',
        isDestructive: true,
        onConfirm: async () => {
            // BUG FIX: Centralize removal logic. This function handles state,
            // animation, and the required API call to update the database.
            if (typeof removePlayerFromSession === 'function') {
                await removePlayerFromSession(p.uuid, p.name);
            }
            closeMenu();
        }
    });
}

function initiateSwap(uuid) {
    swapSourceUUID = uuid;
    const p = StateStore.squad.find(x => x.uuid === uuid);
    closeMenu();
    showSessionToast(`Select another player to swap with ${p.name}`);
    renderSquad();
    Haptic.tap();
}

function completeSwap(targetUUID) {
    const p1 = StateStore.squad.find(x => x.uuid === swapSourceUUID);
    const p2 = StateStore.squad.find(x => x.uuid === targetUUID);
    
    if (p1 && p2 && typeof swapActivePlayers === 'function') {
        if (swapActivePlayers(p1.uuid, p2.uuid)) {
            showSessionToast(`Swapped ${p1.name} & ${p2.name}`);
            Haptic.success(); // StateStore.set in swapActivePlayers will trigger sync
        } else {
            showSessionToast('Could not swap players.');
        }
    }
    cancelSwap(); // Clears state and renders
}

function cancelSwap() {
    swapSourceUUID = null;
    closeMenu();
    renderSquad();
}

function toggleRestingState() {
    const p = StateStore.squad[selectedPlayerIndex];
    if (!p) return;
    closeMenu();
    togglePlayerActive(p.uuid);
}
function openSetSkillLevel() {
    const p = StateStore.squad[selectedPlayerIndex];
    if (!p) return;
    closeMenu();
    const pId = p.uuid || p.name;
    UIManager.confirm({
        title: `Set Skill Level for ${p.name}`,
        message: `
            <div style="display:flex; flex-direction:column; gap:10px; margin-top:16px;">
                <button class="btn-main" style="background:var(--bg2); color:var(--text); border:1px solid var(--border);" onclick="setPlayerSkillLevel('${pId}', 'Novice'); UIManager.hide();">Novice</button>
                <button class="btn-main" style="background:var(--bg2); color:var(--text); border:1px solid var(--border);" onclick="setPlayerSkillLevel('${pId}', 'Intermediate'); UIManager.hide();">Intermediate</button>
                <button class="btn-main" style="background:var(--bg2); color:var(--text); border:1px solid var(--border);" onclick="setPlayerSkillLevel('${pId}', 'Advanced'); UIManager.hide();">Advanced</button>
            </div>
        `,
        confirmText: 'Cancel', // Renamed to cancel as buttons handle action
        onConfirm: () => {}, // No action on confirm, buttons handle it
        isDestructive: false,
        showCancel: false, // Hide default cancel button
    });
}
window.openSetSkillLevel = openSetSkillLevel;

/** Opens the skill level picker specifically from the Player Card context. */
function openSetSkillLevelForCard(idx) {
    const p = StateStore.squad[idx];
    if (!p) return;
    
    const pId = p.uuid || p.name;
    UIManager.confirm({
        title: `Set Skill Level for ${p.name}`,
        message: `
            <div style="display:flex; flex-direction:column; gap:10px; margin-top:16px;">
                <button class="btn-main" style="background:var(--bg2); color:var(--text); border:1px solid var(--border);" 
                        onclick="setPlayerSkillLevel('${pId}', 'Novice'); UIManager.hide(); openPlayerCard(${idx});">Novice</button>
                <button class="btn-main" style="background:var(--bg2); color:var(--text); border:1px solid var(--border);" 
                        onclick="setPlayerSkillLevel('${pId}', 'Intermediate'); UIManager.hide(); openPlayerCard(${idx});">Intermediate</button>
                <button class="btn-main" style="background:var(--bg2); color:var(--text); border:1px solid var(--border);" 
                        onclick="setPlayerSkillLevel('${pId}', 'Advanced'); UIManager.hide(); openPlayerCard(${idx});">Advanced</button>
            </div>
        `,
        confirmText: 'Cancel',
        showCancel: false,
    });
}
window.openSetSkillLevelForCard = openSetSkillLevelForCard;

function setPlayerSkillLevel(id, level) {
    // Find by UUID or Name (to support both Passport holders and Guests)
    const p = StateStore.squad.find(x => x.uuid === id || x.name === id);
    if (!p) return;
    p.skillLevel = level;
    StateStore.set('squad', [...StateStore.squad]);
    renderSquad();
    if (typeof broadcastGameState === 'function') broadcastGameState(true);
    showSessionToast(`${p.name} is now ${level}`);
    Haptic.success();
}
window.setPlayerSkillLevel = setPlayerSkillLevel;

function _autoAddHostToSquad() {
    // This function runs on app start for the host.
    // If the host has a player passport from a previous session,
    // and they aren't already in the current squad, add them automatically.
    if (!passport || !passport.playerName) return;

    const hostName = passport.playerName;
    const hostUUID = passport.playerUUID;

    // Check if a player with this UUID or name already exists.
    const hostInSquad = StateStore.squad.find(p => p.uuid === hostUUID);
    const newQueue = [...StateStore.playerQueue];
    let changed = false;

    if (!hostInSquad) {
        const hostAsPlayer = migratePlayer({
            name: hostName,
            uuid: hostUUID,
            active: true
        });
        
        const existingIdx = newQueue.findIndex(u => u === hostUUID || u === hostName);
        if (existingIdx === -1) {
            newQueue.unshift(hostUUID);
        } else {
            newQueue[existingIdx] = hostUUID; // Transition name to UUID
        }
        
        StateStore.setState({
            squad: [hostAsPlayer, ...StateStore.squad],
            playerQueue: newQueue
        });
        changed = true;
        showSessionToast(`👋 Welcome, ${hostName}! You've been added to the rotation.`);
    } else {
        const existingIdx = newQueue.findIndex(u => u === hostUUID || u === hostName);
        if (existingIdx === -1) {
            newQueue.unshift(hostUUID); // Also add to front of queue
            StateStore.set('playerQueue', newQueue);
            changed = true;
        } else if (newQueue[existingIdx] === hostName) {
            newQueue[existingIdx] = hostUUID; // Standardize ID
            StateStore.set('playerQueue', newQueue);
            changed = true;
        }
        if (hostInSquad.active === false) {
            hostInSquad.active = true;
            StateStore.set('squad', [...StateStore.squad]);
            changed = true;
        }
    }

    if (changed) {
        renderSquad();
        if (typeof renderQueueStrip === 'function') renderQueueStrip();
    }
}

/** Removes a player from all local state arrays (squad, matches, queue). */
function _removePlayerFromLocalState(playerIndex) {
    const removedPlayer = StateStore.squad[playerIndex];
    const removedName = removedPlayer.name;
    const removedUUID = removedPlayer.uuid || null;

    const newSquad = [...StateStore.squad];
    newSquad.splice(playerIndex, 1);
    const removedId = removedUUID || removedName;
    const newMatches = StateStore.currentMatches.filter(m => !m.teams.flat().includes(removedId));
    const newQueue = StateStore.playerQueue.filter(u => u !== removedId);

    if (window._approvedPlayers) {
        // Remove by UUID and any potential name-based entry
        if (removedUUID) delete window._approvedPlayers[removedUUID]; 
        if (removedName && window._approvedPlayers[removedName]) delete window._approvedPlayers[removedName];
    }

    if (window._sessionUUIDMap) {
        const uuidMap = window._sessionUUIDMap;
        // Remove entry by the player's current name
        if (removedName && uuidMap[removedName] === removedUUID) delete uuidMap[removedName];
        // Iterate and remove any other entries that point to the removed UUID (e.g., old names)
        for (const key in uuidMap) {
            if (Object.prototype.hasOwnProperty.call(uuidMap, key) && uuidMap[key] === removedUUID) {
                delete uuidMap[key];
            }
        }
    }
    if (typeof playRequests !== 'undefined' && removedUUID) {
        const pendingRequest = playRequests.find(r => r.player_uuid === removedUUID);
        if (pendingRequest && typeof denyPlayRequest === 'function') {
            denyPlayRequest(pendingRequest.id);
        }
    }

    return { removedName, removedUUID, newSquad, newMatches, newQueue };
}

/** Updates all relevant UI components after a player has been removed. */
function _updateUIAfterPlayerRemoval() {
    renderSquad();
    if (typeof rebuildMatchCardIndices === 'function') rebuildMatchCardIndices();
    if (typeof renderQueueStrip === 'function') renderQueueStrip();
    checkNextButtonState();
    if (typeof window.initQueue === 'function') window.initQueue();
}

/** Sends a request to the backend to permanently remove the player from the session_members table. */
async function _removePlayerFromRemoteDB(playerUUID) {
    if (!isOperator || !playerUUID || !currentRoomCode || !operatorKey) return;
    try {
        await fetch('/api/play-request', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                room_code: currentRoomCode,
                player_uuid: playerUUID,
                operator_key: operatorKey
            })
        });
    } catch (e) {
        console.error('[CourtSide] Failed to remove member from DB session', e);
    }
}

/** Orchestrates the removal of a player from the session. */
async function removePlayerFromSession(playerUUID, playerName) {
    if (!playerUUID && !playerName) return;

    let pIndex = -1;
    if (playerUUID) {
        pIndex = StateStore.squad.findIndex(p => p.uuid === playerUUID);
    }
    if (pIndex === -1 && playerName) {
        pIndex = StateStore.squad.findIndex(p => p.name.toLowerCase() === playerName.toLowerCase());
    }

    if (pIndex === -1) return; // Player not in squad

    const { removedName, removedUUID, newSquad, newMatches, newQueue } = _removePlayerFromLocalState(pIndex);

    // Atomically update the global state to ensure consistency across the session
    StateStore.setState({
        squad: newSquad,
        currentMatches: newMatches,
        playerQueue: newQueue
    });

    _updateUIAfterPlayerRemoval();

    // Notify the player immediately so their UI resets to the menu
    if (typeof broadcastEvent === 'function') {
        broadcastEvent('player_removed', { playerUUID: removedUUID, playerName: removedName });
    }

    await _removePlayerFromRemoteDB(removedUUID);
    Haptic.bump();
}

window.removePlayerFromSession = removePlayerFromSession;

// ---------------------------------------------------------------------------
// RENDERING
// ---------------------------------------------------------------------------

const _debouncedSquadRender = debounce(() => renderSquad(), 150);

window.handleSquadSearch = (val) => {
    window.squadSearchQuery = val;
    _debouncedSquadRender();
};

function renderSquad() {
    const container = document.getElementById('squadList');
    if (!container) return;

    ensureHostUI();

    // Ensure search bar exists
    let searchInput = document.getElementById('squadSearchInput');
    if (!searchInput) {
        const searchWrap = document.createElement('div');
        searchWrap.className = 'input-row';
        searchWrap.style.marginBottom = '12px';
        searchWrap.innerHTML = ` 
            <input type="text" id="squadSearchInput" placeholder="Search players..." 
                   style="flex:1;" oninput="window.handleSquadSearch(this.value)">
        `;
        container.parentNode.insertBefore(searchWrap, container);
        searchInput = document.getElementById('squadSearchInput');
    }

    const query = (window.squadSearchQuery || '').toLowerCase().trim();
    // Update the input's value if the query changed externally (e.g., from clearHistorySearch)
    if (searchInput && searchInput.value !== (window.squadSearchQuery || '')) {
        searchInput.value = window.squadSearchQuery || '';
    }

    const existingChips = new Map();
    container.querySelectorAll('.player-chip').forEach(chip => {
        const uuid = chip.dataset.uuid;
        if (uuid) existingChips.set(uuid, chip);
    });

    const existingIds = new Set();
    const fragment = document.createDocumentFragment();

    StateStore.squad.forEach((p, idx) => {
        const pId = p.uuid || p.name;
        const isNew = p.games === 0 && p.wins === 0;
        existingIds.add(pId);

        const isMatch = !query || p.name.toLowerCase().includes(query);

        const waitBadge = p.active && p.waitRounds > 0 ? `<span class="wait-round-badge">${p.waitRounds}</span>` : '';
        const skillBadge = `<span class="skill-badge skill-${(p.skillLevel || 'Intermediate').toLowerCase()}" title="${p.skillLevel || 'Intermediate'}">${(p.skillLevel || 'Intermediate').charAt(0)}</span>`;
        const chipContent = `
            ${Avatar.html(p.name, p.spiritAnimal)}
            <span class="chip-name">${skillBadge}${escapeHTML(p.name)}${isNew ? '<span class="new-badge">NEW</span>' : ''}${!p.active ? ' ☕' : ''}${p.forcedRest ? ' 🔄' : ''}${!p.forcedRest && p.streak >= 4 ? ' 🔥' : ''}</span>
            ${waitBadge}
        `;
        const isSwapping = pId === swapSourceUUID;
        const chipClasses = `player-chip ${p.active ? 'active' : 'resting'} ${p.forcedRest ? 'forced-rest' : ''} ${isSwapping ? 'swapping-source' : ''} ${p.acknowledged ? 'player-acknowledged' : ''}`;

        let chip = existingChips.get(pId);

        if (chip) {
            // Chip exists, update it if necessary
            if (chip.className !== chipClasses) {
                chip.className = chipClasses;
            }
            // Update innerHTML if content changed (includes wait badge)
            if (chip.innerHTML.trim() !== chipContent.trim()) { // Trim to ignore whitespace differences
                chip.innerHTML = chipContent;
            }
            chip.style.display = isMatch ? '' : 'none';
            existingChips.delete(pId);
        } else {
            // Chip does not exist, create it
            const newChip = document.createElement('div');
            newChip.className = chipClasses;
            newChip.dataset.uuid = pId;
            newChip.innerHTML = chipContent;
            newChip.style.display = isMatch ? '' : 'none';
            newChip.addEventListener('mousedown', () => startPress(pId));
            newChip.addEventListener('mouseup', () => endPress(pId));
            newChip.addEventListener('touchstart', () => startPress(pId));
            newChip.addEventListener('touchend', () => endPress(pId));
            newChip.addEventListener('contextmenu', (e) => e.preventDefault());
            fragment.appendChild(newChip);
        }
    });

    // Append all new chips in a single DOM operation.
    if (fragment.children.length > 0) {
        container.appendChild(fragment);
    }

    // Handle removal of chips that are no longer in the squad or are filtered out
    existingChips.forEach(chip => { // These are chips that were in the DOM but not in the current render pass
        // These are chips for players NO LONGER in the StateStore.squad
        chip.classList.add('player-chip-removing');
        chip.addEventListener('animationend', () => chip.remove(), { once: true });
    });

    renderDirectorHub();
}

function checkNextButtonState() {
    const btn = document.getElementById('nextRoundBtn');
    if (!btn) return;
    const canProceed = StateStore.currentMatches.length === 0;
    btn.style.opacity       = canProceed ? '1'       : '0.4';
    btn.style.pointerEvents = canProceed ? 'auto'    : 'none';
    btn.style.cursor        = canProceed ? 'pointer' : 'default';
    btn.style.background    = canProceed ? 'var(--accent)' : '#2a2a3a';
    btn.textContent         = StateStore.currentMatches.length === 0 ? 'Start Session' : 'Matches in Progress';
}

function setCourts(n) {
    const val = Math.max(1, parseInt(n) || 1);
    const input = document.getElementById('courtCountInput');
    if (input) input.value = val;
    if (StateStore.get('activeCourts') === val) return;
    StateStore.set('activeCourts', val);
    saveToDisk();

    if (StateStore.currentMatches.length === 0) {
        if (typeof showSessionToast === 'function') showSessionToast(`🏀 ${val} court${val > 1 ? 's' : ''} set`);
        return;
    }

    UIManager.confirm({
        title: 'Change Courts?',
        message: `Apply ${val} court${val > 1 ? 's' : ''} now? This will reset the current round.`,
        confirmText: 'Change & Reset',
        isDestructive: true,
        onConfirm: () => {
            StateStore.set('currentMatches', []);
            document.getElementById('matchContainer').innerHTML = '';
            const onCourt = StateStore.squad.filter(p => p.active);
            onCourt.forEach(p => {
                if (!StateStore.playerQueue.includes(p.name)) StateStore.playerQueue.unshift(p.name);
            });
            generateMatches();
        },
        onCancel: () => {
            const restoredCourts = StateStore.currentMatches.length || 1;
            StateStore.set('activeCourts', restoredCourts);
            if (input) input.value = restoredCourts;
            saveToDisk();
        }
    });
}

// ---------------------------------------------------------------------------
// LONG-PRESS MENU
// ---------------------------------------------------------------------------

let _lastTapInfo = { uuid: null, time: 0 };

function startPress(uuid) {
    isLongPress = false;
    pressTimer = setTimeout(() => {
        isLongPress = true;
        // If we are in swap mode and tap the source again, just cancel
        if (swapSourceUUID && swapSourceUUID === uuid) {
            Haptic.tap();
        } else {
            Haptic.bump();
        }
        openMenu(uuid);
    }, 600);
}

function endPress(uuid) {
    clearTimeout(pressTimer);
    if (!isLongPress) {
        const now = Date.now();
        if (_lastTapInfo.uuid === uuid && (now - _lastTapInfo.time) < 300) {
            // Double tap detected: Toggle Ready/Resting
            togglePlayerActive(uuid);
            _lastTapInfo = { uuid: null, time: 0 };
        } else {
            _lastTapInfo = { uuid, time: now };
            
            // Single tap fallback: If resting, toggle to ready. 
            const player = StateStore.squad.find(p => p.uuid === uuid);
            if (player && !player.active) {
                togglePlayerActive(uuid);
            }
        }
    }
}

function togglePlayerActive(uuid) {
    const player = StateStore.squad.find(p => p.uuid === uuid);
    if (!player) return;
    
    Haptic.tap();
    player.active = !player.active;
    renderSquad();
    checkNextButtonState();

    // Trigger reactive sync and immediate broadcast
    StateStore.set('squad', [...StateStore.squad]);
    if (typeof broadcastGameState === 'function') broadcastGameState(true);
}

function openMenu(uuid) {
    const playerIndex = StateStore.squad.findIndex(p => (p.uuid || p.name) === uuid);
    if (playerIndex === -1) return;
    selectedPlayerIndex = playerIndex;
    const p = StateStore.squad[playerIndex];
    const sport = StateStore.get('sport') || 'Badminton';
    const sIcon = window.SPORT_ICONS[sport] || '🏸';
    const menu = document.getElementById('actionMenu');
    if (!menu) return;

    const onCourt = new Set(StateStore.currentMatches.flatMap(m => m.teams.flat()));
    const isPlaying = onCourt.has(p.uuid || p.name);

    let swapActionHTML = '';

    // Logic for Swap Button visibility
    if (swapSourceUUID) {
        // We are in the middle of a swap
        if (isPlaying && (p.uuid || p.name) !== swapSourceUUID) {
            // This is a valid target
            const sourceP = StateStore.squad.find(s => s.uuid === swapSourceUUID);
            const sourceName = sourceP ? sourceP.name : 'Player';
            swapActionHTML = `
                <button class="btn-main menu-btn" onclick="completeSwap('${p.uuid}')" style="background:var(--accent); color:#000;">
                    Confirm Swap with ${escapeHTML(sourceName)}
                </button>
                <button class="btn-main menu-btn" onclick="cancelSwap()" style="background:var(--surface2); color:var(--text);">
                    Cancel Swap
                </button>
            `;
        } else {
            // Clicked self or invalid target -> allow cancel
            swapActionHTML = `<button class="btn-main menu-btn" onclick="cancelSwap()">Cancel Swap</button>`;
        }
    } else if (isPlaying) {
        // Not swapping yet, show initiate button
        swapActionHTML = `<button class="btn-main menu-btn" style="background:var(--surface2); color:var(--text); border:1px solid var(--border);" onclick="initiateSwap('${p.uuid || p.name}')">⇄ Swap Position</button>`;
    }

    let pokeActionHTML = '';
    if (isPlaying && !swapSourceUUID && !p.isGuest) {
        pokeActionHTML = `
            <button class="btn-main menu-btn" style="background:var(--bg2); color:var(--warning); border:1px solid var(--warning);" onclick="broadcastPoke('${p.uuid}'); closeMenu();">
                ⚡ Poke Player
            </button>`;
    }

    menu.innerHTML = `
        <div class="menu-card">
            <h2>${escapeHTML(p.name)}</h2>
            <p>${p.active ? (isPlaying ? `Currently Playing ${sIcon}` : 'Ready for Rotation') : 'Taking a Break ☕'}</p>
            
            ${swapActionHTML}

            ${pokeActionHTML}

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
    const p = StateStore.squad[selectedPlayerIndex];
    if (!p) return;
    
    // Remove from current spot in queue and add to front using unified ID
    const pId = p.uuid || p.name;
    const newQueue = StateStore.playerQueue.filter(u => u !== pId);
    newQueue.unshift(pId);
    StateStore.set('playerQueue', newQueue);
    
    closeMenu();
    if (typeof renderQueueStrip === 'function') renderQueueStrip();
    saveToDisk();
    if (typeof broadcastGameState === 'function') broadcastGameState(true);
    if (window.Haptic) Haptic.success();
    if (typeof showSessionToast === 'function') showSessionToast(`${p.name} moved to front`);
}

function openCourtRename(courtIndex) {
    if (!isOperator) return; // Only host can rename

    const courtNames = StateStore.get('courtNames') || {};
    const currentName = courtNames[courtIndex] || `Court ${courtIndex + 1}`;

    UIManager.prompt({
        title: `Rename ${currentName}`,
        initialValue: courtNames[courtIndex] || '',
        placeholder: 'e.g. Center Court',
        confirmText: 'Save Name',
        onConfirm: (newName) => {
            const trimmed = newName.trim();
            const newCourtNames = { ...courtNames };

            if (trimmed) {
                newCourtNames[courtIndex] = trimmed;
            } else {
                delete newCourtNames[courtIndex]; // Revert to default if name is cleared
            }

            StateStore.set('courtNames', newCourtNames);
            if (typeof rebuildMatchCardIndices === 'function') rebuildMatchCardIndices();
        }
    });
}
window.openCourtRename = openCourtRename;
// ---------------------------------------------------------------------------
// OVERLAYS — STATS & SYNC
// ---------------------------------------------------------------------------

function joinManualCode() {
    const input = document.getElementById('manualRoomCodeInput');
    const raw = input?.value?.trim();
    if (raw) {
        // Normalize room code: strip non-alphanumeric and add hyphen if 8 chars
        let code = raw.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (code.length === 8) code = code.slice(0, 4) + '-' + code.slice(4);

        if (typeof PlayerMode !== 'undefined' && typeof Passport !== 'undefined') {
            const newUrl = window.location.origin + window.location.pathname + '?join=' + encodeURIComponent(code) + '&role=player';
            window.history.pushState({}, document.title, newUrl);
            document.body.classList.add('player-mode');
            closeOverlay();
            PlayerMode.boot(Passport.get(), code);
        } else {
            window.location.href = window.location.origin + window.location.pathname + '?join=' + encodeURIComponent(code) + '&role=player';
        }
    } else {
        alert('Please enter a room code.');
    }
}

function showOverlay(type) {
    const title   = document.getElementById('overlayTitle');
    const content = document.getElementById('overlayContent');
    document.getElementById('overlay').classList.add('open');

    if (type === 'stats') {
        title.innerText = 'Stats';
        renderStatsTab('performance');

    } else {
        title.innerText = 'Session Hub';
        const syncMsg = window._lastSyncTime ? `Cloud Sync Active (Last: ${window._lastSyncTime})` : 'Syncing with cloud...';
        
        let shContent = `<div id="syncStatusMsg" class="sync-status">${syncMsg}</div>`;

        if (isOnlineSession) {
            shContent += `
                <div class="sh-section">
                    <div class="sync-section-label">Matchmaking Logic</div>
                    <div style="padding: 10px 0;">
                        <div style="display:flex; justify-content:space-between; font-size:0.6rem; color:var(--text-muted); margin-bottom:8px;">
                            <span>VARIETY</span>
                            <span style="color:var(--accent); font-weight:800;">${StateStore.get('fairnessMultiplier') > 7 ? 'STRICT BALANCE' : StateStore.get('fairnessMultiplier') < 3 ? 'MAX VARIETY' : 'BALANCED'}</span>
                            <span>FAIRNESS</span>
                        </div>
                        <input type="range" min="0" max="10" step="1" value="${StateStore.get('fairnessMultiplier') ?? 5}" 
                               style="width:100%; accent-color:var(--accent);" 
                               onchange="StateStore.set('fairnessMultiplier', parseInt(this.value)); showSessionToast('Algorithm Updated 🧠');">
                    </div>
                </div>

                <div class="sh-section">
                    <div class="session-live-card">
                        <div class="session-live-top">
                            <span class="session-live-dot"></span>
                            <span class="session-live-label">LIVE SESSION</span>
                        </div>
                        <div class="session-room-code">${currentRoomCode}</div>
                        <p style="font-size:0.7rem; color:var(--text-muted); margin-bottom:20px;">
                            ${isOperator ? 'Share code or invite link to join' : 'Viewing as spectator'}
                        </p>
                        
                        <div class="sh-qr-wrap">
                            <div id="qrcode" style="display:flex;justify-content:center;margin:0 auto;"></div>
                        </div>
                    </div>
                </div>

                <div class="sh-section">
                    <div class="sync-section-label">Broadcast Controls</div>
                    <div class="sh-grid">
                        <button class="btn-main sh-btn-sub" onclick="copyInviteLink()">🔗 Invite Link</button>
                        <button class="btn-main sh-btn-sub" onclick="copySyncToken()">📋 Room Code</button>
                        ${isOperator ? `
                            <button class="btn-main sh-btn-sub" onclick="resyncQueue()">🔄 Resync Queue</button>
                            <button class="btn-main btn-danger" style="font-size:0.8rem;" onclick="confirmEndSession()">🛑 End Session</button>
                        ` : `
                            <button class="btn-main btn-danger" style="grid-column: span 2;" onclick="leaveSession(); closeOverlay();">Leave Session</button>
                        `}
                    </div>
                </div>

                <div class="sh-section">
                    <div class="sync-section-label">Navigation</div>
                    <div class="sh-grid">
                        <button class="btn-main sh-btn-sub" style="grid-column: span 2;" onclick="goToMainMenu()">🏠 Home Menu</button>
                    </div>
                </div>

                ${_supportSectionHTML()}
            `;
        } else {
            shContent += `
                <div class="sh-section">
                    <div class="sync-section-label">Go Live</div>
                    <p style="font-size:0.75rem; color:var(--text-muted); margin-bottom:12px;">
                        Start a live session to sync with players in real-time.
                    </p>
                    <button class="btn-main" style="width:100%; height:54px;" onclick="createOnlineSession()">🌐 Start Live Session</button>
                </div>

                <div class="sh-section">
                    <div class="sync-section-label">Join Session</div>
                    <p style="font-size:0.75rem; color:var(--text-muted); margin-bottom:12px;">
                        Enter a room code to watch a live session.
                    </p>
                    <input type="text" id="manualRoomCodeInput" placeholder="ENTER CODE"
                        class="sl-code-input" style="margin-bottom:10px;"
                        autocomplete="off" autocorrect="off" maxlength="9">
                    <button id="joinManualCodeBtn" class="btn-main sh-btn-sub" style="width:100%;">Connect to Room</button>
                </div>

                <div class="sh-section">
                    <div class="sync-section-label">Backup & Migration</div>
                    <div class="sh-grid">
                        <button class="btn-main sh-btn-sub" onclick="copySyncToken()">📦 Export Data</button>
                        <button class="btn-main sh-btn-sub" onclick="importSyncToken()">📥 Import Data</button>
                    </div>
                    <input type="text" id="syncInput" placeholder="Paste token here..."
                        style="width:100%; margin-top:10px; font-size:0.8rem; background:var(--bg2); border:1px solid var(--border); color:var(--text); padding:10px; border-radius:10px;">
                </div>

                <div class="sh-section" style="text-align:center; padding-top:10px;">
                    <button class="btn-main btn-danger" style="width:auto; display:inline-flex; padding:8px 16px; font-size:0.7rem; height:auto; min-height:auto;"
                        onclick="confirmEraseAllData()">WIPE ALL LOCAL DATA</button>
                </div>

                <div class="sh-section">
                    <div class="sync-section-label">Navigation</div>
                    <div class="sh-grid">
                        <button class="btn-main sh-btn-sub" style="grid-column: span 2;" onclick="goToMainMenu()">🏠 Home Menu</button>
                    </div>
                </div>

                ${_supportSectionHTML()}
            `;
        }
        content.innerHTML = shContent;

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

        // Attach event listeners for manual code entry to avoid global scope issues
        if (!isOnlineSession) {
            document.getElementById('joinManualCodeBtn')?.addEventListener('click', joinManualCode);
            document.getElementById('manualRoomCodeInput')?.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') joinManualCode();
            });
        }
    }
}

/** Computes production-level insights for the host dashboard. */
function renderDirectorHub() {
    const grid = document.getElementById('directorHubGrid');
    if (!grid) return;

    const squad = StateStore.squad;
    const onCourt = new Set(StateStore.currentMatches.flatMap(m => m.teams.flat()));
    const waiting = squad.filter(p => p.active && !onCourt.has(p.uuid || p.name));

    // 1. Longest Wait
    const longest = waiting.length ? [...waiting].sort((a,b) => (b.waitRounds || 0) - (a.waitRounds || 0))[0] : null;
    // 2. King of the Hill (Current high streak)
    const king = squad.length ? [...squad].sort((a,b) => b.streak - a.streak)[0] : null;
    // 3. Iron Man (Most games in session)
    const ironMan = squad.length ? [...squad].sort((a,b) => b.sessionPlayCount - a.sessionPlayCount)[0] : null;

    const renderItem = (label, player, val, icon) => `
        <div class="sh-insight-item">
            <div class="sh-insight-label">${icon} ${label}</div>
            <div class="sh-insight-val">${player ? escapeHTML(player.name) : '—'}</div>
            <div class="sh-insight-meta">${val || ''}</div>
        </div>
    `;

    grid.innerHTML = `
        ${renderItem('Waiting Longest', longest, (longest?.waitRounds ? `${longest.waitRounds} rounds` : 'Next up'), '⏳')}
        ${renderItem('King of Hill', king, (king?.streak > 0 ? `${king.streak} streak` : 'No wins'), '🔥')}
        ${renderItem('Iron Man', ironMan, (ironMan?.sessionPlayCount > 0 ? `${ironMan.sessionPlayCount} games` : '0 games'), '💪')}
    `;
}
window.renderDirectorHub = renderDirectorHub;

function closeOverlay() {
    document.getElementById('overlay').classList.remove('open');
}

function confirmEndSession() {
    UIManager.confirm({
        title: 'End Session?',
        message: 'This will end the live broadcast for all players and spectators. You will see a final session recap before exiting.',
        confirmText: 'End Session & Recap',
        isDestructive: true,
        onConfirm: async () => {
            const recapData = _calculateFinalRecapData();
            const roomCode = window.currentRoomCode;
            
            // 1. Broadcast to players so they see their recap
            if (typeof broadcastSessionEnded === 'function') {
                broadcastSessionEnded(recapData);
            }

            // 2. Stop host sync logic immediately
            localStorage.removeItem('cs_room_code');
            localStorage.removeItem('cs_operator_key');
            localStorage.removeItem('cs_op_key_hash');
            localStorage.removeItem('cs_pro_vault'); // Clear local vault to return to fresh menu
            localStorage.removeItem('cs_pending_sync');

            // Clear request tracking for the session
            _lastSeenRequestIds.clear();
            _processingRequestIds.clear();
            playRequests = [];
            _notifQueue.length = 0;
            window.playRequests = playRequests;

            // 3. Show the Host Recap View (this also hides hostRoot via CSS)
            _showHostRecap(recapData);

            // 4. Delete from DB (authenticated call)
            if (roomCode && window.operatorKey) {
                fetch('/api/session-delete', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ room_code: roomCode, operator_key: window.operatorKey }),
                }).catch(e => console.error('[CourtSide] Silent delete failed', e));
            }
        }
    });
}

function _calculateFinalRecapData() {
    const squad = StateStore.squad || [];
    const history = StateStore.roundHistory || [];
    const totalGames = history.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
    const sport = StateStore.get('sport') || 'Badminton';
    
    const sortedByWins = [...squad].sort((a,b) => b.wins - a.wins || getSkillIndex(b) - getSkillIndex(a));
    const mvp = sortedByWins[0] || { name: 'N/A', wins: 0, games: 0 };
    
    const sortedByGames = [...squad].sort((a,b) => b.sessionPlayCount - a.sessionPlayCount);
    const ironMan = sortedByGames[0] || { name: 'N/A', sessionPlayCount: 0 };

    const sortedByStreak = [...squad].sort((a,b) => b.streak - a.streak);
    const hotHand = sortedByStreak[0] || { name: 'N/A', streak: 0 };

    const eligibleForWR = squad.filter(p => p.games >= 3);
    const sortedByWR = [...eligibleForWR].sort((a,b) => (b.wins/b.games) - (a.wins/a.games));
    const sharpShooter = sortedByWR[0] || { name: 'N/A', wins: 0, games: 0 };

    return { 
        sessionUUID: _generateUUID(), // Unique ID for this recap instance
        sport,
        totalGames, 
        mvp: { name: mvp.name, wins: mvp.wins, games: mvp.games }, 
        ironMan: { name: ironMan.name, sessionPlayCount: ironMan.sessionPlayCount },
        hotHand: { name: hotHand.name, streak: hotHand.streak },
        sharpShooter: { 
            name: sharpShooter.name, 
            wr: sharpShooter.games > 0 ? Math.round((sharpShooter.wins / sharpShooter.games) * 100) : 0,
            squad: squad.map(p => ({ uuid: p.uuid, name: p.name, spiritAnimal: p.spiritAnimal })) // For voting
        },
        squad: sortedByWins.slice(0, 10) 
    };
}

function _showHostRecap(recap) {
    document.body.classList.add('session-ended');
    closeOverlay();

    const sessionMVPVotes = {}; // To store votes for this recap
    const esc = (s) => (typeof escapeHTML === 'function' ? escapeHTML(s) : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));

    const leaderboardHTML = recap.squad.map((p, i) => `
        <div style="display:flex; align-items:center; gap:12px; padding:10px 0; border-bottom:1px solid var(--border);">
            <div style="font-family:var(--font-display); font-weight:900; color:var(--accent); width:24px;">${i+1}</div>
            <div style="flex:1; font-family:var(--font-display); font-weight:700; text-transform:uppercase; font-size:0.9rem;">${esc(p.name)}</div>
            <div style="font-family:var(--font-display); font-size:1.1rem; font-weight:800; color:var(--text);">${p.wins}W</div>
        </div>
    `).join('');

    const content = `
        <div class="menu-card" style="max-width:440px; width:95%; max-height:90vh; overflow-y:auto; padding:32px 24px; text-align:left;">
            <div style="font-family:var(--font-display); font-size:0.7rem; font-weight:900; color:var(--accent); letter-spacing:4px; margin-bottom:8px; text-transform:uppercase;">SESSION COMPLETE</div>
            <h2 style="font-size:2.2rem; margin-bottom:24px; line-height:1; font-family:var(--font-display); font-weight:900; font-style:italic;">RECAP & RANKINGS</h2>
            
            <div id="hostMvpDisplay" style="background:linear-gradient(135deg, var(--accent-dim), transparent); border:1px solid var(--border-accent); border-radius:16px; padding:24px; margin-bottom:24px; text-align:center;">
                <div style="font-size:3rem; margin-bottom:10px;">🏆</div>
                <div style="font-family:var(--font-display); font-size:0.7rem; font-weight:900; letter-spacing:2px; color:var(--accent); margin-bottom:4px; text-transform:uppercase;">SESSION MVP</div>
                <div style="font-family:var(--font-display); font-size:2rem; font-weight:900; font-style:italic; text-transform:uppercase; color:#fff;">${esc(recap.mvp.name)}</div>
                <div style="font-size:0.8rem; color:var(--text-muted); margin-top:4px;">${recap.mvp.wins} Wins · ${recap.mvp.games} Games</div>
                <button class="sl-share-match-btn" style="margin-top:16px; background:var(--accent); color:#000;" 
                    onclick="if(typeof generateMVPPoster==='function') generateMVPPoster('${esc(recap.mvp.name)}', ${recap.mvp.wins}, ${recap.mvp.games})">📲 SHARE MVP POSTER</button>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:24px;">
                <div style="background:var(--bg2); padding:16px; border-radius:12px; border:1px solid var(--border);">
                    <div style="font-size:0.55rem; font-weight:800; color:var(--text-muted); letter-spacing:1px; text-transform:uppercase;">TOTAL GAMES</div>
                    <div style="font-family:var(--font-display); font-size:1.8rem; font-weight:900; color:var(--accent);">${recap.totalGames}</div>
                </div>
                <div style="background:var(--bg2); padding:16px; border-radius:12px; border:1px solid var(--border); overflow:hidden;">
                    <div style="font-size:0.55rem; font-weight:800; color:var(--text-muted); letter-spacing:1px; text-transform:uppercase;">IRON MAN</div>
                    <div style="font-family:var(--font-display); font-size:1.1rem; font-weight:900; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(recap.ironMan.name)}</div>
                    <div style="font-size:0.6rem; color:var(--text-muted);">${recap.ironMan.sessionPlayCount} Games</div>
                </div>
                <div style="background:var(--bg2); padding:16px; border-radius:12px; border:1px solid var(--border); overflow:hidden;">
                    <div style="font-size:0.55rem; font-weight:800; color:var(--text-muted); letter-spacing:1px; text-transform:uppercase;">HOT HAND</div>
                    <div style="font-family:var(--font-display); font-size:1.1rem; font-weight:900; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(recap.hotHand.name)}</div>
                    <div style="font-size:0.6rem; color:var(--text-muted);">${recap.hotHand.streak} Win Streak</div>
                </div>
                <div style="background:var(--bg2); padding:16px; border-radius:12px; border:1px solid var(--border); overflow:hidden;">
                    <div style="font-size:0.55rem; font-weight:800; color:var(--text-muted); letter-spacing:1px; text-transform:uppercase;">SHARP SHOOTER</div>
                    <div style="font-family:var(--font-display); font-size:1.1rem; font-weight:900; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(recap.sharpShooter.name)}</div>
                    <div style="font-size:0.6rem; color:var(--text-muted);">${recap.sharpShooter.wr}% Win Rate</div>
                </div>
            </div>

            <div class="sync-section-label" style="margin-bottom:12px;">FINAL STANDINGS</div>
            <div style="margin-bottom:24px; background:var(--surface); border-radius:12px; border:1px solid var(--border); padding:0 16px;">
                ${leaderboardHTML}
            </div>

            <button class="btn-main" style="width:100%; height:54px; margin-bottom:12px; background:var(--surface2); color:var(--text); border:1px solid var(--border);" onclick="window.location.reload()">BACK TO MENU</button>
            <p style="font-size:0.65rem; color:var(--text-muted); line-height:1.4; text-align:center;">Data has been synced to career records. Session logic disconnected.</p>
        </div>
    `;

    UIManager.show(content, 'card');
}
// ---------------------------------------------------------------------------
// QR CODE & SYNC TOKEN
// ---------------------------------------------------------------------------

function generateQR() {
    // Fix: Use unicode-safe encoding so emojis don't crash btoa
    const json  = JSON.stringify({ squad: StateStore.squad, currentMatches: StateStore.currentMatches });
    const token = window.btoa(unescape(encodeURIComponent(json)));
    if (token.length > 2500) {
        alert('Data is too large for a QR code. Please use the "Copy Sync Token" button instead.');
        return;
    }
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
    let text = window.currentRoomCode;
    if (!isOnlineSession) {
        // Fix: Unicode-safe encoding
        const json = JSON.stringify({ squad: StateStore.squad, currentMatches: StateStore.currentMatches });
        text = window.btoa(unescape(encodeURIComponent(json)));
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
            .then(() => showSessionToast(isOnlineSession ? `📋 Room code copied: ${text}` : '📋 Token copied!'))
            .catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text, msg = '📋 Token copied!') {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
        document.execCommand('copy');
        showSessionToast(msg);
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
        'Squad size: ' + (StateStore.squad?.length ?? 'N/A') + '\n' +
        'Active courts: ' + (StateStore.get('activeCourts') ?? 'N/A')
    );
    window.open('mailto:iamwillempacardo@gmail.com?subject=' + subject + '&body=' + body);
    closeBugReportModal();
}

function importSyncToken() {
    const val = document.getElementById('syncInput').value.trim();
    if (!val) return;
    try {
        // Fix: Unicode-safe decoding
        const json = decodeURIComponent(escape(window.atob(val)));
        const data = JSON.parse(json);
        if (!data.squad) throw new Error('Missing squad data');
                StateStore.setState({ squad: data.squad, currentMatches: data.currentMatches || [] }); // Triggers sync
        closeOverlay();
        renderSquad();
        document.getElementById('matchContainer').innerHTML = '';
        if (typeof rebuildMatchCardIndices === 'function') rebuildMatchCardIndices();
        checkNextButtonState();
    } catch (e) {
        alert('Invalid Sync Token. Please check the data and try again.');
    }
}

function eraseAllData() {
    localStorage.clear();
    location.reload();
}

function confirmEraseAllData() {
    UIManager.confirm({
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

/**
 * Returns a function that, as long as it continues to be invoked, will not
 * be triggered. The function will be called after it stops being called for
 * N milliseconds.
 */
function debounce(fn, delay) {
    let timeoutId = null;
    const debounced = (...args) => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delay);
    };
    debounced.cancel = () => { if (timeoutId) clearTimeout(timeoutId); timeoutId = null; };
    return debounced;
}

window.debounce = debounce;

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
    const btn = document.getElementById('undoRoundBtn');
    if (!btn) return;
    btn.style.display  = StateStore.roundHistory.length > 0 ? 'inline-flex' : 'none';
}

function undoLastRound() {
    if (StateStore.roundHistory.length === 0) return;
    UIManager.confirm({
        title: 'Undo Round?',
        message: 'Undo the last round? This will reverse all stat changes.',
        confirmText: 'Yes, Undo',
        onConfirm: () => {
            const snapshot = StateStore.roundHistory.pop();
            // Restore state from the snapshot using the StateStore
            StateStore.setState({
                squad: snapshot.squadSnapshot,
                currentMatches: snapshot.matches,
                playerQueue: snapshot.queueSnapshot || StateStore.playerQueue,
            });
            renderSquad();
            if (typeof rebuildMatchCardIndices === 'function') rebuildMatchCardIndices();
            if (typeof renderQueueStrip === 'function') renderQueueStrip();
            updateUndoButton();
            checkNextButtonState();
            Haptic.bump();
            showSessionToast('↩ Last round undone');
        }
    });
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
            <button class="stats-tab ${tab === 'hall-of-fame' ? 'active' : ''}" 
                onclick="renderStatsTab('hall-of-fame')">Hall of Fame</button>
            <button class="stats-tab ${tab === 'profile' ? 'active' : ''}" 
                onclick="renderStatsTab('profile')">My Profile</button>
        </div>
    `;

    if (tab === 'performance') {
        const sorted   = [...StateStore.squad].sort((a, b) => getSkillIndex(b) - getSkillIndex(a) || b.wins - a.wins);
        const topCount = Math.max(1, Math.ceil(StateStore.squad.length * 0.3));
        const peak     = sorted.slice(0, topCount).sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name));
        const active   = sorted.slice(topCount).sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name));
        const winRate  = p => p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0;

        const renderGroup = (label, list) => {
            if (list.length === 0) return '';
            const cards = list.map((p, i) => {
                const sqIdx = StateStore.squad.indexOf(p);
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

    } else if (tab === 'profile') {
        if (!passport) {
             content.innerHTML = tabs + `<div class="sl-empty" style="padding:40px 0;">No passport found.</div>`;
             return;
        }
        const me = StateStore.squad.find(p => p.uuid === passport.playerUUID);
        
        // 1. Identity Header
        const { title, icon } = me ? getPlayerTitle(me) : { title: 'Spectator', icon: '👀' };
        const avatarColor = Avatar.color(passport.playerName);
        const avatarInitial = (passport.playerName || '?').charAt(0).toUpperCase();
        
        const headerHTML = `
            <div class="sl-profile-card">
                <div class="sl-profile-top-right">
                    <button class="sl-icon-btn" onclick="passportRename()" title="Edit Name">✏️</button>
                </div>
                <div class="sl-profile-avatar-large" style="background:${avatarColor}">
                    ${avatarInitial}
                    ${me && me.streak >= 3 ? `<div class="sl-streak-ring"></div>` : ''}
                </div>
                <div class="sl-profile-name-large">${escapeHTML(passport.playerName)}</div>
                <div class="sl-profile-title-badge">
                    <span>${icon}</span>
                    <span>${title}</span>
                </div>
            </div>`;

        // 2. Stats Deck
        const career = passport.stats || { wins: 0, games: 0 };
        const cWins  = career.wins || 0;
        const cGames = career.games || 0;
        const cWr    = cGames > 0 ? Math.round((cWins / cGames) * 100) : 0;
        const skillLevel = passport.skillLevel || (me ? me.skillLevel : 'Intermediate') || 'Intermediate';
        
        let sWins = 0, sGames = 0, sWr = 0;
        if (me) {
            sWins = me.wins;
            sGames = me.games;
            sWr = sGames > 0 ? Math.round((sWins / sGames) * 100) : 0;
        }

        const statsHTML = `
            <div class="sl-stats-deck">
                <div class="sl-stat-card ${!me ? 'inactive' : ''}">
                    <div class="sl-card-label">CURRENT SESSION</div>
                    ${me ? `
                    <div class="sl-card-grid">
                        <div class="sl-card-item">
                            <div class="sl-card-val">${sWins}</div>
                            <div class="sl-card-key">WINS</div>
                        </div>
                        <div class="sl-card-item">
                            <div class="sl-card-val">${sGames}</div>
                            <div class="sl-card-key">GAMES</div>
                        </div>
                        <div class="sl-card-item">
                            <div class="sl-card-val">${sWr}%</div>
                            <div class="sl-card-key">WIN RATE</div>
                        </div>
                    </div>` : `<div class="sl-card-empty">Not in squad</div>`}
                </div>
                <div class="sl-stat-card" style="margin-top:12px; cursor:pointer;" onclick="PlayerMode.openSkillLevelPicker()">
                    <div class="sl-card-label">SKILL LEVEL</div>
                    <div style="margin-top: 4px;">
                        <span class="skill-badge skill-${(skillLevel || 'Intermediate').toLowerCase()}" style="font-size:1rem; padding:4px 12px; border-radius:6px;">
                            ${(skillLevel === 'Novice' ? '🌱 NOVICE' : skillLevel === 'Advanced' ? '👑 PRO' : '⚔️ INTER')}
                        </span>
                    </div>
                </div>
                <div class="sl-stat-card">
                    <div class="sl-card-label">CAREER RECORD</div>
                    <div class="sl-card-grid">
                        <div class="sl-card-item">
                            <div class="sl-card-val">${cWins}</div>
                            <div class="sl-card-key">WINS</div>
                        </div>
                        <div class="sl-card-item">
                            <div class="sl-card-val">${cGames}</div>
                            <div class="sl-card-key">GAMES</div>
                        </div>
                        <div class="sl-card-item">
                            <div class="sl-card-val">${cWr}%</div>
                            <div class="sl-card-key">WIN RATE</div>
                        </div>
                    </div>
                </div>
            </div>`;

        // Form & Analytics (New Section)
        let analyticsHTML = '';
        if (me) {
            // Rival Logic
            let rivalName = 'None yet';
            let rivalCount = 0;
            if (me.opponentHistory) {
                const rivals = Object.entries(me.opponentHistory).sort(([,a], [,b]) => b - a);
                if (rivals.length > 0) {
                    const rivalP = StateStore.squad.find(s => (s.uuid || s.name) === rivals[0][0]);
                    rivalName = rivalP ? rivalP.name : 'Unknown';
                    rivalCount = rivals[0][1];
                }
            }

            // Form Logic
            const formHTML = (me.form || []).map(r => 
                `<span style="display:inline-block; width:20px; height:20px; border-radius:50%; background:${r==='W'?'var(--accent)':'#ef4444'}; color:${r==='W'?'#000':'#fff'}; font-size:0.6rem; font-weight:800; text-align:center; line-height:20px; margin:0 2px;">${r}</span>`
            ).join('');

            analyticsHTML = `
                <div class="sl-section-label" style="margin-top:24px;">📊 ANALYTICS</div>
                <div style="background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:16px; display:flex; justify-content:space-between; align-items:center;">
                    <div style="text-align:center; flex:1;">
                        <div style="font-size:0.6rem; color:var(--text-muted); font-weight:700; margin-bottom:6px; letter-spacing:1px;">RECENT FORM</div>
                        <div>${formHTML || '<span style="color:var(--text-muted); font-size:0.8rem;">-</span>'}</div>
                    </div>
                    <div style="width:1px; height:30px; background:var(--border);"></div>
                    <div style="text-align:center; flex:1;">
                        <div style="font-size:0.6rem; color:var(--text-muted); font-weight:700; margin-bottom:4px; letter-spacing:1px;">BIGGEST RIVAL</div>
                        <div style="font-size:0.9rem; font-weight:700;">${escapeHTML(rivalName)}</div>
                        <div style="font-size:0.65rem; color:var(--text-muted);">${rivalCount} games</div>
                    </div>
                </div>`;
        }

        // 3. Chemistry
        let chemHTML = '';
        if (me && me.partnerStats && Object.keys(me.partnerStats).length > 0) {
            const partners = Object.entries(me.partnerStats);
            partners.sort(([, a], [, b]) => {
                if (b.wins !== a.wins) return b.wins - a.wins;
                return b.games - a.games;
            });
            const best = partners[0];
            if (best) {
                const [uuid, stats] = best;
                const partnerP = StateStore.squad.find(s => (s.uuid || s.name) === uuid);
                const wr = stats.games > 0 ? Math.round((stats.wins / stats.games) * 100) : 0;
                chemHTML = `
                    <div class="sl-section-label" style="margin-top:24px;">🤝 PARTNER CHEMISTRY</div>
                    <div class="sl-chem-card">
                        <div class="sl-chem-details">
                            <div class="sl-chem-name">Best with: <strong>${escapeHTML(partnerP ? partnerP.name : 'Unknown')}</strong></div>
                            <div class="sl-chem-stats">${stats.wins}W - ${stats.games - stats.wins}L (${wr}%)</div>
                        </div>
                    </div>`;
            }
        }

        // 4. Achievements
        let achHTML = '';
        if (window.Achievements) {
            const sessionAch = me ? (me.achievements || []) : [];
            const allTimeAch = passport.achievements || [];
            const myAch = [...new Set([...sessionAch, ...allTimeAch])];
            const list = Object.keys(window.Achievements).map(key => {
                const data = window.getAchievementDisplay(key, myAch);
                const unlocked = data.unlocked;
                return `
                    <div class="sl-ach-item ${unlocked ? 'unlocked' : 'locked'}" style="${unlocked ? `border-left: 3px solid ${data.color}` : ''}">
                        <div class="sl-ach-icon">${data.icon}</div>
                        <div class="sl-ach-text">
                            <div class="sl-ach-title">${data.name}</div>
                            <div class="sl-ach-desc">${data.description}</div>
                        </div>
                    </div>
                `;
            }).join('');
            achHTML = `<div class="sl-achievements-list" style="margin-top:20px;">${list}</div>`;
        }

        content.innerHTML = tabs + headerHTML + statsHTML + analyticsHTML + chemHTML + achHTML;

    } else if (tab === 'hall-of-fame') {
        const period = window._lbPeriod || 'all';
        content.innerHTML = tabs + `
            <div style="display:flex; gap:8px; margin-bottom:16px;">
                <button class="stats-tab ${period === 'all' ? 'active' : ''}" style="font-size:0.6rem; padding:6px;" onclick="window._lbPeriod='all'; renderStatsTab('hall-of-fame')">All-Time Legends</button>
                <button class="stats-tab ${period === 'weekly' ? 'active' : ''}" style="font-size:0.6rem; padding:6px;" onclick="window._lbPeriod='weekly'; renderStatsTab('hall-of-fame')">Weekly Stars</button>
            </div>
            <div class="sl-searching" style="margin-top:20px;">
                <div class="sl-searching-spinner"></div>
                <div class="sl-searching-text">ENTERING THE HALL OF FAME…</div>
            </div>`;

        fetch('/api/leaderboard-get' + (period === 'weekly' ? '?period=weekly' : ''))
            .then(res => res.json())
            .then(data => {
                // Guard: only render if user is still on the hall-of-fame tab
                if (!document.querySelector('.stats-tab.active')?.textContent.toLowerCase().includes('hall')) return;
                
                const players = data.players || [];

                // COMMUNITY SORT: Prioritize Connections > Trophies > Volume
                players.sort((a, b) => {
                    // Support both snake_case (DB) and camelCase (Internal)
                    const connA = Object.keys(a.partner_stats || a.partnerStats || {}).length;
                    const connB = Object.keys(b.partner_stats || b.partnerStats || {}).length;
                    if (connB !== connA) return connB - connA; // Most unique partners first

                    const trophyA = (a.achievements || []).length;
                    const trophyB = (b.achievements || []).length;
                    if (trophyB !== trophyA) return trophyB - trophyA;

                    const gamesA = a.total_games ?? a.totalGames ?? a.games ?? 0;
                    const gamesB = b.total_games ?? b.totalGames ?? b.games ?? 0;
                    return gamesB - gamesA;
                });

                const html = players.map((p, i) => {
                    const connections = Object.keys(p.partner_stats || p.partnerStats || {}).length;
                    return `
                    <div class="stats-card" style="display:flex; align-items:center; gap:12px; padding: 12px 16px;">
                        <div style="font-family:var(--font-display); font-size:1rem; font-weight:900; color:var(--text-muted); width:24px;">${i+1}</div>
                        <div style="flex:1;">
                            <div class="stats-name" style="margin-bottom:2px;">${escapeHTML(p.player_name || p.name || 'Unknown')}</div>
                            <div class="stats-meta">${connections} Connections · ${p.total_games ?? p.totalGames ?? p.games ?? 0} Games</div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-family:var(--font-display); font-size:1.1rem; font-weight:800; color:var(--accent);">👑 ${connections}</div>
                            <div style="font-size:0.5rem; color:var(--text-muted); font-weight:700; letter-spacing:1px;">INFLUENCE</div>
                        </div>
                    </div>`;
                }).join('');

                content.innerHTML = tabs + `<div class="history-list">${html || '<div class="sl-empty">The Hall of Fame is currently empty.</div>'}</div>`;
            })
            .catch(() => {
                content.innerHTML = tabs + '<div class="sl-empty">Failed to load Hall of Fame.</div>';
            });

    } else if (tab === 'history') {
        if (StateStore.roundHistory.length === 0) {
            content.innerHTML = tabs + `
                <div style="text-align:center; padding:40px 0; color:var(--text-muted); font-size:0.85rem;">
                    No rounds played yet this session.
                </div>`;
            return;
        }

        const rounds = [...StateStore.roundHistory].reverse().map((round, i) => {
            const roundNum = StateStore.roundHistory.length - i;
            
            let timeHtml = '';
            if (round.timestamp) {
                const t = new Date(round.timestamp);
                const timeStr = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                timeHtml = `<div style="font-size:0.65rem; color:var(--text-muted); margin-left:auto;">${timeStr}</div>`;
            }

            const games = (round.matches || []).map((m, gi) => {
                const winIdx  = m.winnerTeamIndex;
                if (winIdx === null || winIdx === undefined) return '';
                const loseIdx = winIdx === 0 ? 1 : 0;

                const squadLookup = round.squadSnapshot || [];
                const getName = (id) => {
                    let p = squadLookup.find(s => s.uuid === id || s.name === id);
                    // Fallback to current squad if lookup in snapshot fails (e.g. legacy data or host refresh)
                    if (!p) p = StateStore.squad.find(s => s.uuid === id || s.name === id);
                    return p ? p.name : id;
                };

                const winners = (m.teams[winIdx] || []).map(getName).join(' & ') || '?';
                const losers  = (m.teams[loseIdx] || []).map(getName).join(' & ') || '?';

                const durationMs = (m.endedAt && m.startedAt) ? m.endedAt - m.startedAt : 0;
                const durMin = Math.floor(durationMs / 60000);
                const durSec = Math.floor((durationMs % 60000) / 1000);
                const durStr = durationMs > 0 ? `<span style="opacity:0.5; margin-left:6px; font-size:0.6rem;">⏱ ${durMin}:${durSec.toString().padStart(2, '0')}</span>` : '';

                return `
                    <div class="history-game">
                        <div class="history-game-label">Game ${gi + 1}</div>
                        <div class="history-matchup">
                            <span class="history-winner">${escapeHTML(winners)}</span>
                            <span class="history-vs">def.</span>
                            <span class="history-loser">${escapeHTML(losers)}</span>${durStr}
                        </div>
                        ${timeHtml}
                    </div>
                `;
            }).join('');

            return `
                <div class="history-round" style="animation-delay: ${i * 0.05}s">
                    <div class="history-round-label">Round ${roundNum}</div>
                    ${games}
                </div>
            `;
        }).join('');

        const searchBar = `
            <div style="margin-bottom: 12px; position: relative;">
                <input type="text" id="histSearchInput" placeholder="Search history..." 
                    style="width:100%; padding-right: 32px;"
                    oninput="window.filterHistory(this.value)">
                <button id="histSearchClear" onclick="window.clearHistorySearch()" 
                    style="position: absolute; right: 8px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--text-muted); cursor: pointer; display: none; font-size: 1rem; padding: 8px;">
                    ✕
                </button>
            </div>`;

        content.innerHTML = tabs + searchBar + `<div class="history-list">${rounds}</div>`;
    }
}

window.filterHistory = function(query) {
    const term = query.toLowerCase().trim();
    
    const clearBtn = document.getElementById('histSearchClear');
    if (clearBtn) clearBtn.style.display = term ? 'block' : 'none';

    const rounds = document.querySelectorAll('.history-round');
    rounds.forEach(round => {
        const games = round.querySelectorAll('.history-game');
        let roundVisible = false;
        games.forEach(game => {
            const match = !term || game.textContent.toLowerCase().includes(term);
            game.style.display = match ? 'flex' : 'none';
            if (match) roundVisible = true;
        });
        round.style.display = roundVisible ? 'block' : 'none';
    });
};

window.clearHistorySearch = function() {
    const input = document.getElementById('histSearchInput');
    if (input) {
        input.value = '';
        window.filterHistory('');
        input.focus();
    }
};

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
    const p  = StateStore.squad[idx];
    if (!p) return;

    const { title, icon } = getPlayerTitle(p);
    const wr  = p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0;
    const bg  = Avatar.color(p.name);
    const ini = Avatar.initials(p.name);

    // Calculate Form HTML
    const formHTML = (p.form || []).map(r => 
        `<span style="display:inline-block; width:18px; height:18px; border-radius:50%; background:${r==='W'?'var(--accent)':'rgba(239,68,68,0.2)'}; color:${r==='W'?'#000':'#ef4444'}; font-size:0.55rem; font-weight:800; text-align:center; line-height:18px; margin:0 2px;">${r}</span>`
    ).join('');

    // Calculate Rival
    let rival = '—';
    if (p.opponentHistory) {
        const rivals = Object.entries(p.opponentHistory).sort(([,a], [,b]) => b - a);
        if (rivals.length) {
            const rivalP = StateStore.squad.find(s => (s.uuid || s.name) === rivals[0][0]);
            rival = `${rivalP ? rivalP.name : 'Unknown'} (${rivals[0][1]}g)`;
        }
    }

    // Calculate Partner Chemistry
    let chemistryHTML = '';
    if (p.partnerStats && Object.keys(p.partnerStats).length > 0) {
        const partners = Object.entries(p.partnerStats);
        // Sort by wins, then by games played
        partners.sort(([, a], [, b]) => {
            if (b.wins !== a.wins) return b.wins - a.wins;
            return b.games - a.games;
        });
        const best = partners[0];
        if (best) {
            const [uuid, stats] = best;
            const partnerP = StateStore.squad.find(s => (s.uuid || s.name) === uuid);
            const wr = stats.games > 0 ? Math.round((stats.wins / stats.games) * 100) : 0;
            chemistryHTML = `
                <div class="pc-section-title" style="margin-top:24px;">Partner Chemistry</div>
                <div class="pc-chemistry-card">
                    <div class="pc-chem-icon">🤝</div>
                    <div class="pc-chem-details">
                        <div class="pc-chem-name">Best with: <strong>${escapeHTML(partnerP ? partnerP.name : 'Unknown')}</strong></div>
                        <div class="pc-chem-stats">${stats.wins}W - ${stats.games - stats.wins}L (${wr}%)</div>
                    </div>
                </div>
            `;
        }
    }

    document.getElementById('playerCardContent').innerHTML = `
        <div class="pc-avatar-wrap">
            <div class="pc-avatar" style="background:${bg}; font-style: ${p.spiritAnimal ? 'normal' : 'italic'};">${p.spiritAnimal || ini}</div>
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
            <div class="pc-stat-divider"></div>
            <div class="pc-stat" style="cursor:pointer;" onclick="openSetSkillLevelForCard(${idx})">
                <div class="pc-stat-val" style="font-size:0.75rem; margin-top:4px;">
                    <span class="skill-badge skill-${(p.skillLevel || 'Intermediate').toLowerCase()}">
                        ${(p.skillLevel === 'Novice' ? '🌱 NOVICE' : p.skillLevel === 'Advanced' ? '👑 PRO' : '⚔️ INTER')}
                    </span>
                </div>
                <div class="pc-stat-label">Skill</div>
            </div>
        </div>
        <div style="display:flex; justify-content:space-between; margin-bottom:16px; padding:0 10px;">
            <div style="text-align:left;">
                <div style="font-size:0.6rem; color:var(--text-muted); font-weight:700; margin-bottom:4px;">FORM</div>
                <div>${formHTML || '<span style="opacity:0.5; font-size:0.8rem;">-</span>'}</div>
            </div>
            <div style="text-align:right;">
                <div style="font-size:0.6rem; color:var(--text-muted); font-weight:700; margin-bottom:4px;">RIVAL</div>
                <div style="font-size:0.85rem; font-weight:600;">${escapeHTML(rival)}</div>
            </div>
        </div>
        ${p.streak > 0 ? `<div class="pc-streak">🔥 ${p.streak} game win streak</div>` : ''}
        ${chemistryHTML}
        <div id="pc-achievements-container"></div>
    `;

    document.getElementById('playerCardModal').style.display = 'flex';
    Haptic.bump();

    // Render achievements directly from local squad data
    const achievementsContainer = document.getElementById('pc-achievements-container');
    if (achievementsContainer) {
        if (window.Achievements) {
            const allAchHTML = Object.keys(window.Achievements).map(key => {
                const data = window.getAchievementDisplay(key, p.achievements);
                const isUnlocked = data.unlocked;
                return `
                    <div class="pc-achievement-badge ${isUnlocked ? 'unlocked' : 'locked'}" 
                         style="${isUnlocked ? `border-color:${data.color}; box-shadow: 0 0 10px ${data.color}44; color:${data.color}` : ''}"
                         title="${data.name}: ${data.description}"
                         onmousedown="startAchPress('${key}', '${p.uuid || p.name}')" onmouseup="endAchPress()"
                         ontouchstart="startAchPress('${key}', '${p.uuid || p.name}')" ontouchend="endAchPress()"
                         oncontextmenu="event.preventDefault(); return false;">
                        ${data.icon}
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

/**
 * Generates a beautiful recovery card image for the player to save.
 */
async function generateRecoveryCard() {
    const p = Passport.get();
    if (!p) return;

    if (window.Haptic) Haptic.tap();
    if (typeof showSessionToast === 'function') showSessionToast('🎨 Generating Card...');

    if (!window.html2canvas) {
        await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }

    const avatarColor = Avatar.color(p.playerName);
    const emoji = p.spiritAnimal || '🐾';

    // Create an off-screen high-quality card
    const card = document.createElement('div');
    card.style.cssText = `
        position: fixed; left: -9999px; top: -9999px; width: 400px; padding: 40px;
        background: #0a0a0f; color: #f0f0f5; font-family: sans-serif;
        border-radius: 24px; text-align: center; border: 2px solid #00ffa3;
    `;

    card.innerHTML = `
        <div style="font-size: 0.65rem; letter-spacing: 4px; color: #00ffa3; margin-bottom: 24px; font-weight: 900; text-transform: uppercase;">COURTSIDE PRO RECOVERY CARD</div>
        
        <div style="width: 100px; height: 100px; border-radius: 50%; background: ${avatarColor}; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; font-size: 3rem; border: 4px solid #0a0a0f; box-shadow: 0 0 0 2px #00ffa3;">
            ${p.spiritAnimal || (p.playerName || '?').charAt(0).toUpperCase()}
        </div>
        
        <div style="font-size: 2.2rem; font-weight: 900; font-style: italic; text-transform: uppercase; margin-bottom: 8px;">${escapeHTML(p.playerName)}</div>
        <div style="display: inline-block; font-size: 0.7rem; font-weight: 800; letter-spacing: 2px; color: #00ffa3; background: rgba(0, 255, 163, 0.15); padding: 4px 14px; border-radius: 20px; border: 1px solid rgba(0, 255, 163, 0.25); margin-bottom: 30px;">${emoji} ATHLETE</div>
        
        <div style="background: #111118; border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; padding: 24px; margin-bottom: 20px;">
            <div style="font-size: 0.55rem; color: #6b6b80; letter-spacing: 1.5px; margin-bottom: 10px; font-weight: 800; text-transform: uppercase;">YOUR PRIVATE RECOVERY KEY</div>
            <div style="font-family: monospace; font-size: 0.8rem; color: #00ffa3; word-break: break-all; line-height: 1.5; background: #000; padding: 12px; border-radius: 8px;">${p.playerUUID}</div>
        </div>
        
        <div style="font-size: 0.65rem; color: #6b6b80; line-height: 1.6; max-width: 280px; margin: 0 auto;">Keep this key safe. Use it to restore your career trophies and statistics if you switch phones or clear your data.</div>
        
        <div style="margin-top: 40px; font-size: 0.55rem; color: rgba(0, 255, 163, 0.4); letter-spacing: 2px; font-weight: 700; text-transform: uppercase;">thecourtsidepro.vercel.app</div>
    `;

    document.body.appendChild(card);

    try {
        const canvas = await html2canvas(card, {
            backgroundColor: '#0a0a0f',
            scale: 2,
            useCORS: true,
            logging: false,
        });

        canvas.toBlob(async (blob) => {
            const url = URL.createObjectURL(blob);
            const fileName = `Courtside-Recovery-${p.playerName.replace(/\s+/g, '-')}.png`;
            
            // Use Native Share if available (Mobile optimization)
            const file = new File([blob], fileName, { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({ files: [file], title: 'Courtside Pro Recovery Key' });
                } catch (e) { if (e.name !== 'AbortError') console.error(e); }
            } else {
                // Fallback to traditional download
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                a.click();
                if (typeof showSessionToast === 'function') showSessionToast('✅ Card Downloaded');
            }

            if (window.Haptic) Haptic.success();
        }, 'image/png');
    } catch (e) { console.error(e); }
    finally { document.body.removeChild(card); }
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
    const m = StateStore.currentMatches[matchIdx];
    if (!m) return;

    if (typeof generateShareableImage === 'function') {
        generateShareableImage({
            teamA: (m.teams[0] || []).join(' & '),
            teamB: (m.teams[1] || []).join(' & '),
            title: 'LIVE NOW'
        }).catch(e => {
            console.error('Aura poster failed:', e);
            showSessionToast('Could not generate poster');
        });
    } else {
        console.error('generateShareableImage function not found.');
        showSessionToast('Share function is unavailable.');
    }
}

// ---------------------------------------------------------------------------
// "I WANT TO PLAY" — Spectator feature
// ---------------------------------------------------------------------------

let playRequests = [];
window.playRequests = playRequests;

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
    // Use window.squad for player-side logic, as StateStore is for the host.
    const currentSquad = window.squad || [];
    if (currentSquad.length === 0) {
        list.innerHTML = `<p class="iwtp-empty">No players yet.<br>Ask the host to add players first.</p>`;
        return;
    }
    list.innerHTML = currentSquad.map(p => `
        <button class="iwtp-player-chip" onclick="confirmSpectateAs('${escapeHTML(p.name)}')">
            ${Avatar.html(p.name, p.spiritAnimal)}
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
    const p     = (typeof Passport !== 'undefined') ? Passport.get() : null;

    if (!name) { showSessionToast('Please enter your name first.'); input?.focus(); return; }
    if (!currentRoomCode) { showSessionToast('Not connected to a session.'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

    try {
        const res = await fetch('/api/play-request', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ 
                room_code: currentRoomCode, 
                name,
                player_uuid: p?.playerUUID || null,
                spirit_animal: p?.spiritAnimal || null
            }),
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
        // Use window.squad for player-side logic, as StateStore is for the host.
        const match = (window.squad || []).find(p => p.name.toLowerCase() === savedName.toLowerCase());
        if (match) { confirmSpectateAs(match.name); return; }
    }
    showIWTPChoice();
}

let _lastSeenRequestIds = new Set();
let _pollingInterval = null;
let _isPolling = false;

/**
 * Tracks seen request IDs to prevent duplicate processing/notifications.
 * Implements a sliding window (max 200 IDs) to prevent memory leaks in long sessions.
 */
function _trackRequestId(id) {
    if (!id) return;
    _lastSeenRequestIds.add(id);
    if (_lastSeenRequestIds.size > 200) {
        const oldest = _lastSeenRequestIds.values().next().value;
        _lastSeenRequestIds.delete(oldest);
    }
}

function _isPlayerAlreadyInSession(record) {
    if (!record) return null;
    const uuidMap = window._sessionUUIDMap || {};
    return StateStore.squad.find(p => 
        (record.player_uuid && p.uuid === record.player_uuid) || 
        (p.name.toLowerCase() === (record.name || '').toLowerCase()) ||
        (record.player_uuid && uuidMap[record.name] === record.player_uuid)
    );
}

async function pollPlayRequests() {
    if (_isPolling || !isOnlineSession || !isOperator || !currentRoomCode || _isProcessingOpenPartyBatch) return;
    _isPolling = true;
    try {
        const res  = await fetch(`/api/play-request?room_code=${encodeURIComponent(currentRoomCode)}`);
        const data = await res.json();
        const incoming = data.requests || [];

        const trulyPending = [];

        for (const r of incoming) {
            const isOpen = StateStore.get('isOpenParty');
            if (!_lastSeenRequestIds.has(r.id)) {
                // Track immediately to prevent race-induced duplicate processing
                _trackRequestId(r.id);

                const existing = _isPlayerAlreadyInSession(r);

                if (existing) {
                    console.log(`[CourtSide] Auto-resolving request for ${r.name} (already in squad)`);

                    // UUID Correction: If manually added by host, adopt the player's real UUID
                    // so memberApprove() and future syncs use the correct canonical ID.
                    if (r.player_uuid && existing.uuid !== r.player_uuid) {
                        existing.uuid = r.player_uuid;
                        renderSquad(); // Update DOM datasets
                        saveToDisk();
                    }

                    if (existing.uuid && typeof window.memberApprove === 'function') window.memberApprove(existing.uuid);
                    fetch('/api/play-request', {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: r.id, room_code: window.currentRoomCode, operator_key: window.operatorKey }),
                    }).catch(() => {});
                    continue;
                }

                if (isOpen) {
                    console.log(`[CourtSide] Auto-approving ${r.name} (Open Party)`);
                    await approvePlayRequest(r.name, r.id, r.player_uuid || null);
                    continue;
                }
                trulyPending.push(r);
                showJoinNotification(r.name, r.id, r.player_uuid || null, r.spirit_animal || null);
            } else {
                // If we've seen it but it's still in the fetch, it's pending unless it's an auto-join
                if (!isOpen) trulyPending.push(r);
            }
        }

        playRequests = trulyPending;
        window.playRequests = trulyPending;

        const badge = document.getElementById('playRequestsBadge');
        const count = document.getElementById('playRequestsCount');
        if (badge && count) {
            const hasReqs = trulyPending.length > 0;
            badge.style.display = hasReqs ? 'flex' : 'none';
            count.textContent   = trulyPending.length;
        }
    } catch (e) { console.error('[pollPlayRequests] failed', e); } finally { _isPolling = false; }
}

const _notifQueue = [];
let   _notifShowing = false;

function showJoinNotification(name, id, uuid = null, emoji = null) {
    _notifQueue.push({ name, id, uuid, emoji });
    if (!_notifShowing) processNotifQueue();
}

function processNotifQueue() {
    if (_notifQueue.length === 0) { _notifShowing = false; return; }
    _notifShowing = true;

    const { name, id, uuid, emoji } = _notifQueue.shift();
    const notif  = document.getElementById('joinNotification');
    const nameEl = document.getElementById('joinNotifName');
    if (!notif || !nameEl) return;

    nameEl.innerHTML    = emoji ? `<span style="margin-right:8px">${emoji}</span>${escapeHTML(name)}` : escapeHTML(name);
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
    }
    dismissJoinNotification();
}

async function notifDecline() {
    const notif = document.getElementById('joinNotification');
    const id    = notif?.dataset.id;
    if (id) {
        await denyPlayRequest(id);
    }
    dismissJoinNotification();
}

function showPlayRequests() {
    const modal = document.getElementById('playRequestsModal');
    const list  = document.getElementById('playRequestsList');
    if (!modal || !list) return;

    const approveAllHTML = playRequests.length > 1 
        ? `<button class="btn-main" style="margin-bottom:12px; background:var(--accent); color:#000; font-size:0.8rem; height:40px;" onclick="approveAllRequests()">✓ Approve All (${playRequests.length})</button>`
        : '';

    list.innerHTML = playRequests.length === 0
        ? '<p style="text-align:center;color:var(--text-muted);padding:20px 0;">No pending requests.</p>'
        : approveAllHTML + playRequests.map(r => `
            <div class="pr-row">
                ${r.spirit_animal ? `<span style="font-size:1.2rem;margin-right:8px;">${r.spirit_animal}</span>` : ''}
                <span class="pr-name">${escapeHTML(r.name)}</span>
                <button class="pr-add-btn" onclick="approvePlayRequest('${escapeHTML(r.name)}', '${r.id}', '${r.player_uuid||''}')">+ Add</button>
                <button class="pr-deny-btn" onclick="denyPlayRequest('${r.id}')">✕</button>
            </div>
        `).join('');

    modal.style.display = 'flex';
}

async function approveAllRequests() {
    if (!window.playRequests || window.playRequests.length === 0) return;
    const toApprove = [...window.playRequests];
    closePlayRequests();
    showSessionToast(`Processing ${toApprove.length} approvals...`);
    for (const r of toApprove) {
        await approvePlayRequest(r.name, r.id, r.player_uuid || null);
    }
}
window.approveAllRequests = approveAllRequests;

function closePlayRequests() {
    document.getElementById('playRequestsModal').style.display = 'none';
}

function _resolvePlayerForSession(name, incomingUUID) {
    const validUUID = incomingUUID && incomingUUID.trim().length > 0 ? incomingUUID : null;
    let player = null;
    let finalName = name;

    // 1. Priority: UUID (Canonical Identity)
    if (validUUID) {
        player = StateStore.squad.find(p => p.uuid === validUUID);
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
    // 2. Secondary: Name-based lookup (Smart Recognition)
    // If UUID didn't match but the name does, assume it's the same person
    // ONLY if the squad entry has no UUID (Legacy/Guest).
    player = StateStore.squad.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (player && (!player.uuid || player.uuid === incomingUUID)) {
        if (validUUID && !player.uuid) player.uuid = validUUID; // Adopt canonical ID
        return player;
    }

    // 3. Truly NEW player — handle collisions
    //    Check for name collisions and auto-rename.
    let collision = StateStore.squad.find(p => p.name.toLowerCase() === finalName.toLowerCase());
    let counter = 1;
    while (collision) {
        finalName = `${name} (${counter})`;
        collision = StateStore.squad.find(p => p.name.toLowerCase() === finalName.toLowerCase());
        counter++;
    }

    // 3. Create new player
    player = migratePlayer({
        name: finalName,
        uuid: validUUID || _generateUUID(),
    });

    return player;
}
window._resolvePlayerForSession = _resolvePlayerForSession;

/**
 * Handles a player joining via Open Party (no approval required).
 * Reuses logic from approvePlayRequest without the deletion step.
 */
function handleAutoJoin(name, playerUUID, spiritAnimal = null, skillLevel = null) {
    if (!window.isOperator) return;
    
    // Avoid duplicates if already processed via broadcast or Postgres change
    if (StateStore.squad.some(p => p.uuid === playerUUID)) return;

    const player = _resolvePlayerForSession(name, playerUUID);
    if (spiritAnimal) player.spiritAnimal = spiritAnimal;
    if (skillLevel)   player.skillLevel   = skillLevel;
    player.active = true;
    player.acknowledged = false;

    let newSquad = [...StateStore.squad];
    const existingIdx = newSquad.findIndex(p => p.uuid === player.uuid);
    
    if (existingIdx === -1) {
        newSquad.push(player);
    } else {
        newSquad[existingIdx].name = name;
    }

    // BACKGROUND ACHIEVEMENT FETCHING (Prevent Race Conditions)
    // Ensures the player is added to the squad immediately while trophies load in background.
    if (player.uuid && window.fetchPlayerAchievements) {
        (async () => {
            try {
                const fetched = await window.fetchPlayerAchievements(player.uuid);
                const achievementIds = fetched.map(a => a.achievement_id);
                player.achievements = [...new Set([...(player.achievements || []), ...achievementIds])];
                StateStore.set('squad', [...StateStore.squad]); // Signal update and broadcast
                renderSquad();
            } catch (e) { console.error(`[handleAutoJoin] Failed to fetch achievements for ${player.name}`, e); }
        })();
    }

    let newQueue = [...StateStore.playerQueue];
    if (!newQueue.includes(player.uuid)) newQueue.push(player.uuid);

    StateStore.setState({ squad: newSquad, playerQueue: newQueue });
    renderSquad();
    if (typeof renderQueueStrip === 'function') renderQueueStrip();
    
    if (window.Haptic) Haptic.success();
    console.log(`[CourtSide] Auto-joined player: ${name}`);
}
window.handleAutoJoin = handleAutoJoin;

let _processingRequestIds = new Set();

async function approvePlayRequest(name, id, playerUUID = null) {
    if (!id || _processingRequestIds.has(id)) return;
    _processingRequestIds.add(id);

    console.log(`[CourtSide] Approving ${name}, UUID: ${playerUUID}`);
    
    try {
    const requestRow = playRequests.find(r => String(r.id) === String(id));
    const reconciledAchievements = requestRow?.achievements;
    const initialEmoji = requestRow?.spirit_animal;

    // Capture existing state to prevent queue duplication if name changes
    const existing = StateStore.squad.find(p => (playerUUID && p.uuid === playerUUID) || (p.name.toLowerCase() === name.toLowerCase()));
    const oldName = existing ? existing.name : null;

    const player = _resolvePlayerForSession(name, playerUUID);
    const finalName = player.name;
    const validUUID = player.uuid;

    let newSquad = [...StateStore.squad];
    // Identity Integrity: Ensure the player is in the squad array
    if (!newSquad.find(p => p.uuid === validUUID)) {
        newSquad.push(player);
    }

    if (initialEmoji) player.spiritAnimal = initialEmoji;

    // BACKGROUND ACHIEVEMENT FETCHING (Prevent Race Condition)
    // We move this to an async block so StateStore.setState happens immediately.
    // This prevents multiple paths from adding the same player if approval triggers overlap.
    if (player.uuid && window.fetchPlayerAchievements) {
        (async () => {
            try {
                let achievementIds = [];
                if (Array.isArray(reconciledAchievements)) {
                    achievementIds = reconciledAchievements;
                } else {
                    const fetched = await window.fetchPlayerAchievements(player.uuid);
                    achievementIds = fetched.map(a => a.achievement_id);
                }
                const currentSet = new Set(player.achievements || []); 
                achievementIds.forEach(id => currentSet.add(id));
                player.achievements = Array.from(currentSet);
                StateStore.set('squad', [...StateStore.squad]); // Signal update
            } catch (e) { console.error(`Failed to fetch achievements for ${player.name}`, e); }
        })();
    }
    player.active = true;

    window._sessionUUIDMap = window._sessionUUIDMap || {};
    if (validUUID) window._sessionUUIDMap[player.name] = validUUID;

    const token = _makeApprovalToken();
    window._approvedPlayers = window._approvedPlayers || {};
    window._approvedPlayers[validUUID || player.name] = { token, name: player.name, uuid: validUUID, approvedAt: Date.now() };

    // Update queue state formally using UUID
    let newQueue = [...StateStore.playerQueue];
    if (!newQueue.includes(player.uuid)) {
        newQueue.push(player.uuid);
    }

    renderSquad();
    if (typeof renderQueueStrip === 'function') renderQueueStrip();

    // Grouped Sync: Update both keys formally to ensure consistency and trigger cloud broadcast
    StateStore.setState({ squad: newSquad, playerQueue: newQueue });

    showSessionToast(`✅ ${player.name} added`);
    Haptic.success();

    if (typeof memberApprove === 'function' && validUUID) {
        memberApprove(validUUID);
    }

    if (typeof broadcastApproval === 'function') {
        broadcastApproval(validUUID, player.name, token);
    }

    await denyPlayRequest(id);
    } catch (e) {
        console.error('[approvePlayRequest] Failed', e);
    } finally {
        _processingRequestIds.delete(id);
    }
}

function _makeApprovalToken() {
    return Array.from({ length: 12 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
}

function _generateUUID() {
    if (window.Passport && typeof window.Passport._uuid === 'function') {
        return window.Passport._uuid();
    }
    // Use native crypto API as primary fallback if Passport is missing
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

async function denyPlayRequest(id) {
    try {
        await fetch('/api/play-request', {
            method:  'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ id, room_code: currentRoomCode, operator_key: operatorKey }),
        });
        await pollPlayRequests();
        showPlayRequests();
    } catch { /* silent */ }
}

// Called by sync.js when a Realtime INSERT event occurs on play_requests table
window.onPlayRequestInsert = async function(record) {
    if (!record) return;
    if (!_lastSeenRequestIds.has(record.id)) {
        // Track immediately to prevent duplicate processing
        _trackRequestId(record.id);

        // Metadata Integrity: Ensure the record is in the cache so approvePlayRequest
        // can extract the spirit animal and achievements during auto-approval.
        if (!playRequests.some(r => r.id === record.id)) {
            playRequests.push(record);
            if (playRequests.length > 100) playRequests.shift(); // Max-size cleanup
            window.playRequests = playRequests;
        }

        const existing = _isPlayerAlreadyInSession(record);

        if (existing) {
            // Adopt real UUID for manual additions triggered by realtime events
            if (record.player_uuid && existing.uuid !== record.player_uuid) {
                existing.uuid = record.player_uuid;
                renderSquad();
            }

            if (existing.uuid && typeof window.memberApprove === 'function') window.memberApprove(existing.uuid);
            fetch('/api/play-request', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: record.id, room_code: window.currentRoomCode, operator_key: window.operatorKey }),
            }).catch(() => {});
            return;
        }

        // Lock Check: If a batch approval is currently running, ignore realtime
        // triggers for a moment. Sequential integrity is maintained by the
        // batch loop and the next polling cycle.
        if (_isProcessingOpenPartyBatch) return;

        if (StateStore.get('isOpenParty')) {
            await approvePlayRequest(record.name, record.id, record.player_uuid);
            return;
        }

        showJoinNotification(record.name, record.id, record.player_uuid || null, record.spirit_animal || null);
    }
    if (!_isProcessingOpenPartyBatch) pollPlayRequests(); // Fetch full list to ensure badge count is accurate
};

function ensureHostUI() {
    // Only show host UI if not in player/spectator view
    const isPlayerView = document.body.classList.contains('player-mode');
    if (isPlayerView) return;

    // Create a host dashboard area if it doesn't exist
    let dashboard = document.getElementById('hostDashboard');
    if (!dashboard) {
        dashboard = document.createElement('div');
        dashboard.id = 'hostDashboard';
        dashboard.className = 'host-dashboard';
        dashboard.style.display = 'flex';
        const container = document.querySelector('.app-container');
        if (container) {
            const header = container.querySelector('header');
            if (header) header.insertAdjacentElement('afterend', dashboard);
        }
    }

    // Add Director Hub container
    if (!document.getElementById('directorHub')) {
        const hub = document.createElement('div');
        hub.id = 'directorHub';
        hub.className = 'panel'; 
        hub.style.padding = '16px';
        hub.style.marginBottom = '12px';
        hub.innerHTML = `
            <div class="sync-section-label" style="margin-bottom:12px; font-size:0.6rem;">Director Insights</div>
            <div id="directorHubGrid" class="sh-insights-grid"></div>
        `;
        dashboard.insertBefore(hub, dashboard.firstChild);
    }
    renderDirectorHub();

    // Add Open Party Toggle
    if (!document.getElementById('slOpenPartyToggle')) {
        const toggle = document.createElement('div');
        toggle.id = 'slOpenPartyToggle';
        toggle.className = 'open-party-toggle';
        toggle.onclick = () => toggleOpenParty();
        dashboard.appendChild(toggle);
        renderOpenPartyToggle();
    }

    // 1. Join Notification Toast (Popup)
   if (!document.getElementById('joinNotification')) {
        const notif = document.createElement('div');
        notif.id = 'joinNotification';
        notif.className = 'join-notif';
        notif.innerHTML = `
            <div class="join-notif-inner">
                <div class="join-notif-label">REQUEST TO JOIN</div>
                <div class="join-notif-name" id="joinNotifName">PLAYER</div>
                <div class="join-notif-actions">
                    <button class="join-notif-approve" onclick="notifApprove()">APPROVE</button>
                    <button class="join-notif-decline" onclick="notifDecline()">DECLINE</button>
                </div>
            </div>
        `;
        document.body.appendChild(notif);
    }

    // 2. Play Requests Badge (The Button)
    if (!document.getElementById('playRequestsBadge')) {
        const badge = document.createElement('div');
        badge.id = 'playRequestsBadge';
        badge.className = 'play-requests-badge';
        badge.onclick = window.showPlayRequests;
        badge.style.display = 'none'; 
        badge.innerHTML = `
            <span>PENDING REQUESTS</span>
            <span id="playRequestsCount" style="background:rgba(0,0,0,0.3); color:var(--accent); padding:2px 8px; border-radius:6px; margin-left:10px; font-size:0.7rem; border:1px solid var(--border-accent);">0</span>
        `;
        if (dashboard) dashboard.appendChild(badge);
        else document.body.appendChild(badge);
    }

    // 3. Play Requests Modal (The List)
    if (!document.getElementById('playRequestsModal')) {
        const modal = document.createElement('div');
        modal.id = 'playRequestsModal';
        modal.className = 'play-requests-modal';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="play-requests-card">
                <div class="play-requests-title">Pending Requests</div>
                <div id="playRequestsList" style="max-height: 300px; overflow-y: auto;"></div>
                <button class="btn-cancel" onclick="closePlayRequests()" style="margin-top:12px;">Close</button>
            </div>
        `;
        document.body.appendChild(modal);
    }
}

const _startPolling = () => {
    if (_pollingInterval) clearInterval(_pollingInterval);
    ensureHostUI();
    pollPlayRequests();
    
    _pollingInterval = setInterval(async () => { 
        if (isOnlineSession && isOperator) {
            pollPlayRequests();
            
            // Self-Healing: Check for players who are 'active' in DB but missing in local squad
            if (!_isProcessingOpenPartyBatch) try {
                const res = await fetch(`/api/play-request?room_code=${encodeURIComponent(currentRoomCode)}&status=active`);
                const data = await res.json();
                const activeInDB = data.requests || [];
                
                for (const dbPlayer of activeInDB) {
                    const inLocal = StateStore.squad.some(p => p.uuid === dbPlayer.player_uuid);
                    if (!inLocal) {
                        console.log(`[Reconciliation] Recovering missed player: ${dbPlayer.name}`);
                        await approvePlayRequest(dbPlayer.name, dbPlayer.id, dbPlayer.player_uuid);
                    }
                }
            } catch (e) {}
        }
    }, 15000);
};
window._startPolling = _startPolling;

function updateIWTPVisibility() {
    const sheet = document.getElementById('iwantToPlaySheet');
    if (!sheet) return;

    // BUG FIX: Only show the "I want to play" sheet for spectators.
    // If the user is already in player-mode (sideline view), hide the join prompt.
    const isPlayerView = document.body.classList.contains('player-mode');
    const show = isOnlineSession && !isOperator && !isPlayerView;

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

    UIManager.prompt({
        title: 'Update Name',
        initialValue: passport.playerName,
        confirmText: 'Save Name',
        onConfirm: (newName) => {
            const trimmed = (newName || '').trim();
            if (!trimmed) return;
            
            const oldName = passport.playerName;
            Passport.rename(trimmed);
            
            if (typeof PlayerMode !== 'undefined') {
                PlayerMode._renderIdentity(Passport.get());
            }

            if (typeof isOnlineSession !== 'undefined' && isOnlineSession) {
                // KEY FIX: If Host renames, update squad/matches/queue immediately
                if (window.isOperator && typeof window._applyNameUpdate === 'function') {
                    window._applyNameUpdate(passport.playerUUID, oldName, trimmed);
                } else {
                    // Player/Spectator renames: broadcast to host
                    if (typeof broadcastNameUpdate === 'function') {
                        broadcastNameUpdate(passport.playerUUID, oldName, trimmed);
                    }
                    if (typeof SidelineView !== 'undefined' && SidelineView._visible) {
                        SidelineView.refresh();
                    }
                }
                
                if (typeof memberRename === 'function') {
                    memberRename(passport.playerUUID, trimmed);
                }
            } else {
                // Offline rename: update local squad if this device is the host
                const me = StateStore.squad.find(p => p.uuid === passport.playerUUID);
                if (me) {
                    me.name = trimmed;
                    // Update metadata maps for consistency
                    const uuidMap = window._sessionUUIDMap || {};
                    if (me.uuid && uuidMap[oldName] === me.uuid) delete uuidMap[oldName];
                    if (me.uuid) uuidMap[me.name] = me.uuid;
                    window._sessionUUIDMap = uuidMap;

                    if (window._approvedPlayers) {
                        const entry = window._approvedPlayers[me.uuid] || window._approvedPlayers[oldName];
                        if (entry) {
                            entry.name = me.name;
                            if (window._approvedPlayers[oldName]) {
                                delete window._approvedPlayers[oldName];
                                window._approvedPlayers[me.uuid] = entry;
                            }
                        }
                    }

                    // Force StateStore to acknowledge the change and persist to disk
                    StateStore.set('squad', [...StateStore.squad]);

                    renderSquad();
                    if (typeof rebuildMatchCardIndices === 'function') rebuildMatchCardIndices();
                    if (typeof renderQueueStrip === 'function') renderQueueStrip();
                }
            }

            // Global Refresh: Ensure standalone passport updates if open (Online or Offline)
            if (document.getElementById('passportStandalone')?.style.display === 'flex') {
                window.renderPassportStandalone(Passport.get());
            }

            showSessionToast(`✅ Name updated to ${trimmed}`);
        }
    });
}

/**
 * Processes a win/loss signal received via Realtime.
 * Refreshes the sideline view and acknowledges the signal in the DB.
 */
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
async function dispatchWinSignals(mIdx, skipBroadcast = false, timestamp = Date.now()) {
    if (!isOperator || !currentRoomCode) return;
    const m = StateStore.currentMatches[mIdx];
    if (!m || m.winnerTeamIndex === null) return;

    const winIdx  = m.winnerTeamIndex;
    const loseIdx = winIdx === 0 ? 1 : 0;
    const label   = `Game ${mIdx + 1}`;

    // Match objects store UUIDs now
    const winnerUUIDs = m.teams[winIdx]  || [];
    const loserUUIDs  = m.teams[loseIdx] || [];

    const winnerNames = winnerUUIDs.map(uuid => {
        const p = StateStore.squad.find(x => (x.uuid || x.name) === uuid);
        return p ? p.name : 'Unknown';
    });
    const winnerDisplayNames = winnerNames.join(' & ');

    if (typeof _broadcast === 'function' && isOnlineSession) {
        _broadcast('match_resolved', {
            winnerNames:  winnerDisplayNames,
            winnerUUIDs,
            loserUUIDs,
            gameLabel:    label,
            timestamp:    timestamp
        });
    }

    // 2. Broadcast game state so players see winner selection on match card.
    //    Skip when caller (processCourtResult) will broadcast after building
    //    the new lineup — so players receive one clean update with the next game.
    if (!skipBroadcast && typeof broadcastGameState === 'function' && isOnlineSession) {
        broadcastGameState(false, timestamp);
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

        // BUG FIX: If already in player mode, suppress the welcome back join prompt
        if (document.body.classList.contains('player-mode')) {
            sheet.style.display = 'none';
            return;
        }

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

    const isOpen = StateStore.get('isOpenParty');
    choiceView.innerHTML = `
        <div class="iwtp-title">Welcome back,</div>
        <div class="iwtp-passport-name">${escapeHTML(passport.playerName)}</div>
        <div class="iwtp-subtitle">Your passport was found on this device.</div>
        <button class="iwtp-btn" onclick="passportJoinSession()">
            🏀 ${isOpen ? 'Join Instantly' : 'Check-in to Room'} ${escapeHTML(currentRoomCode || '')}
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
    
    UIManager.prompt({
        title: 'Join Session',
        initialValue: passport?.playerName || '',
        placeholder: 'Enter name...',
        confirmText: 'Join',
        onConfirm: async (newName) => {
            const trimmed = (newName || '').trim();
            if (!trimmed) return;
            Passport.rename(trimmed);
            await submitPassportJoinRequest(trimmed, passport.playerUUID);
        }
    });
}

async function submitPassportJoinRequest(name, uuid) {
    if (!currentRoomCode) return;
    const btn = document.querySelector('.iwtp-btn');
    const p = (typeof Passport !== 'undefined') ? Passport.get() : null;

    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

    try {
        const res = await fetch('/api/play-request', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ room_code: currentRoomCode, name, player_uuid: uuid, spirit_animal: p?.spiritAnimal || null }),
        });

        if (res.ok) {
            collapseIWTPSheet();
            setTimeout(() => { SidelineView.show(); }, 450);
            showSessionToast('🏀 Request sent! Waiting for host approval…');
            Haptic.success();
        } else { throw new Error('Failed'); }
    } catch {
        if (btn) { btn.disabled = false; btn.textContent = 'Join Session'; }
        showSessionToast('Could not send request. Try again.');
    }
}

/**
 * Updates the UI for a pending request (modal and toast) if data changes via broadcast.
 */
window.updatePendingRequestUI = function(uuid, name, emoji) {
    if (!window.isOperator) return;

    // 1. Update toast if showing
    const notif = document.getElementById('joinNotification');
    if (notif && notif.classList.contains('show') && notif.dataset.uuid === uuid) {
        const nameEl = document.getElementById('joinNotifName');
        const finalName = name || notif.dataset.name;
        if (nameEl) {
            nameEl.innerHTML = emoji ? `<span style="margin-right:8px">${emoji}</span>${escapeHTML(finalName)}` : escapeHTML(finalName);
        }
        if (name) notif.dataset.name = name;
    }

    // 2. Update modal if open
    if (document.getElementById('playRequestsModal')?.style.display === 'flex') {
        showPlayRequests();
    }
};

function spectateOnly() {
    collapseIWTPSheet();
    document.body.classList.add('spectator-mode');
    showSessionToast('👁 Spectating live');
}


// =============================================================================
// LANDING PAGE
// =============================================================================

function showLandingPage() {
    if (document.getElementById('landingPage')) return;

    // Hide other standalone views if returning to menu
    const ps = document.getElementById('passportStandalone');
    if (ps) ps.style.display = 'none';
    const sl = document.getElementById('sidelinePanel');
    if (sl) sl.style.display = 'none';
    document.body.classList.remove('player-mode');

    const sport = StateStore.get('sport') || 'Badminton';

    if (typeof closeOverlay === 'function') closeOverlay();
    let div = document.getElementById('landingPage');
    if (!div) {
        div = document.createElement('div');
        div.id = 'landingPage';
        document.body.appendChild(div);
    }
    div.className = 'actionMenu'; // Reuse modal style
    div.style.zIndex = '9000';
    div.style.background = 'var(--bg)'; // Opaque background

    const sports = ['Badminton', 'Tennis', 'Pickleball'];
    const sportBtns = sports.map(s => `
        <button class="btn-main ${sport === s ? '' : 'ps-btn-sub'}" 
                style="flex:1; height:40px; font-size:0.7rem; ${sport === s ? 'background:var(--accent); color:#000;' : 'background:var(--surface2); color:var(--text); opacity:0.6;'}" 
                onclick="window.setGlobalSport('${s}')">
            ${window.SPORT_ICONS[s]} ${s.toUpperCase()}
        </button>
    `).join('');

    div.innerHTML = `
        <div class="menu-card" style="padding:40px 24px; max-width:360px; border:none; box-shadow:none; background:transparent;">
            <div style="font-family:var(--font-display); font-size:3.5rem; font-weight:900; font-style:italic; line-height:0.9; margin-bottom:10px; color:var(--text);">
                COURTSIDE<span style="color:var(--accent);">PRO</span>
            </div>
            <p style="color:var(--text-muted); margin-bottom:40px; font-size:0.9rem; letter-spacing:1px; text-transform:uppercase; font-weight:600;">
                ${sport} Match Maker
            </p>

            <div style="display:flex; gap:8px; margin-bottom:24px; background:var(--bg2); padding:4px; border-radius:12px; border:1px solid var(--border);">
                ${sportBtns}
            </div>

            <button class="btn-main" onclick="closeLandingPage()" style="width:100%; margin-bottom:16px; height:60px; font-size:1.2rem; box-shadow:0 0 30px var(--accent-dim);">
                Host Session
            </button>
            <button class="btn-main" onclick="goToPlayerMode()" style="width:100%; background:var(--surface2); color:var(--text); height:60px; font-size:1.2rem; border:1px solid var(--border);">
                Join as Player
            </button>
            <button class="btn-main" onclick="openStandalonePassport()" style="width:100%; background:var(--bg2); color:var(--text); height:60px; font-size:1.2rem; border:1px solid var(--border); margin-top:16px;">
                🪪 My Passport
            </button>
            <button class="btn-main" onclick="PlayerMode.restorePassportPrompt()" style="width:100%; background:transparent; color:var(--text-muted); height:40px; font-size:0.8rem; border:none; margin-top:8px;">
                Already have a passport? Restore it
            </button>
        </div>
    `;
}

window.setGlobalSport = function(s) {
    StateStore.set('sport', s);
    showLandingPage();
    Haptic.tap();
};
window.goToMainMenu = showLandingPage;

window.closeLandingPage = function() {
    const el = document.getElementById('landingPage');
    if (!el) return;

    const doClose = () => {
        el.style.transition = 'opacity 0.3s';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
    };

    // If the host has no name, prompt them before starting.
    if (passport && !passport.playerName) {
        UIManager.prompt({
            title: 'Enter Your Name',
            initialValue: '',
            confirmText: 'Start Hosting',
            onConfirm: (name) => {
                if (name && name.trim()) {
                    // Create the host's passport and add them to the squad.
                    Passport.rename(name.trim());
                    passport = Passport.get(); // Re-fetch passport
                    _autoAddHostToSquad(); // This will now find and add them
                    doClose();
                } else {
                    doClose(); // Close without adding if they cancel.
                }
            }
        });
    } else {
        // Host already has a name, _autoAddHostToSquad should have already run.
        doClose();
    }
};

window.openStandalonePassport = function() {
    const el = document.getElementById('landingPage');
    if (el) el.remove();
    
    const ps = document.getElementById('passportStandalone');
    const sl = document.getElementById('sidelinePanel');
    
    // Ensure SidelineView is hidden so they don't overlap
    if (sl) sl.style.display = 'none';

    const p = Passport.get();
    if (ps && p) {
        ps.style.display = 'flex';
        document.body.classList.add('player-mode'); // Use context to hide host UI
        window.renderPassportStandalone(p);

        // 'Silent Hydrate' - Update career stats and trophies from global players table
        if (p.playerUUID) {
            fetch('/api/member-upsert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    room_code: 'RESTORE', 
                    player_uuid: p.playerUUID, 
                    player_name: p.playerName 
                })
            })
            .then(res => res.json())
            .then(data => {
                if (data.global) {
                    const { passport: updatedP, needsUpload } = Passport.hydrate(data.global);

                    // 2. Fetch global leaderboard to compute rank percentile
                    fetch('/api/leaderboard-get')
                        .then(lbRes => lbRes.json())
                        .then(lbData => {
                            const players = lbData.players || [];
                            const rankIdx = players.findIndex(lp => lp.uuid === updatedP.playerUUID);
                            if (rankIdx !== -1) {
                                const rank = rankIdx + 1;
                                const percentile = Math.ceil((rank / players.length) * 100);
                                const percHTML = players.length > 5 ? `<div style="font-size:0.5rem; opacity:0.6; margin-top:2px; font-style:normal; font-weight:700;">TOP ${percentile}%</div>` : '';
                                window._lastRankDisplay = `#${rank}${percHTML}`;
                                window.renderPassportStandalone(updatedP, window._lastRankDisplay);
                            } else {
                                window.renderPassportStandalone(updatedP);
                            }
                        })
                        .catch(() => window.renderPassportStandalone(updatedP));

                    // If local stats are more advanced than the cloud, perform a reconcile sync
                    if (needsUpload && !window.isOnlineSession) {
                        console.log('[Passport] Local data advanced; reconciling with cloud...');
                        fetch('/api/match-history', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                type: 'reconcile_sync',
                                player_uuid: updatedP.playerUUID,
                                total_wins: updatedP.stats.wins,
                                total_games: updatedP.stats.games,
                                achievements: updatedP.achievements,
                                teammate_history: updatedP.teammateHistory,
                                opponent_history: updatedP.opponentHistory,
                                partner_stats: updatedP.partnerStats
                            })
                        }).catch(e => console.warn('[Passport] Reconciliation failed', e));
                    }
                }
            })
            .catch(e => console.warn('[Passport] Silent hydrate failed', e));
        }
    }
};

window.renderPassportStandalone = function(p, globalRank = window._lastRankDisplay || '—') {
    const content = document.getElementById('passportStandaloneContent');
    if (!content || !p) return;

    const stats = p.stats || { wins: 0, games: 0 };
    const wr = stats.games > 0 ? Math.round((stats.wins / stats.games) * 100) : 0;
    const avatarColor = Avatar.color(p.playerName);
    const emoji = p.spiritAnimal || '🐾';

    const renderTrophies = (ids) => {
        const listEl = document.getElementById('psAchievements');
        if (!listEl) return;
        const html = Object.keys(window.Achievements || {}).map(key => {
            const data = window.getAchievementDisplay(key, ids);
            if (!data.unlocked) return '';
            return `
                <div class="ps-trophy" title="${data.name}: ${data.description}">
                    <div class="ps-trophy-icon">${data.icon}</div>
                    <div class="ps-trophy-name">${data.name}</div>
                </div>
            `;
        }).join('');
        listEl.innerHTML = html || '<div class="ps-empty-ach">No trophies earned yet.</div>';
    };

    // Legacy Calculations
    const squad = (typeof StateStore !== 'undefined' ? StateStore.squad : null) || window.squad || [];
    
    let rivalDisplay = '—';
    if (p.opponentHistory && Object.keys(p.opponentHistory).length > 0) {
        const rivals = Object.entries(p.opponentHistory).sort(([, a], [, b]) => b - a);
        const [rUUID, rCount] = rivals[0];
        const rivalName = squad.find(s => s.uuid === rUUID)?.name 
                       || p.partnerStats?.[rUUID]?.name 
                       || 'Veteran Rival';
        rivalDisplay = `${rivalName} (${rCount}g)`;
    }

    let partnerDisplay = '—';
    if (p.partnerStats && Object.keys(p.partnerStats).length > 0) {
        const partners = Object.entries(p.partnerStats)
            .filter(([, s]) => s.games >= 3)
            .sort(([, a], [, b]) => (b.wins / b.games) - (a.wins / a.games) || b.games - a.games);
        
        if (partners.length > 0) {
            const [pUUID, pStats] = partners[0];
            const wr = Math.round((pStats.wins / pStats.games) * 100);
            const pName = squad.find(s => s.uuid === pUUID)?.name 
                       || pStats.name 
                       || 'Elite Partner';
            partnerDisplay = `${pName} (${wr}% WR)`;
        }
    }

    content.innerHTML = `
        <div class="ps-header">
            <div class="ps-avatar-ring">
                <div class="ps-avatar" style="background:${avatarColor}">${p.spiritAnimal || (p.playerName || '?').charAt(0).toUpperCase()}</div>
            </div>
            <h1 class="ps-name">${escapeHTML(p.playerName)}</h1>
            <div class="ps-badge">${emoji} ATHLETE</div>
        </div>
        
        <div style="background:var(--bg2); border:1px solid var(--border); border-radius:12px; padding:12px; margin-bottom:20px; text-align:center;">
            <div style="font-size:0.55rem; color:var(--text-muted); letter-spacing:1px; margin-bottom:4px;">RECOVERY KEY (Keep this safe!)</div>
            <div style="font-family:monospace; font-size:0.7rem; color:var(--accent); cursor:pointer;" onclick="fallbackCopy('${p.playerUUID}', 'Key Copied!')">${p.playerUUID}</div>
        </div>

        <div class="ps-stats-grid">
            <div class="ps-stat-card" style="border-color:var(--accent-glow);">
                <div class="ps-stat-val" style="color:var(--accent); line-height:1.1;">${globalRank}</div>
                <div class="ps-stat-label">GLOBAL RANK</div>
            </div>
            <div class="ps-stat-card">
                <div class="ps-stat-val">${stats.games}</div>
                <div class="ps-stat-label">TOTAL GAMES</div>
            </div>
            <div class="ps-stat-card">
                <div class="ps-stat-val">${stats.wins}</div>
                <div class="ps-stat-label">TOTAL WINS</div>
            </div>
            <div class="ps-stat-card">
                <div class="ps-stat-val">${wr}%</div>
                <div class="ps-stat-label">WIN RATE</div>
            </div>
            <div class="ps-stat-card" style="cursor:pointer;" onclick="PlayerMode.openSkillLevelPicker()">
                <div class="ps-stat-val" style="font-size:0.85rem; margin-top:4px;">
                    <span class="skill-badge skill-${(p.skillLevel || 'Intermediate').toLowerCase()}" style="font-size:0.75rem; padding:4px 10px; border-radius:6px;">
                        ${(p.skillLevel === 'Novice' ? '🌱 NOVICE' : p.skillLevel === 'Advanced' ? '👑 PRO' : '⚔️ INTER')}
                    </span>
                </div>
                <div class="ps-stat-label">SKILL LEVEL</div>
            </div>
        </div>

        <div class="ps-section">
            <div class="ps-section-header">📜 LEGACY</div>
            <div class="ps-stats-grid" style="grid-template-columns: 1fr 1fr; gap: 10px;">
                <div class="ps-stat-card">
                    <div class="ps-stat-val" style="font-size: 0.85rem; color: var(--text);">${partnerDisplay}</div>
                    <div class="ps-stat-label">BEST PARTNER</div>
                </div>
                <div class="ps-stat-card">
                    <div class="ps-stat-val" style="font-size: 0.85rem; color: var(--text);">${rivalDisplay}</div>
                    <div class="ps-stat-label">CAREER RIVAL</div>
                </div>
            </div>
        </div>

        <div class="ps-section">
            <div class="ps-section-header">🏆 TROPHY ROOM</div>
            <div id="psAchievements" class="ps-achievements-list">
                <div class="sl-searching"><div class="sl-searching-spinner"></div></div>
            </div>
        </div>

        <div class="ps-actions">
            <button class="btn-main ps-btn-sub" onclick="passportRename()">✏️ Edit Name</button>
            <button class="btn-main ps-btn-sub" onclick="PlayerMode.pickSpiritAnimal()">🐾 Spirit Animal</button>
                        <button class="btn-main ps-btn-sub" style="grid-column: span 2; background:rgba(0, 255, 163, 0.1) !important; color:var(--accent) !important; border: 1px solid var(--border-accent) !important;" onclick="generateRecoveryCard()">💾 Download Backup Card</button>
        </div>
    `;

    // Show local trophies immediately
    renderTrophies(p.achievements || []);
};

window.goToPlayerMode = function() {
    window.location.href = '?role=player';
};
function _startHostTimerTick() {
    if (window._hostTickTimer) clearInterval(window._hostHostTickTimer);
    window._hostTickTimer = setInterval(() => {
        const matches = StateStore.currentMatches || [];
        matches.forEach((m, i) => {
            if (!m.startedAt || m.winnerTeamIndex !== null) return;
            const el = document.getElementById(`timer-${i}`);
            if (!el) return;
            
            const elapsed = Math.floor((Date.now() - m.startedAt) / 1000);
            const min = Math.floor(elapsed / 60);
            const sec = elapsed % 60;
            el.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
            
            // Use the same CSS classes defined for the court-timer
            el.classList.toggle('timer-warn', min >= 10);
            el.classList.toggle('timer-alert', min >= 15);
        });
    }, 1000);
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

    if (typeof _installPassportIWTPOverride === 'function') {
        _installPassportIWTPOverride();
    }

    // ── PLAYER MODE BOOT ─────────────────────────────────────────────────────
    const urlParams = new URLSearchParams(window.location.search);
    const joinCode = urlParams.get('join');
    const role = urlParams.get('role');

    // --- HOST OVERRIDE CHECK ---
    // A host rejoining their own session via an invite link should be treated as a host.
    const savedCode = localStorage.getItem('cs_room_code');
    const savedOpKey = localStorage.getItem('cs_operator_key');
    const isHostOfThisSession = (joinCode && savedCode === joinCode && savedOpKey);

    // If the URL says "player" but we are NOT the host of this specific session, boot into player mode.
    if (role === 'player' && !isHostOfThisSession) {
        document.body.classList.add('player-mode');
        
        // Clean URL immediately
        const cleanUrl = window.location.origin + window.location.pathname + '?role=player';
        window.history.replaceState({}, document.title, cleanUrl);

        if (typeof PlayerMode !== 'undefined') await PlayerMode.boot(passport, joinCode);
        return; // Stop here — do not load host logic
    } else if (isHostOfThisSession) {
        // We are the host, but clicked a player link. Clean the URL and proceed with host boot.
        const cleanUrl = window.location.origin + window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
    }

    try {
        loadFromDisk();
        _startHostTimerTick();
    } catch (e) {
        console.error('[CourtSide] initApp: loadFromDisk failed', e);
    }

    // If the user has a passport from playing, auto-add them to their own squad.
    _autoAddHostToSquad();

    if (typeof tryAutoRejoin === 'function') {
        await tryAutoRejoin().catch(e => console.error('[CourtSide] tryAutoRejoin failed', e));
    }

    // Show landing if no data and not in a session
    if (StateStore.squad.length === 0 && !isOnlineSession && !urlParams.get('join')) {
        showLandingPage();
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

// Global Error Safety Net
window.addEventListener('error', (event) => {
    console.error('[CourtSide Global Error]', event.error);
    // Only show toast if UI is ready
    if (typeof showSessionToast === 'function' && document.body) {
        showSessionToast('⚠️ An error occurred. Please refresh if issues persist.');
    }
});