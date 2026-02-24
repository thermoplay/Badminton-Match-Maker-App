// =============================================================================
// PASSPORT.JS — Private Player Identity System
// =============================================================================
// PRIVACY CONTRACT:
//   - playerUUID and playerName travel over the wire (handshake only)
//   - privateLifetimeWins and privateTotalGames NEVER leave this device
//   - All passport data lives exclusively in localStorage
// =============================================================================

const PASSPORT_KEY = 'cs_player_passport';

const Passport = {

    // ── Read / Write ──────────────────────────────────────────────────────────

    get() {
        try {
            const raw = localStorage.getItem(PASSPORT_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    },

    save(data) {
        try { localStorage.setItem(PASSPORT_KEY, JSON.stringify(data)); } catch { /* storage full */ }
    },

    /**
     * Create a new passport if one doesn't already exist.
     * Returns the passport (existing or newly created).
     */
    init(name = null) {
        let passport = this.get();
        if (!passport) {
            passport = {
                playerUUID:           this._uuid(),
                playerName:           name || '',
                privateLifetimeWins:  0,
                privateTotalGames:    0,
                createdAt:            Date.now(),
            };
            this.save(passport);
        }
        return passport;
    },

    /**
     * Returns only the fields safe to share with the host/session.
     * NEVER includes private stats.
     */
    publicProfile() {
        const p = this.get();
        if (!p) return null;
        return { playerUUID: p.playerUUID, playerName: p.playerName };
    },

    /**
     * Rename — updates name without touching UUID or private stats.
     */
    rename(newName) {
        const p = this.get();
        if (!p) return;
        p.playerName = newName.trim();
        this.save(p);
        return p;
    },

    /**
     * Record a win — increments both games and wins locally.
     * Called only when the host broadcasts a win signal addressed to this UUID.
     */
    recordWin() {
        const p = this.get();
        if (!p) return;
        p.privateLifetimeWins++;
        p.privateTotalGames++;
        this.save(p);
        return p;
    },

    /**
     * Record a loss — increments only games.
     */
    recordLoss() {
        const p = this.get();
        if (!p) return;
        p.privateTotalGames++;
        this.save(p);
        return p;
    },

    /**
     * Win rate as a percentage string, e.g. "67%"
     */
    winRate() {
        const p = this.get();
        if (!p || p.privateTotalGames === 0) return '—';
        return Math.round((p.privateLifetimeWins / p.privateTotalGames) * 100) + '%';
    },

    // ── UUID Generator ────────────────────────────────────────────────────────

    _uuid() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        // Fallback for older browsers
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    },
};

// =============================================================================
// SIDELINE VIEW — Player's private mobile dashboard
// =============================================================================

const SidelineView = {

    _visible: false,

    /**
     * Show the sideline panel for a player who has their passport set.
     */
    show() {
        this._visible = true;
        const panel = document.getElementById('sidelinePanel');
        if (panel) {
            panel.style.display = 'flex';
            this.refresh();
        }
    },

    hide() {
        this._visible = false;
        const panel = document.getElementById('sidelinePanel');
        if (panel) panel.style.display = 'none';
    },

    /**
     * Refresh all data in the sideline view.
     * Called whenever remote state updates.
     */
    refresh() {
        if (!this._visible) return;
        const passport = Passport.get();
        if (!passport) return;

        // Player name + rename button
        const nameEl = document.getElementById('slPassportName');
        if (nameEl) nameEl.textContent = passport.playerName;

        // Private stats
        const winsEl  = document.getElementById('slPrivateWins');
        const gamesEl = document.getElementById('slPrivateGames');
        const wrEl    = document.getElementById('slPrivateWR');
        if (winsEl)  winsEl.textContent  = passport.privateLifetimeWins;
        if (gamesEl) gamesEl.textContent = passport.privateTotalGames;
        if (wrEl)    wrEl.textContent    = Passport.winRate();

        // Current matches
        this._renderMatches();

        // Next up ticker
        this._renderNextUp();
    },

    _renderMatches() {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;

        if (!window.currentMatches || currentMatches.length === 0) {
            container.innerHTML = `<div class="sl-empty">No active matches yet</div>`;
            return;
        }

        const passport = Passport.get();
        const myName   = passport?.playerName?.toLowerCase() || '';

        container.innerHTML = currentMatches.map((m, i) => {
            const tA      = m.teams[0] || [];
            const tB      = m.teams[1] || [];
            const allNames = [...tA, ...tB].map(n => n.toLowerCase());
            const playing  = myName && allNames.includes(myName);

            return `
                <div class="sl-match-card ${playing ? 'sl-match-mine' : ''}">
                    <div class="sl-match-label">
                        GAME ${i + 1}${playing ? ' · <span class="sl-you-badge">YOU</span>' : ''}
                    </div>
                    <div class="sl-match-teams">
                        <span class="sl-team">${tA.join(' &amp; ')}</span>
                        <span class="sl-vs">VS</span>
                        <span class="sl-team">${tB.join(' &amp; ')}</span>
                    </div>
                </div>
            `;
        }).join('');
    },

    _renderNextUp() {
        const el = document.getElementById('slNextUp');
        if (!el) return;
        const ticker = document.getElementById('nextUpNames');
        if (ticker && ticker.textContent) {
            el.textContent = ticker.textContent;
            el.parentElement.style.display = 'block';
        } else {
            el.parentElement.style.display = 'none';
        }
    },
};

// =============================================================================
// VICTORY CARD — shown on winner's device when host marks a match complete
// =============================================================================

const VictoryCard = {

    show(playerName) {
        const overlay = document.getElementById('victoryCardOverlay');
        const nameEl  = document.getElementById('victoryCardName');
        if (!overlay || !nameEl) return;

        nameEl.textContent = playerName.toUpperCase();
        overlay.style.display = 'flex';

        // Trigger entrance animation
        requestAnimationFrame(() => {
            overlay.classList.add('victory-visible');
        });

        // Haptic + confetti
        if (window.Haptic)  Haptic.success();
        if (window.Confetti) Confetti.burst(window.innerWidth / 2, window.innerHeight / 2, 120);
    },

    hide() {
        const overlay = document.getElementById('victoryCardOverlay');
        if (!overlay) return;
        overlay.classList.remove('victory-visible');
        setTimeout(() => { overlay.style.display = 'none'; }, 400);
    },

    async share() {
        const card = document.getElementById('victoryCard');
        if (!card) return;

        // Lazy-load html2canvas if not already present
        if (!window.html2canvas) {
            await new Promise((res, rej) => {
                const s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
                s.onload = res; s.onerror = rej;
                document.head.appendChild(s);
            });
        }

        try {
            const canvas = await html2canvas(card, {
                backgroundColor: '#0a0a0f',
                scale:   2,
                width:   390,
                height:  693,
                useCORS: true,
                logging: false,
            });

            canvas.toBlob(async (blob) => {
                const file = new File([blob], 'courtside-victory.png', { type: 'image/png' });
                const passport = Passport.get();
                const name     = passport?.playerName || 'Player';

                if (navigator.share && navigator.canShare({ files: [file] })) {
                    await navigator.share({
                        title: 'The Court Side Pro',
                        text:  `${name} just won! 🏆 #TheCourtsidePro`,
                        files: [file],
                    });
                } else {
                    // Fallback: download
                    const a    = document.createElement('a');
                    a.href     = URL.createObjectURL(blob);
                    a.download = 'courtside-victory.png';
                    a.click();
                }
                if (window.Haptic) Haptic.success();
            }, 'image/png');
        } catch (e) {
            console.error('Victory share failed:', e);
        }
    },
};

// =============================================================================
// PLAYER MODE — boot controller for ?role=player
// =============================================================================

const PlayerMode = {

    _joinCode: null,
    _pollTimer: null,

    /**
     * Entry point. Called from the boot script when role=player is detected.
     * @param {object} passport  — existing or newly created passport
     * @param {string} joinCode  — room code from ?join= param, or null
     */
    async boot(passport, joinCode) {
        this._joinCode = joinCode;

        // Populate identity fields immediately from localStorage
        this._renderIdentity(passport);
        this._renderStats(passport);

        // Tag session code in the top pill
        const codeEl = document.getElementById('slSessionCode');
        if (codeEl && joinCode) codeEl.textContent = joinCode;

        if (joinCode) {
            // Auto-join the session as a player
            await this._joinSession(passport, joinCode);
        } else {
            // No room code — prompt for one
            this._promptForCode(passport);
        }
    },

    // ── Private helpers ─────────────────────────────────────────────────────

    _renderIdentity(passport) {
        const nameEl   = document.getElementById('slPassportName');
        const avatarEl = document.getElementById('slPassportAvatar');
        if (nameEl)   nameEl.textContent   = passport.playerName || 'Tap to set name';
        if (avatarEl) avatarEl.textContent = (passport.playerName || '?').charAt(0).toUpperCase();
    },

    _renderStats(passport) {
        const wins  = document.getElementById('slPrivateWins');
        const games = document.getElementById('slPrivateGames');
        const wr    = document.getElementById('slPrivateWR');
        if (wins)  wins.textContent  = passport.privateLifetimeWins  || 0;
        if (games) games.textContent = passport.privateTotalGames     || 0;
        if (wr)    wr.textContent    = Passport.winRate()             || '—';
    },

    setStatus(state, text, sub) {
        const card   = document.getElementById('slStatusCard');
        const icon   = document.getElementById('slStatusIcon');
        const textEl = document.getElementById('slStatusText');
        const subEl  = document.getElementById('slStatusSub');

        const icons = {
            pending:  '⏳',
            'on-deck':'🟡',
            playing:  '🟢',
            resting:  '🔵',
            approved: '✅',
        };

        if (card)   card.dataset.state   = state;
        if (icon)   icon.textContent     = icons[state] || '⏳';
        if (textEl) textEl.textContent   = text;
        if (subEl)  subEl.textContent    = sub || '';
    },

    async _joinSession(passport, joinCode) {
        this.setStatus('pending', 'Joining session…', 'Connecting to ' + joinCode);

        try {
            // Use the existing sync.js joinOnlineSession which handles Supabase
            if (typeof joinOnlineSession === 'function') {
                await joinOnlineSession(joinCode);
            }

            // If passport has no name yet, ask for one before requesting
            let name = passport.playerName;
            if (!name) {
                name = await this._promptName();
                if (!name) return;
                Passport.rename(name);
                this._renderIdentity(Passport.get());
            }

            // Send join request to host with UUID
            const res = await fetch('/api/play-request', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    room_code:   joinCode,
                    name:        name,
                    player_uuid: passport.playerUUID,
                }),
            });

            if (res.ok) {
                this.setStatus('pending',
                    'Request sent!',
                    'Waiting for host to approve you…'
                );
                // Start polling for win signals + state updates
                this._startPolling(joinCode, passport);
            } else {
                this.setStatus('pending', 'Could not join', 'Check the room code and try again');
            }
        } catch(e) {
            this.setStatus('pending', 'Connection failed', 'Make sure you have internet access');
            console.error('[PlayerMode] join failed:', e);
        }
    },

    _startPolling(joinCode, passport) {
        clearInterval(this._pollTimer);

        this._pollTimer = setInterval(async () => {
            // 1. Refresh match state
            if (typeof SidelineView !== 'undefined') SidelineView.refresh();
            this._updateOnDeckStatus(passport);

            // 2. Check for win/loss signal
            try {
                const r = await fetch(
                    `/api/passport-signal?player_uuid=${encodeURIComponent(passport.playerUUID)}&room_code=${encodeURIComponent(joinCode)}`
                );
                const d = await r.json();
                if (d.signal) {
                    await this._handleSignal(d.signal, passport, joinCode);
                }
            } catch { /* silent */ }
        }, 6000);
    },

    _updateOnDeckStatus(passport) {
        if (!window.currentMatches || !window.squad) return;
        const name    = passport.playerName?.toLowerCase();
        const playing = window.currentMatches?.some(m =>
            [...(m.teams[0]||[]), ...(m.teams[1]||[])].map(n=>n.toLowerCase()).includes(name)
        );

        // Check if in squad (approved)
        const inSquad = window.squad?.some(p => p.name?.toLowerCase() === name);

        // Check Next Up ticker
        const tickerEl = document.getElementById('nextUpNames');
        const nextUp   = tickerEl?.textContent || '';
        const isNext   = name && nextUp.toLowerCase().includes(name);

        if (playing) {
            this.setStatus('playing', 'You\'re on court!', 'Playing now — give it everything');
        } else if (isNext) {
            this.setStatus('on-deck', 'You\'re on deck!', 'Get ready — you\'re up next');
        } else if (inSquad) {
            this.setStatus('resting', 'Resting this round', 'Sit tight, your turn is coming');
        }
        // else stay as pending/last status
    },

    async _handleSignal(signal, passport, joinCode) {
        if (signal.event === 'WIN') {
            Passport.recordWin();
            this._renderStats(Passport.get());
            VictoryCard.show(passport.playerName);
        } else if (signal.event === 'LOSS') {
            Passport.recordLoss();
            this._renderStats(Passport.get());
        }
        // Acknowledge
        await fetch('/api/passport-signal', {
            method:  'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ player_uuid: passport.playerUUID, room_code: joinCode }),
        }).catch(() => {});
    },

    _promptName() {
        return new Promise(resolve => {
            const name = prompt('Enter your name to join:');
            resolve(name ? name.trim() : null);
        });
    },

    _promptForCode(passport) {
        this.setStatus('pending', 'No room code', 'Ask the host for the QR code or room code');
        // Optionally show an inline input for manual code entry
        const matchesEl = document.getElementById('slCurrentMatches');
        if (matchesEl) {
            matchesEl.innerHTML = `
                <div class="sl-code-entry">
                    <div class="sl-code-label">Enter Room Code</div>
                    <input id="slCodeInput" class="sl-code-input" placeholder="XXXX-XXXX"
                        autocomplete="off" autocapitalize="characters" maxlength="9">
                    <button class="sl-code-btn" onclick="PlayerMode._manualJoin()">Join →</button>
                </div>
            `;
        }
    },

    async _manualJoin() {
        const input = document.getElementById('slCodeInput');
        const code  = (input?.value || '').trim().toUpperCase();
        if (!code) return;
        const passport = Passport.get();
        // Restore matches area
        const matchesEl = document.getElementById('slCurrentMatches');
        if (matchesEl) matchesEl.innerHTML = '<div class="sl-empty">Connecting…</div>';
        await this._joinSession(passport, code);
    },
};