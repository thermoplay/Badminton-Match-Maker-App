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
