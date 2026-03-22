// =============================================================================
// PLAYER-VIEW.JS — Player-facing UI and Controller
// =============================================================================
// Responsibilities:
//   - Manages the entire player experience when `?role=player`.
//   - Handles joining, name entry, polling, and real-time updates.
//   - Renders the sideline view UI (matches, status, profile).
// =============================================================================

// Depends on: passport.js (for Passport object)
//             share-card.js (for slShareMatch function)

// =============================================================================
// SIDELINE VIEW
// =============================================================================

const SidelineView = {
    _visible: false,
    _currentTab: 'live',

    show() {
        this._visible = true;
        const panel = document.getElementById('sidelinePanel');
        if (panel) { 
            panel.style.display = 'flex';
            panel.style.flexDirection = 'column'; 
            this._initPullToRefresh();
            this.refresh(); 
        }
    },

    hide() {
        this._visible = false;
        const panel = document.getElementById('sidelinePanel');
        if (panel) panel.style.display = 'none';
    },

    switchTab(tab) {
        this._currentTab = tab;
        document.querySelectorAll('.sl-tab').forEach(b => b.classList.toggle('active', b.textContent.toLowerCase().includes(tab)));
        document.getElementById('slViewLive').style.display = tab === 'live' ? 'block' : 'none';
        document.getElementById('slViewProfile').style.display = tab === 'profile' ? 'block' : 'none';
        if (tab === 'profile') this._renderProfile();
    },

    refresh() {
        if (!this._visible) return;
        const passport = Passport.get();
        if (!passport) return;

        const nameEl = document.getElementById('slPassportName');
        if (nameEl) nameEl.textContent = passport.playerName;

        this._renderMatches();
        this._renderNextUp();
        this._renderLastWinner();
        if (this._currentTab === 'profile') this._renderProfile();
    },

    _renderMatches() {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;

        // Guard: don't overwrite queued-state or name-entry UI during join flow
        if (container.querySelector('.sl-queued-state') ||
            container.querySelector('.sl-name-entry')) return;

        const matches = window.currentMatches || [];
        if (matches.length === 0) {
            container.innerHTML = `<div class="sl-empty">No active round yet</div>`;
            return;
        }
        const passport = Passport.get();
        const myName   = passport?.playerName?.toLowerCase() || '';

        container.innerHTML = matches.map((m, i) => {
            const teams   = m.teams || [];
            const tA      = teams[0] || [];
            const tB      = teams[1] || [];
            const playing = myName && [...tA, ...tB].map(n => n.toLowerCase()).includes(myName);
            const odds    = (m.odds && m.odds.length === 2) ? m.odds : [50, 50];
            const winIdx  = m.winnerTeamIndex;
            const hasWinner = winIdx !== null && winIdx !== undefined;

            // Timer is handled by the global TimerManager in timer.js
            // It reads the `data-started` attribute from the DOM.
            let timerHTML = '';
            if (m.startedAt) {
                const diff = Math.max(0, Date.now() - m.startedAt);
                const mm = Math.floor(diff / 60000);
                const ss = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
                timerHTML = `<span class="sl-court-timer">⏱ ${mm}:${ss}</span>`;
            }

            // Winner banner
            const winnerBanner = hasWinner
                ? `<div class="sl-winner-banner">🏆 ${(teams[winIdx] || []).join(' & ')} won</div>`
                : '';

            // Team styling
            const aClass = hasWinner ? (winIdx === 0 ? 'sl-team sl-team-won' : 'sl-team sl-team-lost') : 'sl-team';
            const bClass = hasWinner ? (winIdx === 1 ? 'sl-team sl-team-won' : 'sl-team sl-team-lost') : 'sl-team';

            const esc = (s) => (typeof escapeHTML === 'function' ? escapeHTML(s) : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
            const safeNames = (arr) => arr.map(n => esc(n)).join(' &amp; ');

            return `
                <div class="sl-match-card ${playing ? 'sl-match-mine' : ''} ${hasWinner ? 'sl-match-decided' : ''}" data-started="${m.startedAt || ''}">
                    <div class="sl-match-header">
                        <div class="sl-match-label">COURT ${i + 1}${playing ? ' · <span class="sl-you-badge">YOU</span>' : ''}</div>
                        ${(odds[0] !== 50 || odds[1] !== 50) ? `
                            <div style="display:flex;gap:4px;">
                                <span class="sl-odds-pill ${odds[0] > odds[1] ? 'sl-odds-fav' : ''}">${odds[0]}%</span>
                                <span class="sl-odds-pill ${odds[1] > odds[0] ? 'sl-odds-fav' : ''}">${odds[1]}%</span>
                            </div>`
                        : ''}
                        ${timerHTML}
                    </div>
                    <div class="sl-match-teams">
                        <div class="sl-team-col">
                            <span class="${aClass}">${safeNames(tA)}</span>
                        </div>
                        <span class="sl-vs">VS</span>
                        <div class="sl-team-col">
                            <span class="${bClass}">${safeNames(tB)}</span>
                        </div>
                    </div>
                    ${winnerBanner}
                    ${playing && !hasWinner ? `
                    <button class="sl-share-match-btn" onclick="slShareMatch(${i})">
                        📲 Share this matchup
                    </button>` : ''}
                </div>`;
        }).join('');
    },

    _renderNextUp() {
        const el    = document.getElementById('slNextUp');
        const rowEl = document.getElementById('slNextUpRow');
        if (!el || !rowEl) return;
        const text = window._lastNextUp || '';
        if (!text) { rowEl.style.display = 'none'; return; }

        // Parse names and render with avatars if Avatar is available
        if (window.Avatar) {
            const esc = (s) => (typeof escapeHTML === 'function' ? escapeHTML(s) : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
            const names = text.split(/\s*[,&]\s*/).map(n => n.trim()).filter(Boolean);
            el.innerHTML = names.map(name =>
                `<span class="sl-next-avatar-chip">
                    <span class="sl-next-avatar" style="background:${Avatar.color(name)}">${esc(Avatar.initials(name))}</span>
                    <span class="sl-next-name">${esc(name)}</span>
                </span>`
            ).join('<span class="sl-next-sep">·</span>');
        } else {
            el.textContent = text;
        }
        rowEl.style.display = 'flex';
    },

    _renderLastWinner() {
        const el    = document.getElementById('slLastWinner');
        const rowEl = document.getElementById('slLastWinnerRow');
        if (!el || !rowEl) return;
        if (window._lastMatchWinner) {
            el.textContent      = window._lastMatchWinner;
            rowEl.style.display = 'flex';
        } else {
            rowEl.style.display = 'none';
        }
    },

    _renderProfile() {
        const passport = Passport.get();
        if (!passport) return;
        const me = (window.squad || []).find(p => p.uuid === passport.playerUUID);

        // Render Header
        const nameEl = document.getElementById('slProfileName');
        const avatarEl = document.getElementById('slProfileAvatar');
        const statsEl = document.getElementById('slProfileStats');

        if (nameEl) nameEl.textContent = passport.playerName;
        if (avatarEl) {
             avatarEl.textContent = passport.playerName.charAt(0).toUpperCase();
             if (window.Avatar) avatarEl.style.background = Avatar.color(passport.playerName);
        }
        
        // Hide legacy text stats if present
        if (statsEl) statsEl.style.display = 'none';

        // Render Stats Deck (Session + Career)
        const profileView = document.getElementById('slViewProfile');
        let deck = document.getElementById('slStatsDeck');
        
        if (!deck && profileView) {
            deck = document.createElement('div');
            deck.id = 'slStatsDeck';
            // Insert before achievements container
            const ach = document.getElementById('slProfileAchievements');
            if (ach) profileView.insertBefore(deck, ach);
            else profileView.appendChild(deck);
        }

        if (deck) {
            const career = passport.stats || { wins: 0, games: 0 };
            const cWr = career.games > 0 ? Math.round((career.wins / career.games) * 100) : 0;
            
            let sWins = 0, sGames = 0, sWr = 0;
            if (me) {
                sWins = me.wins;
                sGames = me.games;
                sWr = sGames > 0 ? Math.round((sWins / sGames) * 100) : 0;
            }

            deck.innerHTML = `
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
                        </div>` : `<div class="sl-card-empty">Not in a session</div>`}
                    </div>

                    <div class="sl-stat-card">
                        <div class="sl-card-label">CAREER RECORD</div>
                        <div class="sl-card-grid">
                            <div class="sl-card-item">
                                <div class="sl-card-val">${career.wins}</div>
                                <div class="sl-card-key">WINS</div>
                            </div>
                            <div class="sl-card-item">
                                <div class="sl-card-val">${career.games}</div>
                                <div class="sl-card-key">GAMES</div>
                            </div>
                            <div class="sl-card-item">
                                <div class="sl-card-val">${cWr}%</div>
                                <div class="sl-card-key">WIN RATE</div>
                            </div>
                        </div>
                    </div>
                </div>`;
        }

        // Render Achievements List
        const container = document.getElementById('slProfileAchievements');
        if (container && window.Achievements) {
            const myAch = me ? (me.achievements || []) : [];
            const html = Object.keys(window.Achievements).map(key => {
                const def = window.Achievements[key];
                const unlocked = myAch.includes(key);
                return `
                    <div class="sl-ach-item ${unlocked ? 'unlocked' : 'locked'}">
                        <div class="sl-ach-icon">${def.icon}</div>
                        <div class="sl-ach-text">
                            <div class="sl-ach-title">${def.name}</div>
                            <div class="sl-ach-desc">${def.description}</div>
                        </div>
                    </div>
                `;
            }).join('');
            container.innerHTML = html;
        }

        // Add Leave Session button to the profile view
        if (profileView && !profileView.querySelector('.sl-session-actions')) {
            const actionsEl = document.createElement('div');
            actionsEl.className = 'sl-session-actions';
            
            const supportSection = document.createElement('div');
            supportSection.className = 'sl-support-section';
            supportSection.style.marginTop = '24px';

            const leaveBtn = document.createElement('button');
            leaveBtn.className = 'sl-leave-btn';
            leaveBtn.textContent = 'Leave Session';
            leaveBtn.onclick = () => PlayerMode.leaveSession(); // Direct binding fixes scope issue

            const hint = document.createElement('p');
            hint.className = 'sl-leave-hint';
            hint.textContent = 'You will be removed from the rotation. You can rejoin later.';

            supportSection.appendChild(leaveBtn);
            supportSection.appendChild(hint);
            actionsEl.appendChild(supportSection);
            profileView.appendChild(actionsEl);
        }
    },

    _initPullToRefresh() {
        const panel = document.getElementById('sidelinePanel');
        if (!panel || panel._ptrInit) return;
        panel._ptrInit = true;

        const indicator = document.createElement('div');
        indicator.className = 'sl-ptr-indicator';
        indicator.innerHTML = '<div class="sl-ptr-icon">⇣</div>';
        panel.insertBefore(indicator, panel.firstChild);

        let startY = 0;
        let isPulling = false;
        let hasVibrated = false;
        const THRESHOLD = 80;

        const reset = () => {
            isPulling = false;
            indicator.style.transition = 'height 0.3s cubic-bezier(0.22, 1, 0.36, 1)';
            indicator.style.height = '0px';
            setTimeout(() => {
                indicator.style.transition = '';
                indicator.innerHTML = '<div class="sl-ptr-icon">⇣</div>';
            }, 300);
        };

        panel.addEventListener('touchstart', (e) => {
            if (panel.scrollTop <= 0) {
                startY = e.touches[0].clientY;
                hasVibrated = false;
            }
        }, { passive: true });

        panel.addEventListener('touchmove', (e) => {
            const y = e.touches[0].clientY;
            const delta = y - startY;

            if (panel.scrollTop <= 0 && delta > 0) {
                isPulling = true;
                // Resistance curve
                const pullHeight = Math.min(delta * 0.4, 140); 
                
                if (e.cancelable) e.preventDefault();

                indicator.style.height = `${pullHeight}px`;
                
                if (pullHeight > THRESHOLD && !hasVibrated) {
                    if (window.Haptic) Haptic.tap();
                    hasVibrated = true;
                } else if (pullHeight < THRESHOLD && hasVibrated) {
                    hasVibrated = false;
                }

                const icon = indicator.querySelector('.sl-ptr-icon');
                if (icon) {
                    icon.style.transform = pullHeight > THRESHOLD ? 'rotate(180deg)' : 'rotate(0deg)';
                    icon.style.opacity = Math.min(pullHeight / 40, 1);
                }
            } else {
                isPulling = false;
            }
        }, { passive: false });

        panel.addEventListener('touchend', async () => {
            if (!isPulling) return;
            const currentHeight = parseInt(indicator.style.height || '0', 10);

            if (currentHeight > THRESHOLD) {
                indicator.style.transition = 'height 0.2s ease';
                indicator.style.height = '50px';
                indicator.innerHTML = '<div class="sl-ptr-spinner"></div>';
                
                if (window.Haptic) Haptic.tap();
                await this._performRefresh();
                if (window.Haptic) Haptic.success();
                
                reset();
            } else {
                reset();
            }
        });
    },

    async _performRefresh() {
        const code = window.currentRoomCode || localStorage.getItem('cs_player_room_code');
        if (!code) return;
        try {
            const res = await fetch(`/api/session-get?code=${encodeURIComponent(code)}`);
            if (res.ok) {
                const data = await res.json();
                if (data.session && typeof applyRemoteState === 'function') {
                    applyRemoteState(data.session);
                }
            }
        } catch (e) { console.error('Refresh failed', e); }
    },
};

// =============================================================================
// VICTORY CARD — stubbed out
// =============================================================================

const VictoryCard = { show() {}, hide() {}, share() {} };

// =============================================================================
// PLAYER MODE — boot controller for ?role=player  v6
// =============================================================================

const LS_TOKENS   = 'cs_session_tokens';
const SS_APPROVED = 'cs_approved';

const PlayerMode = {

    _joinCode:  null,
    _pollTimer: null,

    leaveSession() {
        const doLeave = () => {
            const passport = Passport.get();
            
            // Recover code if missing (e.g. after reload) so we can leave properly
            if (!this._joinCode) {
                this._joinCode = localStorage.getItem('cs_player_room_code');
            }

            // 1. Notify host that we are leaving
            if (passport && this._joinCode) {
            // The correct pattern is to broadcast our intent to leave. The host
            // receives this broadcast and performs a secure, authenticated removal
            // of the player from the session. We no longer make a direct,
            // unauthenticated API call to delete the session_members row.
            try {
                if (typeof window.broadcastPlayerLeaving === 'function') {
                    window.broadcastPlayerLeaving(passport.playerUUID, passport.playerName);
                }
            } catch (e) {
                console.error('[CourtSide] Failed to broadcast leaving event. Leaving locally anyway.', e);
            }
            }

            // 2. Clean up local state
            clearInterval(this._pollTimer);
            localStorage.removeItem('cs_player_room_code');
            try { sessionStorage.removeItem(SS_APPROVED); } catch {}

            // 3. Reset UI by reloading. Give broadcast a moment to send.
            if (typeof showSessionToast === 'function') showSessionToast('👋 You have left the session.');
            setTimeout(() => { window.location.href = window.location.origin + window.location.pathname; }, 500);
        };

        try {
            if (typeof window.UIManager !== 'undefined') {
                UIManager.confirm({
                    title: 'Leave Session?',
                    message: 'You will be removed from the rotation. You can rejoin later.',
                    confirmText: 'Yes, Leave',
                    isDestructive: true,
                    onConfirm: doLeave
                });
            } else {
                if (confirm('Are you sure you want to leave this session? You will be removed from the rotation.')) {
                    doLeave();
                }
            }
        } catch (e) {
            if (confirm('Are you sure you want to leave this session? You will be removed from the rotation.')) {
                doLeave();
            }
        }
    },

    _onRemovedFromSession() {
        clearInterval(this._pollTimer);
        localStorage.removeItem('cs_player_room_code');
        try { sessionStorage.removeItem(SS_APPROVED); } catch {}

        if (typeof showSessionToast === 'function') {
            showSessionToast('You have been removed from the session.');
        }
        setTimeout(() => { window.location.href = window.location.origin + window.location.pathname; }, 2000);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // BOOT
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Initializes the player view, handling everything from joining a room
     * to subscribing to live updates.
     */
    async boot(passport, joinCode) {
        // 1. Determine room code from URL param or localStorage
        if (!joinCode) {
            try { joinCode = localStorage.getItem('cs_player_room_code') || null; } catch {}
        }
        this._joinCode = joinCode;

        // 2. Initial UI setup
        this._bootUI(passport, joinCode);

        // 3. If no code, prompt user to enter one and stop.
        if (!joinCode) {
            this._promptForCode();
            return;
        }

        // 4. Handle name entry if the player is new
        const hasName = !!(passport.playerName && passport.playerName.trim());
        if (!hasName) {
            const name = await this._handleNewPlayerName();
            if (!name) return; // Player cancelled name entry
            passport = Passport.get(); // Re-fetch passport with new name
        } else {
            this._showWelcomeBack(passport.playerName, joinCode);
            this.setStatus('pending', `Welcome back, ${passport.playerName}`, 'Joining court…');
        }

        // 5. Core join and sync logic
        await this._joinAndSync(passport, joinCode);
    },

    /** Sets up the initial UI elements during boot. */
    _bootUI(passport, joinCode) {
        const panel = document.getElementById('sidelinePanel');
        if (panel) panel.classList.add('sl-booting');

        this._renderIdentity(passport);

        const codeEl = document.getElementById('slSessionCode');
        if (codeEl && joinCode) codeEl.textContent = joinCode;

        if (joinCode) {
            try { localStorage.setItem('cs_player_room_code', joinCode); } catch {}
        }
    },

    /** Handles the name entry flow for a new player. */
    async _handleNewPlayerName() {
        this.setStatus('pending', 'Almost there…', 'Enter your name to join');
        this._showNameEntry();
        const name = await this._promptName();
        if (!name) {
            document.getElementById('sidelinePanel')?.classList.remove('sl-booting');
            this._promptForCode();
            return null;
        }
        Passport.rename(name);
        this._renderIdentity(Passport.get());
        this.setStatus('pending', `Hey ${name}!`, 'Connecting to court…');
        return name;
    },

    /** The core logic for connecting to a session and fetching state. */
    async _joinAndSync(passport, joinCode) {
        const panel = document.getElementById('sidelinePanel');

        // Shortcut: If already approved in this browser session, go straight to live view.
        if (this._isApprovedInSession(joinCode)) {
            if (panel) panel.classList.remove('sl-booting');
            this.setStatus('approved', `Welcome back, ${passport.playerName}`, "You're in the rotation");
            this._subscribeAndPoll(joinCode, passport);
            return;
        }
        
        // Start polling and show a loading state.
        this._subscribeAndPoll(joinCode, passport);
        this._showSearchingSpinner();

        // Upsert member record to get current status from DB.
        const upsertResult = await this._memberUpsert(Passport.get(), joinCode).catch(err => {
            console.error('[PlayerMode.boot] member-upsert threw:', err);
            return null;
        });

        panel?.classList.remove('sl-booting');
        this._clearSearchingSpinner();

        // Handle failed session lookup.
        if (!upsertResult) {
            this.setStatus('pending', 'Court not found', 'The session may have ended. Check the room code.');
            console.error('[CourtSide] Session lookup failed for room:', joinCode);
            this._promptForCode();
            return;
        }

        // Seamless Reconnect: If DB says we're 'active', we are already in the session.
        // Just sync up and enter. Don't force a new request.
        if (upsertResult.status === 'active') {
            this._markApprovedInSession(joinCode);
            this._hydrateFromUpsert(upsertResult);
            this.setStatus('approved', `Welcome back, ${Passport.get().playerName}`, "Syncing with court...");
            SidelineView.show();
            // Hydrate the view immediately with session data
            await SidelineView._performRefresh(); 
            setTimeout(() => this._updateStatus(Passport.get()), 500);
            return;
        }

        // Legacy token verification (can likely be removed in the future)
        const savedToken = this._loadToken(joinCode);
        if (savedToken) {
            const valid = await this._verifyToken(joinCode, savedToken, Passport.get());
            if (valid) {
                this._markApprovedInSession(joinCode);
                this.setStatus('approved', `Welcome back, ${Passport.get().playerName}`, "You're in the squad");
                return;
            } else {
                this._clearToken(joinCode);
            }
        }

        // Standard flow: submit a new join request.
        await this._submitJoinRequest(Passport.get(), joinCode);
    },


    // ─────────────────────────────────────────────────────────────────────────
    // QUEUED STATE
    // ─────────────────────────────────────────────────────────────────────────

    _showQueuedState(playerName) {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        container.innerHTML = `
            <div class="sl-queued-state" id="slQueuedBlock">
                <div class="sl-queued-icon">🏀</div>
                <div class="sl-queued-title">REQUEST SENT</div>
                <div class="sl-queued-sub">
                    Waiting for the host to approve you.<br>
                    You'll be added to the rotation automatically.
                </div>
                <button class="sl-queued-resend" id="slResendBtn">Resend Request</button>
                <div class="sl-queued-note">
                    Already approved?
                    <span class="sl-queued-check" id="slCheckBtn">Check now →</span>
                </div>
            </div>`;

        document.getElementById('slResendBtn')?.addEventListener('click', () => PlayerMode._resendRequest());
        document.getElementById('slCheckBtn')?.addEventListener('click',  () => PlayerMode._checkApprovalNow());
    },

    _clearQueuedState() {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        if (container.querySelector('.sl-queued-state')) {
            container.innerHTML = '<div class="sl-empty">No active round yet</div>';
        }
    },

    async _resendRequest() {
        const passport = Passport.get();
        if (!passport || !this._joinCode) return;
        const btn = document.getElementById('slResendBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
        try {
            const res = await fetch('/api/play-request', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    room_code:   this._joinCode,
                    name:        passport.playerName,
                    player_uuid: passport.playerUUID,
                    force:       true, // Force a fresh notification
                }),
            });
            if (res.ok) {
                if (btn) {
                    btn.textContent = '✓ Sent!';
                    setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = 'Resend Request'; } }, 5000);
                }
            } else { throw new Error('non-ok'); }
        } catch {
            if (btn) { btn.disabled = false; btn.textContent = 'Resend Request'; }
        }
    },

    async _checkApprovalNow() {
        const passport = Passport.get();
        if (!passport || !this._joinCode) return;
        const checkEl = document.getElementById('slCheckBtn');
        if (checkEl) { checkEl.textContent = 'Checking…'; checkEl.style.pointerEvents = 'none'; }
        try {
            const result = await this._memberUpsert(passport, this._joinCode);
            if (result && result.status === 'active') {
                this._markApprovedInSession(this._joinCode);
                this._hydrateFromUpsert(result);
                const p = Passport.get();
                this.setStatus('approved', `You're in, ${p.playerName}!`, "You've been approved ✅");
                this._clearQueuedState();
                SidelineView.show();
                if (window.Haptic) Haptic.success();
                setTimeout(() => this._updateStatus(p), 800);
            } else {
                if (checkEl) {
                    checkEl.textContent = 'Still pending…';
                    setTimeout(() => {
                        if (checkEl) { checkEl.textContent = 'Check now →'; checkEl.style.pointerEvents = 'auto'; }
                    }, 3000);
                }
            }
        } catch {
            if (checkEl) { checkEl.textContent = 'Check now →'; checkEl.style.pointerEvents = 'auto'; }
        }
    },

    _showWelcomeBack(playerName, roomCode) {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        container.innerHTML = `
            <div class="sl-welcome-back">
                <div class="sl-welcome-back-icon">🏀</div>
                <div class="sl-welcome-back-text">
                    <div class="sl-welcome-back-name">Welcome back, ${playerName.toUpperCase()}</div>
                    <div class="sl-welcome-back-sub">Joining court ${roomCode}…</div>
                </div>
            </div>`;
    },

    _showNameEntry() {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        container.innerHTML = `
            <div class="sl-name-entry" id="slNameEntryForm">
                <div class="sl-name-entry-title">ENTER YOUR NAME</div>
                <div class="sl-name-entry-sub">
                    The host will approve your request to join the court.
                </div>
                <input
                    type="text"
                    id="slNameEntryInput"
                    class="sl-name-input"
                    placeholder="Your name..."
                    autocomplete="off"
                    autocorrect="off"
                    autocapitalize="words"
                    maxlength="30"
                    inputmode="text"
                >
                <button class="sl-name-submit" id="slNameEntrySubmit">
                    JOIN COURT →
                </button>
                <button class="sl-back-btn" id="slNameEntryCancel" style="margin-top:10px;">
                    Cancel
                </button>
            </div>`;
        setTimeout(() => document.getElementById('slNameEntryInput')?.focus(), 120);
    },

    _showSearchingSpinner() {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        if (container.querySelector('.sl-name-entry')) return;
        container.innerHTML = `
            <div class="sl-searching">
                <div class="sl-searching-spinner"></div>
                <div class="sl-searching-text">SEARCHING FOR COURT…</div>
            </div>`;
    },

    _clearSearchingSpinner() {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        if (container.querySelector('.sl-searching')) {
            container.innerHTML = '<div class="sl-empty">No active round yet</div>';
        }
    },

    async _memberUpsert(passport, joinCode) {
        if (typeof memberUpsert !== 'function') return null;
        return await memberUpsert(passport.playerUUID, passport.playerName, joinCode);
    },

    _hydrateFromUpsert(upsertResult) {
        if (upsertResult?.member?.player_name) {
            const serverName = upsertResult.member.player_name;
            const passport   = Passport.get();
            if (passport && passport.playerName !== serverName) {
                Passport.rename(serverName);
                this._renderIdentity(Passport.get());
            }
        }
    },

    _onApprovalReceived(payload) {
        const passport = Passport.get();
        if (!passport) return;
        if (payload.playerUUID !== passport.playerUUID) return;

        this._markApprovedInSession(this._joinCode);
        if (payload.token) this._saveToken(this._joinCode, payload.token, passport.playerName, passport.playerUUID);

        if (payload.squad)           window.squad          = payload.squad;
        if (payload.current_matches) window.currentMatches = payload.current_matches;

        this._clearQueuedState();

        this.setStatus('approved', `You're in, ${passport.playerName}!`, 'Added to the rotation ✅');

        if (window.Haptic) Haptic.success();
        if (typeof showSessionToast === 'function') {
            showSessionToast("🏀 You're approved! Welcome to the court.");
        }

        SidelineView.show();

        // Self-repair: Fetch achievements locally to ensure they appear even if host sync missed them
        if (window.fetchPlayerAchievements) {
            window.fetchPlayerAchievements(passport.playerUUID).then(achs => {
                const me = (window.squad || []).find(p => p.uuid === passport.playerUUID);
                if (me && achs && achs.length > 0) {
                    const ids = achs.map(a => a.achievement_id);
                    me.achievements = [...new Set([...(me.achievements || []), ...ids])];
                    SidelineView.refresh();
                }
            }).catch(() => {});
        }

        setTimeout(() => this._updateStatus(passport), 800);
    },

    _onGameStateUpdate(payload) {
        const passport = Passport.get();
        if (!passport) return;
        if (payload.next_up) window._lastNextUp = payload.next_up;
        SidelineView.refresh();
        this._updateStatus(passport);
    },

    _onSessionUpdate(session) {
        const passport = Passport.get();
        if (!passport) return;
        const approved = session.approved_players || {};
        const myEntry  = approved[passport.playerUUID] || approved[passport.playerName];
        if (myEntry && !this._isApprovedInSession(this._joinCode)) {
            this._markApprovedInSession(this._joinCode);
            if (myEntry.token) this._saveToken(this._joinCode, myEntry.token, passport.playerName, passport.playerUUID);
            this.setStatus('approved', `You're in, ${passport.playerName}!`, 'Added to the rotation ✅');
            setTimeout(() => this._updateLiveFeed(session, passport), 1500);
            return;
        }
        this._updateLiveFeed(session, passport);
    },

    _updateLiveFeed(session, passport) {
        SidelineView.refresh();
        this._updateStatus(passport);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // MATCH RESOLVED — shows winner banner + haptic only. No stat recording.
    // ─────────────────────────────────────────────────────────────────────────

    _onMatchResolved(payload) {
        const { winnerNames, winnerUUIDs = [], loserUUIDs = [] } = payload;
        const myUUID     = Passport.get()?.playerUUID;
        const isWinner   = myUUID && winnerUUIDs.includes(myUUID);
        const wasInMatch = myUUID && (winnerUUIDs.includes(myUUID) || loserUUIDs.includes(myUUID));

        window._lastMatchWinner = winnerNames ? `🏆 ${winnerNames}` : null;

        SidelineView.show();
        SidelineView.refresh();

        if (wasInMatch && window.Haptic) {
            isWinner ? Haptic.success() : Haptic.bump();
        }

        // Record to permanent Passport history (Career Stats)
        if (wasInMatch && typeof Passport.recordGame === 'function') {
            Passport.recordGame(isWinner);
        }

        // Celebration confetti for the winner
        if (isWinner && typeof Confetti !== 'undefined') {
            Confetti.burst(window.innerWidth / 2, window.innerHeight * 0.4);
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // MATCH RESULT — DB poll fallback. Refreshes live feed only.
    // ─────────────────────────────────────────────────────────────────────────

    _onMatchResult(payload) {
        SidelineView.show();
        SidelineView.refresh();
    },

    _prevStatus: null,

    _updateStatus(passport) {
        const squad   = window.squad          || [];
        const matches = window.currentMatches || [];

        // Prioritize UUID for all lookups to ensure robustness against name changes.
        const me = squad.find(p => p.uuid === passport.playerUUID);
        const myName = me ? me.name : passport.playerName;

        const onCourtNow = new Set(matches.flatMap(m => (m.teams || []).flat()));
        const playing = me ? onCourtNow.has(me.name) : false;
        const inSquad = !!me;

        // The bench is anyone active and not on court.
        const bench = squad.filter(p => p.active && !onCourtNow.has(p.name));
        const qPos  = me ? bench.findIndex(p => p.uuid === me.uuid) : -1;

        const nextUpRaw = window._lastNextUp || '';
        const isNextUp  = myName && nextUpRaw.toLowerCase().includes(myName.toLowerCase());

        // If playing, find specific court and partner details
        let courtInfo = null;
        if (playing) {
            matches.forEach((m, idx) => {
                const teams = m.teams || [];
                const teamA = teams[0] || [];
                const teamB = teams[1] || [];
                const all = [...teamA, ...teamB];
                if (all.some(n => n.toLowerCase() === myName.toLowerCase())) {
                    const myTeam = teamA.some(n => n.toLowerCase() === myName.toLowerCase()) ? teamA : teamB;
                    const partner = myTeam.find(n => n.toLowerCase() !== myName.toLowerCase());
                    courtInfo = { num: idx + 1, partner };
                }
            });
        }

        // Determine new status key before setting UI
        let newStatus = null;
        if (playing)                   newStatus = 'playing';
        else if (isNextUp)             newStatus = 'on-deck';
        else if (inSquad && qPos >= 0) newStatus = 'resting';
        else if (inSquad)              newStatus = 'squad';

        // Fire haptic + banner ONLY on transition INTO 'playing'
        if (newStatus === 'playing' && this._prevStatus !== 'playing') {
            if (window.Haptic) Haptic.success();
            _showYoureUpBanner(courtInfo?.num, courtInfo?.partner);
        }

        // Fire haptic ONLY on transition INTO 'on-deck'
        if (newStatus === 'on-deck' && this._prevStatus !== 'on-deck') {
            if (window.Haptic) Haptic.bump();
        }

        this._prevStatus = newStatus;

        // Update the profile play count badge whenever status refreshes
        _renderPlayCount(passport.playerName);

        if (playing) {
            const subText = courtInfo 
                ? `Court ${courtInfo.num} ${courtInfo.partner ? '• w/ ' + courtInfo.partner : ''}`
                : 'Give it everything 🏀';
            this.setStatus('playing', "You're on court!", subText);
        } else if (isNextUp) {
            this.setStatus('on-deck', "You're on deck!", "Get ready — you're up next 🟡");
        } else if (inSquad && qPos >= 0) {
            const pos = qPos + 1;
            const sfx = pos === 1 ? 'st' : pos === 2 ? 'nd' : pos === 3 ? 'rd' : 'th';
            this.setStatus('resting', `#${pos}${sfx} in line`, `${bench.length} player${bench.length !== 1 ? 's' : ''} on bench`);
        } else if (inSquad) {
            this.setStatus('resting', 'In the squad', 'Waiting for next rotation');
        }
    },

    _onMemberActivated(memberRecord) {
        const passport = Passport.get();
        if (!passport) return;
        if (memberRecord.player_uuid !== passport.playerUUID) return;

        this._markApprovedInSession(this._joinCode);

        if (memberRecord.player_name && memberRecord.player_name !== passport.playerName) {
            Passport.rename(memberRecord.player_name);
            this._renderIdentity(Passport.get());
        }

        this._clearQueuedState();

        const p = Passport.get();
        this.setStatus('approved', `You're in, ${p.playerName}!`, 'Added to the rotation ✅');
        
        // Haptic feedback on host approval
        if (window.Haptic) Haptic.success();

        SidelineView.show();

        // Self-repair: Fetch achievements locally
        if (window.fetchPlayerAchievements) {
            window.fetchPlayerAchievements(passport.playerUUID).then(achs => {
                const me = (window.squad || []).find(p => p.uuid === passport.playerUUID);
                if (me && achs && achs.length > 0) {
                    const ids = achs.map(a => a.achievement_id);
                    me.achievements = [...new Set([...(me.achievements || []), ...ids])];
                    SidelineView.refresh();
                }
            }).catch(() => {});
        }

        setTimeout(() => this._updateStatus(p), 1200);

        if (window.Haptic) Haptic.success();
        if (typeof showSessionToast === 'function') {
            showSessionToast("🏀 You're approved! Welcome to the court.");
        }
    },

    async _submitJoinRequest(passport, joinCode, options = {}) {
        const { force = false, statusMessage, statusSubMessage } = options;

        this.setStatus('pending', statusMessage || 'Request sent!', statusSubMessage || 'Waiting for host to approve… 🏀');
        console.log('[PlayerMode] Joining with UUID:', passport.playerUUID);
        try {
            const res = await fetch('/api/play-request', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    room_code:   joinCode,
                    name:        passport.playerName,
                    player_uuid: passport.playerUUID,
                    force:       force,
                }),
            });

            if (!res.ok) {
                this.setStatus('pending', 'Could not join', 'Check the room code and try again');
                return;
            }

            const data = await res.json();

            if (data.alreadyActive) {
                this._markApprovedInSession(joinCode);
                this.setStatus('approved', `Welcome back, ${passport.playerName}!`, "You're in the squad ✅");
                SidelineView.refresh();
                setTimeout(() => this._updateStatus(passport), 800);
                return;
            }

            this._showQueuedState(passport.playerName);

        } catch(e) {
            this.setStatus('pending', 'Connection failed', 'Check your internet');
            console.error('[PlayerMode] join request failed:', e);
        }
    },

    async _joinSession(passport, joinCode) {
        return this._submitJoinRequest(passport, joinCode);
    },

    _subscribeAndPoll(joinCode, passport) {
        if (joinCode) window.currentRoomCode = joinCode;
        if (typeof joinOnlineSession === 'function') {
            joinOnlineSession(joinCode).catch(() => {});
        }
        this._startSignalPoll(joinCode, passport);
    },

    _startSignalPoll(joinCode, passport) {
        clearInterval(this._pollTimer);
        this._pollTimer = setInterval(() => this._pollSignal(joinCode, passport), 3000);
    },

    async _pollSignal(joinCode, passport) {
        try {
            const r = await fetch(
                `/api/passport-signal?player_uuid=${encodeURIComponent(passport.playerUUID)}&room_code=${encodeURIComponent(joinCode)}`
            );
            const d = await r.json();
            if (d.signal) {
                SidelineView.show();
                SidelineView.refresh();
                await fetch('/api/passport-signal', {
                    method:  'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ player_uuid: passport.playerUUID, room_code: joinCode }),
                }).catch(() => {});
            }
        } catch { /* silent */ }
    },

    _isApprovedInSession(roomCode) {
        try { return !!JSON.parse(sessionStorage.getItem(SS_APPROVED) || '{}')[roomCode]; }
        catch { return false; }
    },

    _markApprovedInSession(roomCode) {
        try {
            const m = JSON.parse(sessionStorage.getItem(SS_APPROVED) || '{}');
            m[roomCode] = true;
            sessionStorage.setItem(SS_APPROVED, JSON.stringify(m));
        } catch { }
    },

    _loadToken(roomCode) {
        try { return JSON.parse(localStorage.getItem(LS_TOKENS) || '{}')[roomCode] || null; }
        catch { return null; }
    },

    _saveToken(roomCode, token, name, uuid) {
        try {
            const m = JSON.parse(localStorage.getItem(LS_TOKENS) || '{}');
            m[roomCode] = { token, name, uuid, savedAt: Date.now() };
            localStorage.setItem(LS_TOKENS, JSON.stringify(m));
        } catch { }
    },

    _clearToken(roomCode) {
        try {
            const m = JSON.parse(localStorage.getItem(LS_TOKENS) || '{}');
            delete m[roomCode];
            localStorage.setItem(LS_TOKENS, JSON.stringify(m));
        } catch { }
    },

    async _verifyToken(roomCode, savedToken, passport) {
        try {
            const res  = await fetch(`/api/session-get?code=${encodeURIComponent(roomCode)}`);
            if (!res.ok) return false;
            const data = await res.json();
            const approved = data?.session?.approved_players || {};
            const entry    = approved[passport.playerUUID] || approved[passport.playerName];
            if (!entry || entry.token !== savedToken.token) return false;
            if (data.session) {
                window.squad            = data.session.squad            || [];
                window.currentMatches   = data.session.current_matches  || [];
                window._sessionUUIDMap  = data.session.uuid_map         || {};
                window._approvedPlayers = data.session.approved_players || {};
            }
            return true;
        } catch { return false; }
    },

    setStatus(state, text, sub) {
        const card   = document.getElementById('slStatusCard');
        const icon   = document.getElementById('slStatusIcon');
        const textEl = document.getElementById('slStatusText');
        const subEl  = document.getElementById('slStatusSub');
        const icons  = { pending:'⏳', 'on-deck':'🟡', playing:'🟢', resting:'🔵', approved:'✅' };
        if (card)   card.dataset.state = state;
        if (icon)   icon.textContent   = icons[state] || '⏳';
        if (textEl) textEl.textContent = text;
        if (subEl)  subEl.textContent  = sub || '';
    },

    _renderIdentity(passport) {
        const nameEl   = document.getElementById('slPassportName');
        const avatarEl = document.getElementById('slPassportAvatar');
        if (nameEl)   nameEl.textContent   = passport.playerName || 'Tap to set name';
        if (avatarEl) {
            avatarEl.textContent = (passport.playerName || '?').charAt(0).toUpperCase();
            // Apply deterministic avatar color from polish.js if available
            if (passport.playerName && window.Avatar) {
                avatarEl.style.background = Avatar.color(passport.playerName);
            }
        }
        // Render play count badge (will be 0 until squad data arrives)
        _renderPlayCount(passport.playerName);
    },

    _joinWithManualCode() {
        const input = document.getElementById('slManualCodeInput');
        const code = input?.value?.trim();
        if (code) {
            PlayerMode.boot(Passport.get(), code);
        }
    },
    _promptForCode() {
        this.setStatus('pending', 'Ready to Join', 'Enter room code to join');
        const el = document.getElementById('slCurrentMatches');
        if (el) el.innerHTML = `
            <div class="sl-code-entry" style="text-align:center; padding: 2rem 1.5rem;">
                <div class="sl-code-label" style="margin-bottom:0.75rem; font-size:0.9rem;">ENTER ROOM CODE</div>
                <input type="text" id="slManualCodeInput" placeholder="ENTER CODE"
                    class="sl-code-input"
                    style="margin-bottom: 0.625rem;"
                    autocomplete="off" autocorrect="off" maxlength="9">
                <button id="slJoinManualCodeBtn" class="sl-code-btn">
                    Join with Code
                </button>
                <button class="sl-back-btn" onclick="window.location.href=window.location.origin + window.location.pathname">
                    ← Back to Host View
                </button>
            </div>`;

        // Attach listeners after rendering the HTML
        document.getElementById('slJoinManualCodeBtn')?.addEventListener('click', () => this._joinWithManualCode());
        document.getElementById('slManualCodeInput')?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') this._joinWithManualCode();
        });
    },
 
    _promptName() {
        return new Promise(resolve => {
            let input = document.getElementById('slNameEntryInput');
            let btn   = document.getElementById('slNameEntrySubmit');
            let cancelBtn = document.getElementById('slNameEntryCancel');

            if (!input || !btn) {
                const container = document.getElementById('slCurrentMatches');
                if (!container) {
                    const n = window.prompt('Enter your name to join:');
                    return resolve(n ? n.trim() : null);
                }
                this._showNameEntry();
                input = document.getElementById('slNameEntryInput');
                btn   = document.getElementById('slNameEntrySubmit');
                cancelBtn = document.getElementById('slNameEntryCancel');
            }

            const submit = () => {
                const val = (input?.value || '').trim();
                if (!val) { input?.focus(); return; }
                if (btn) { btn.disabled = true; btn.textContent = 'JOINING…'; }
                resolve(val);
            };

            btn?.addEventListener('click', submit);
            cancelBtn?.addEventListener('click', () => resolve(null));
            input?.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
            setTimeout(() => input?.focus(), 80);
        });
    },
};
// =============================================================================
// "YOU'RE UP!" BANNER — fires once on transition into playing state
// =============================================================================

function _showYoureUpBanner(courtNum, partnerName) {
    // Remove any existing banner first
    document.getElementById('_csYoureUpBanner')?.remove();

    const banner = document.createElement('div');
    banner.id = '_csYoureUpBanner';
    Object.assign(banner.style, {
        position:        'fixed',
        top:             '0',
        left:            '0',
        right:           '0',
        zIndex:          '99999',
        background:      'linear-gradient(135deg, #00ffa3, #00cc80)',
        color:           '#0a0a0f',
        fontFamily:      '"Inter", sans-serif',
        fontWeight:      '800',
        fontSize:        '1.1rem',
        letterSpacing:   '0.08em',
        textAlign:       'center',
        padding:         '18px 24px 16px',
        boxShadow:       '0 4px 24px rgba(0,255,163,0.5)',
        transform:       'translateY(-100%)',
        transition:      'transform 0.4s cubic-bezier(0.22,1,0.36,1)',
        borderRadius:    '0 0 16px 16px',
    });
    
    const esc = (s) => (typeof escapeHTML === 'function' ? escapeHTML(s) : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
    const safePartner = partnerName ? esc(partnerName) : '';
    banner.innerHTML = `
        <div style="font-size:0.75rem; font-weight:900; letter-spacing:1px; opacity:0.8; margin-bottom:4px;">YOU'RE UP</div>
        <div style="font-size:1.8rem; font-weight:900; line-height:1; margin-bottom:4px; font-style:italic;">COURT ${courtNum || '?'}</div>
        ${safePartner ? `<div style="font-size:0.9rem; font-weight:600;">with ${safePartner}</div>` : ''}
    `;
    document.body.appendChild(banner);

    // Slide in
    requestAnimationFrame(() => {
        requestAnimationFrame(() => { banner.style.transform = 'translateY(0)'; });
    });

    // Slide out after 4s
    const timer = setTimeout(() => {
        banner.style.transform = 'translateY(-100%)';
        setTimeout(() => banner.remove(), 400);
    }, 5000);

    // Tap to dismiss
    banner.addEventListener('click', () => {
        clearTimeout(timer);
        banner.style.transform = 'translateY(-100%)';
        setTimeout(() => banner.remove(), 400);
    });
}

// =============================================================================
// PLAY COUNT BADGE — renders session play count on player profile
// =============================================================================

function _renderPlayCount(playerName) {
    const el = document.getElementById('slPlayCount');
    if (!el) return;
    // Per user request, hide this pill.
    el.style.display = 'none';
}

// Expose globals for other scripts and inline event handlers
window.SidelineView = SidelineView;
window.PlayerMode = PlayerMode;