// =============================================================================
// PASSPORT.JS — Private Player Identity System  v5
// =============================================================================
// PRIVACY CONTRACT:
//   - playerUUID and playerName travel over the wire (handshake only)
//   - privateLifetimeWins, privateTotalGames, matchHistory NEVER leave device
//   - localStorage is always written BEFORE any UI re-render
//
// FIVE BUGS / FEATURES:
//   #3  Name sync:       editName → localStorage → broadcast NAME_UPDATE
//   #4  Win tracking:    MATCH_RESOLVED → UUID check → recordWin/recordLoss
//   #NEW Performance Lab: last 5 match results stored in localStorage
//   #NEW Invite QR:      show session QR so players can invite friends
//   #TechVerify UUID:    UUID stored on squad member, survives name changes
// =============================================================================

const PASSPORT_KEY  = 'cs_player_passport';
const MATCH_HIST_KEY = 'cs_match_history';   // [{result, opponent, date, gameLabel}]
const MAX_HIST       = 5;

// =============================================================================
// PASSPORT — localStorage-only identity
// =============================================================================

const Passport = {

    get() {
        try {
            const raw = localStorage.getItem(PASSPORT_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    },

    save(data) {
        try { localStorage.setItem(PASSPORT_KEY, JSON.stringify(data)); } catch { }
    },

    init(name = null) {
        let p = this.get();
        if (!p) {
            p = {
                playerUUID:          this._uuid(),
                playerName:          name || '',
                privateLifetimeWins: 0,
                privateTotalGames:   0,
                createdAt:           Date.now(),
            };
            this.save(p);
        }
        return p;
    },

    publicProfile() {
        const p = this.get();
        if (!p) return null;
        return { playerUUID: p.playerUUID, playerName: p.playerName };
    },

    /** Write localStorage FIRST, caller updates UI after */
    rename(newName) {
        const p = this.get();
        if (!p) return null;
        p.playerName = newName.trim();
        this.save(p);
        return p;
    },

    /** WIN: increment wins AND games. localStorage first. */
    recordWin() {
        const p = this.get();
        if (!p) return null;
        p.privateLifetimeWins++;
        p.privateTotalGames++;
        this.save(p);
        return p;
    },

    /** LOSS: increment games only. localStorage first. */
    recordLoss() {
        const p = this.get();
        if (!p) return null;
        p.privateTotalGames++;
        this.save(p);
        return p;
    },

    winRate() {
        const p = this.get();
        if (!p || p.privateTotalGames === 0) return '—';
        return Math.round((p.privateLifetimeWins / p.privateTotalGames) * 100) + '%';
    },

    _uuid() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    },
};

// =============================================================================
// MATCH HISTORY — localStorage, max 5 entries
// =============================================================================

const MatchHistory = {

    get() {
        try {
            return JSON.parse(localStorage.getItem(MATCH_HIST_KEY) || '[]');
        } catch { return []; }
    },

    /**
     * Add a result entry.
     * @param {'WIN'|'LOSS'} result
     * @param {string}       opponentNames  — e.g. "Alice & Bob"
     * @param {string}       gameLabel      — e.g. "Game 1"
     */
    push(result, opponentNames, gameLabel) {
        const hist = this.get();
        hist.unshift({
            result,
            opponents: opponentNames || 'Unknown',
            gameLabel: gameLabel || '',
            date:      Date.now(),
        });
        // Keep only last MAX_HIST entries
        if (hist.length > MAX_HIST) hist.splice(MAX_HIST);
        try { localStorage.setItem(MATCH_HIST_KEY, JSON.stringify(hist)); } catch { }
        return hist;
    },

    clear() {
        try { localStorage.removeItem(MATCH_HIST_KEY); } catch { }
    },

    /** Format a timestamp as "Today 14:32" or "Mon 09:15" */
    _formatDate(ts) {
        const d   = new Date(ts);
        const now = new Date();
        const isToday = d.toDateString() === now.toDateString();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        return isToday ? `Today ${hh}:${mm}` : `${days[d.getDay()]} ${hh}:${mm}`;
    },

    renderList() {
        const hist = this.get();
        if (hist.length === 0) {
            return `<div class="sl-lab-empty">No matches recorded yet.<br>Play a game to start your history.</div>`;
        }
        return hist.map(h => `
            <div class="sl-hist-item sl-hist-${h.result === 'WIN' ? 'win' : 'loss'}">
                <div class="sl-hist-badge">${h.result === 'WIN' ? 'W' : 'L'}</div>
                <div class="sl-hist-details">
                    <div class="sl-hist-label">${h.gameLabel || 'Match'}</div>
                    <div class="sl-hist-opp">vs ${h.opponents}</div>
                </div>
                <div class="sl-hist-time">${this._formatDate(h.date)}</div>
            </div>
        `).join('');
    },
};

// =============================================================================
// SIDELINE VIEW
// =============================================================================

const SidelineView = {
    _visible: false,

    show() {
        this._visible = true;
        const panel = document.getElementById('sidelinePanel');
        if (panel) { panel.style.display = 'flex'; this.refresh(); }
    },

    hide() {
        this._visible = false;
        const panel = document.getElementById('sidelinePanel');
        if (panel) panel.style.display = 'none';
    },

    refresh() {
        if (!this._visible) return;
        const passport = Passport.get();
        if (!passport) return;

        // Identity
        const nameEl  = document.getElementById('slPassportName');
        if (nameEl) nameEl.textContent = passport.playerName;

        // Stats
        const winsEl  = document.getElementById('slPrivateWins');
        const gamesEl = document.getElementById('slPrivateGames');
        const wrEl    = document.getElementById('slPrivateWR');
        if (winsEl)  winsEl.textContent  = passport.privateLifetimeWins;
        if (gamesEl) gamesEl.textContent = passport.privateTotalGames;
        if (wrEl)    wrEl.textContent    = Passport.winRate();

        this._renderMatches();
        this._renderNextUp();
        this._renderLastWinner();
        this._renderPerformanceLab();
    },

    _renderMatches() {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        const matches = window.currentMatches || [];
        if (matches.length === 0) {
            container.innerHTML = `<div class="sl-empty">No active round yet</div>`;
            return;
        }
        const passport = Passport.get();
        const myName   = passport?.playerName?.toLowerCase() || '';
        container.innerHTML = matches.map((m, i) => {
            const tA      = m.teams[0] || [];
            const tB      = m.teams[1] || [];
            const playing = myName && [...tA, ...tB].map(n => n.toLowerCase()).includes(myName);
            return `
                <div class="sl-match-card ${playing ? 'sl-match-mine' : ''}">
                    <div class="sl-match-label">GAME ${i + 1}${playing ? ' · <span class="sl-you-badge">YOU</span>' : ''}</div>
                    <div class="sl-match-teams">
                        <span class="sl-team">${tA.join(' &amp; ')}</span>
                        <span class="sl-vs">VS</span>
                        <span class="sl-team">${tB.join(' &amp; ')}</span>
                    </div>
                </div>`;
        }).join('');
    },

    _renderNextUp() {
        const el    = document.getElementById('slNextUp');
        const rowEl = document.getElementById('slNextUpRow');
        if (!el || !rowEl) return;
        const text = window._lastNextUp || (document.getElementById('nextUpNames')?.textContent?.trim() || '');
        if (text) { el.textContent = text; rowEl.style.display = 'flex'; }
        else { rowEl.style.display = 'none'; }
    },

    /** Last match winner — shown after MATCH_RESOLVED */
    _renderLastWinner() {
        const el = document.getElementById('slLastWinner');
        const rowEl = document.getElementById('slLastWinnerRow');
        if (!el || !rowEl) return;
        if (window._lastMatchWinner) {
            el.textContent       = window._lastMatchWinner;
            rowEl.style.display  = 'flex';
        } else {
            rowEl.style.display = 'none';
        }
    },

    /** Performance Lab — match history list */
    _renderPerformanceLab() {
        const container = document.getElementById('slLabHistory');
        if (!container) return;
        container.innerHTML = MatchHistory.renderList();
    },
};

// =============================================================================
// VICTORY CARD
// =============================================================================

const VictoryCard = {
    show(playerName) {
        const overlay = document.getElementById('victoryCardOverlay');
        const nameEl  = document.getElementById('victoryCardName');
        if (!overlay || !nameEl) return;
        nameEl.textContent = playerName.toUpperCase();
        overlay.style.display = 'flex';
        requestAnimationFrame(() => overlay.classList.add('victory-visible'));
        if (window.Haptic)   Haptic.success();
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
                backgroundColor: '#0a0a0f', scale: 2, width: 390, height: 693,
                useCORS: true, logging: false,
            });
            canvas.toBlob(async (blob) => {
                const file     = new File([blob], 'courtside-victory.png', { type: 'image/png' });
                const passport = Passport.get();
                const name     = passport?.playerName || 'Player';
                if (navigator.share && navigator.canShare({ files: [file] })) {
                    await navigator.share({ title: 'The Court Side Pro', text: `${name} just won! 🏆`, files: [file] });
                } else {
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob); a.download = 'courtside-victory.png'; a.click();
                }
                if (window.Haptic) Haptic.success();
            }, 'image/png');
        } catch (e) { console.error('Victory share failed:', e); }
    },
};

// =============================================================================
// INVITE QR — shows session join QR on player's phone
// =============================================================================

const InviteQR = {
    _overlay: null,

    // ─────────────────────────────────────────────────────────────────────────
    // show(roomCode)
    //
    // roomCode resolution order:
    //   1. Argument passed in (e.g. onclick="InviteQR.show(PlayerMode._joinCode)")
    //   2. PlayerMode._joinCode  — set synchronously in boot(), always correct
    //      for players joining via QR link
    //   3. window.currentRoomCode — set by joinOnlineSession() in sync.js,
    //      correct for host or after Supabase handshake completes
    //
    // URL format: ?join=XXXX-XXXX&role=player
    //   Matches the format the host's QR generates and the app reads on load.
    // ─────────────────────────────────────────────────────────────────────────

    show(roomCode) {
        // Resolve the room code using the priority chain above
        const code = roomCode
            || (typeof PlayerMode !== 'undefined' && PlayerMode._joinCode)
            || window.currentRoomCode
            || null;

        if (!code) {
            // No room code available — guide the user
            if (typeof showSessionToast === 'function') {
                showSessionToast('No active session to share.');
            } else {
                alert('No active session to share.');
            }
            return;
        }

        // Remove any existing overlay before creating a new one
        if (this._overlay) this._overlay.remove();

        // Build the join URL — same format the host QR uses
        const joinUrl = `${window.location.origin}${window.location.pathname}?join=${code}&role=player`;

        // Build overlay DOM
        this._overlay = document.createElement('div');
        this._overlay.className = 'sl-invite-overlay';
        this._overlay.innerHTML = `
            <div class="sl-invite-card">
                <div class="sl-invite-header">
                    <div class="sl-invite-title">INVITE TO COURT</div>
                    <button class="sl-invite-close" id="inviteCloseBtn">✕</button>
                </div>
                <div class="sl-invite-sub">Scan to join this session</div>
                <canvas id="inviteQrCanvas" class="sl-invite-canvas"></canvas>
                <div class="sl-invite-code">${code}</div>
                <div class="sl-invite-hint">Players who scan will see the player view</div>
                <button class="sl-invite-copy-btn" id="inviteCopyBtn">
                    <span class="sl-invite-copy-icon">🔗</span>
                    Copy Link
                </button>
            </div>
        `;
        document.body.appendChild(this._overlay);

        // Wire close button via addEventListener (not inline onclick)
        // so it works even if InviteQR is referenced before the script fully loads
        this._overlay.querySelector('#inviteCloseBtn')
            .addEventListener('click', () => this.hide());

        // Wire Copy Link button
        this._overlay.querySelector('#inviteCopyBtn')
            .addEventListener('click', () => this._copyLink(joinUrl));

        // Tap outside the card to dismiss
        this._overlay.addEventListener('click', e => {
            if (e.target === this._overlay) this.hide();
        });

        // Animate in on next frame
        requestAnimationFrame(() => this._overlay.classList.add('sl-invite-open'));

        // Generate QR code — same options as the host's QR in showOverlay('sync')
        if (window.QRCode) {
            QRCode.toCanvas(
                this._overlay.querySelector('#inviteQrCanvas'),
                joinUrl,
                { width: 220, margin: 2, color: { dark: '#0a0a0f', light: '#ffffff' } },
                err => { if (err) console.error('[InviteQR] QR gen failed:', err); }
            );
        } else {
            // QRCode library not loaded — show the URL as tappable text instead
            const canvas = this._overlay.querySelector('#inviteQrCanvas');
            if (canvas) {
                canvas.style.display = 'none';
                const txt = document.createElement('div');
                txt.className   = 'sl-invite-url';
                txt.textContent = joinUrl;
                canvas.parentNode.insertBefore(txt, canvas.nextSibling);
            }
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // _copyLink — copies the join URL to clipboard with visual confirmation
    // ─────────────────────────────────────────────────────────────────────────

    _copyLink(url) {
        const btn = this._overlay?.querySelector('#inviteCopyBtn');
        const succeed = () => {
            if (btn) {
                btn.innerHTML = '✅ Link copied!';
                btn.disabled  = true;
                setTimeout(() => {
                    btn.innerHTML = '<span class="sl-invite-copy-icon">🔗</span> Copy Link';
                    btn.disabled  = false;
                }, 2500);
            }
        };
        const fail = () => {
            if (btn) {
                btn.innerHTML = '⚠️ Copy failed — tap URL above';
                setTimeout(() => {
                    btn.innerHTML = '<span class="sl-invite-copy-icon">🔗</span> Copy Link';
                }, 2500);
            }
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(succeed).catch(fail);
        } else {
            // Fallback for browsers without clipboard API (e.g. old Android WebView)
            try {
                const ta = document.createElement('textarea');
                ta.value = url;
                ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                document.execCommand('copy');
                ta.remove();
                succeed();
            } catch { fail(); }
        }
    },

    hide() {
        if (!this._overlay) return;
        this._overlay.classList.remove('sl-invite-open');
        setTimeout(() => { this._overlay?.remove(); this._overlay = null; }, 300);
    },
};

// =============================================================================
// PLAYER MODE — boot controller for ?role=player  v5
// =============================================================================

const LS_TOKENS  = 'cs_session_tokens';
const SS_APPROVED = 'cs_approved';

const PlayerMode = {

    _joinCode:  null,
    _pollTimer: null,

    // ─────────────────────────────────────────────────────────────────────────
    // BOOT
    // ─────────────────────────────────────────────────────────────────────────

    async boot(passport, joinCode) {
        // ══════════════════════════════════════════════════════════════════════
        // BOOT — Four-phase init. Each phase completes independently so the
        // screen is never blank, even if the DB is slow or unreachable.
        //
        // PHASE 0 — Instant render     (synchronous, <1ms)
        // PHASE 1 — Passport check     (synchronous localStorage read)
        // PHASE 2 — Session handshake  (async DB call)
        // PHASE 3 — Join or approve    (async, sets final status)
        // ══════════════════════════════════════════════════════════════════════

        this._joinCode = joinCode;

        // ── PHASE 0: Instant frame render ─────────────────────────────────────
        // BUG 1 FIX: Render the UI shell RIGHT NOW before any async work.
        // Add .sl-booting so the status card pulses while we wait for the DB.
        // Remove it once we have a real answer.
        const panel = document.getElementById('sidelinePanel');
        if (panel) panel.classList.add('sl-booting');

        // Render whatever identity we have — even '—' is better than blank
        this._renderIdentity(passport);
        this._renderStats(passport);

        const codeEl = document.getElementById('slSessionCode');
        if (codeEl && joinCode) codeEl.textContent = joinCode;

        if (!joinCode) {
            if (panel) panel.classList.remove('sl-booting');
            this._promptForCode();
            return;
        }

        // ── EARLY: Set currentRoomCode BEFORE any name prompt or memberUpsert ──
        // memberUpsert() in sync.js reads the global `currentRoomCode`. If this
        // global is still null when memberUpsert runs (because joinOnlineSession
        // hadn't been called yet for new players), the upsert returns null and
        // the player incorrectly lands on "Court not found".
        // We set the global directly here so it's available immediately, then
        // joinOnlineSession() is called again later via _subscribeAndPoll() which
        // is a no-op on the session-get call if already connected.
        if (typeof joinOnlineSession === 'function') {
            // Fire-and-forget: we don't await here because joinOnlineSession
            // also tries to show toasts / update host UI which we don't want
            // yet. We just need currentRoomCode set synchronously below.
            joinOnlineSession(joinCode).catch(() => {});
        }
        // Belt-and-suspenders: also set the global directly in case sync.js
        // hasn't been parsed yet (very slow connections).
        if (typeof currentRoomCode !== 'undefined' && !currentRoomCode) {
            // eslint-disable-next-line no-global-assign
            currentRoomCode = joinCode;
        }

        // ── PHASE 1: Check localStorage passport ──────────────────────────────
        // BUG 3 FIX: Do this synchronously right here — zero network wait.
        // Show a personalised welcome message immediately if name exists.
        const hasName = !!(passport.playerName && passport.playerName.trim());
        if (hasName) {
            // "Welcome back" message shown instantly from localStorage
            this._showWelcomeBack(passport.playerName, joinCode);
            this.setStatus('pending', `Welcome back, ${passport.playerName}`, 'Joining court…');
        } else {
            // No name yet — show the name entry form immediately
            // _promptName() calls _showNameEntry(callback) internally, which
            // renders the form AND wires the button listener atomically.
            // We do NOT call _showNameEntry() here first — that would render
            // the form with no listener (dead button) before _promptName()
            // overwrites it with the correctly wired version.
            this.setStatus('pending', 'Almost there…', 'Enter your name to join');
            // Name entry is async — the rest of boot() waits here
            const name = await this._promptName();
            if (!name) {
                if (panel) panel.classList.remove('sl-booting');
                return;
            }
            Passport.rename(name);
            this._renderIdentity(Passport.get());
            this.setStatus('pending', `Hey ${name}!`, 'Connecting to court…');
        }

        // ── Tier 1: sessionStorage fast-path ──────────────────────────────────
        // Survives page refresh within the same tab session.
        if (this._isApprovedInSession(joinCode)) {
            if (panel) panel.classList.remove('sl-booting');
            this.setStatus('approved', `Welcome back, ${passport.playerName}`, "You're in the rotation");
            this._subscribeAndPoll(joinCode, passport);
            return;
        }

        // ── PHASE 2: DB handshake — show spinner while waiting ────────────────
        // BUG 2 FIX: The DB call is now wrapped — if it returns null (session
        // not found / network error) we show a "Searching for Court" state
        // instead of crashing or staying blank.
        this._subscribeAndPoll(joinCode, passport);

        // Show "Searching for Court…" while the DB responds
        this._showSearchingSpinner();

        let upsertResult = null;
        try {
            upsertResult = await this._memberUpsert(Passport.get(), joinCode);
        } catch (err) {
            console.error('[PlayerMode.boot] member-upsert threw:', err);
            // Treat as null — fall through to pending state
        }

        // Stop pulsing — we have a result (or a failure)
        if (panel) panel.classList.remove('sl-booting');
        this._clearSearchingSpinner();

        // ── BUG 2 FIX: Guard against null / missing session ───────────────────
        if (!upsertResult) {
            this.setStatus('pending',
                'Court not found',
                'The session may have ended. Check the room code.');
            console.error('[CourtSide] Session lookup failed for room:', joinCode,
                '— upsertResult was null. Check /api/member-upsert and network.');
            // Show manual code entry so player isn't stuck
            this._promptForCode();
            return;
        }

        // ── RETURNING APPROVED PLAYER ─────────────────────────────────────────
        if (upsertResult.status === 'active') {
            this._markApprovedInSession(joinCode);
            this._hydrateFromUpsert(upsertResult);
            const p = Passport.get();
            this.setStatus('approved', `Welcome back, ${p.playerName}!`, "You're in the squad ✅");
            SidelineView.refresh();
            setTimeout(() => this._updateStatus(p), 800);
            return;
        }

        // ── Tier 3: localStorage token fallback ───────────────────────────────
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

        // ── PHASE 3: New join — submit request, wait for host approval ────────
        await this._submitJoinRequest(Passport.get(), joinCode);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // WELCOME-BACK CARD — instant render from localStorage
    // ─────────────────────────────────────────────────────────────────────────

    _showWelcomeBack(playerName, roomCode) {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        container.innerHTML = `
            <div class="sl-welcome-back">
                <div class="sl-welcome-back-icon">🏀</div>
                <div class="sl-welcome-back-text">
                    <div class="sl-welcome-back-name">Welcome back, ${
                        playerName.toUpperCase()
                    }</div>
                    <div class="sl-welcome-back-sub">Joining court ${roomCode}…</div>
                </div>
            </div>`;
    },

    // ─────────────────────────────────────────────────────────────────────────
    // NAME ENTRY TRIGGER — shows the form without waiting for _promptName()
    // Called at the top of boot() so the input is visible instantly.
    // ─────────────────────────────────────────────────────────────────────────

    _showNameEntry(onSubmit) {
        // Always re-render the form from scratch so the DOM nodes are brand-new.
        // This prevents the "dead button" bug where a previous innerHTML write
        // (e.g. from the DOMContentLoaded fast-render in index.html) created DOM
        // nodes that look identical but have no JS event listeners attached.
        const container = document.getElementById('slCurrentMatches');
        if (!container) return null;

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
            </div>`;

        // Wire up the button in the SAME tick as the innerHTML write.
        // This is atomic — nothing can run between the render and the listener
        // attachment because there is no await, setTimeout, or Promise here.
        const input = document.getElementById('slNameEntryInput');
        const btn   = document.getElementById('slNameEntrySubmit');

        if (onSubmit && input && btn) {
            const submit = () => {
                const val = (input.value || '').trim();
                if (!val) {
                    // Empty — shake the input and keep focus
                    input.classList.add('sl-input-error');
                    setTimeout(() => input.classList.remove('sl-input-error'), 600);
                    input.focus();
                    return;
                }
                // Passport guard: ensure global passport has a UUID before proceeding.
                // Passport.init() is synchronous — it reads localStorage or creates a
                // fresh object. Either way, uuid is guaranteed after this call.
                if (typeof Passport !== 'undefined') {
                    const p = Passport.init();
                    // Keep the global `passport` variable in sync (defined in app.js).
                    if (typeof window !== 'undefined') window._passport = p;
                }
                // Visual feedback — disable button and show spinner text
                btn.disabled  = true;
                btn.innerHTML = '<span class="sl-btn-spinner"></span> REQUESTING…';
                onSubmit(val);
            };

            btn.addEventListener('click', submit);
            input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
        }

        // Focus after a short tick so the mobile keyboard has time to open
        setTimeout(() => document.getElementById('slNameEntryInput')?.focus(), 80);
        return { input, btn };
    },

    // ─────────────────────────────────────────────────────────────────────────
    // SEARCHING SPINNER — shown while DB responds (BUG 2)
    // ─────────────────────────────────────────────────────────────────────────

    _showSearchingSpinner() {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        // Only replace if it still has the welcome-back card or is empty
        if (container.querySelector('.sl-name-entry')) return; // name entry takes priority
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
    // ─────────────────────────────────────────────────────────────────────────
    // MEMBER UPSERT — calls /api/member-upsert (via sync.js helper)
    // Returns { status: 'pending'|'active', member } or null on failure.
    // ─────────────────────────────────────────────────────────────────────────

    async _memberUpsert(passport, joinCode) {
        if (typeof memberUpsert !== 'function') return null;
        return await memberUpsert(passport.playerUUID, passport.playerName);
    },

    _hydrateFromUpsert(upsertResult) {
        // Optionally update local name if server has a different one
        // (e.g. host edited it, or player joined from a different device)
        if (upsertResult?.member?.player_name) {
            const serverName = upsertResult.member.player_name;
            const passport   = Passport.get();
            if (passport && passport.playerName !== serverName) {
                Passport.rename(serverName);
                this._renderIdentity(Passport.get());
            }
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // APPROVAL — broadcast 'session_joined'
    // ─────────────────────────────────────────────────────────────────────────

    _onApprovalReceived(payload) {
        const passport = Passport.get();
        if (!passport) return;
        if (payload.playerUUID !== passport.playerUUID) return;  // strict UUID match

        // 1. Storage writes BEFORE any render
        this._markApprovedInSession(this._joinCode);
        if (payload.token) this._saveToken(this._joinCode, payload.token, passport.playerName, passport.playerUUID);

        // 2. Hydrate globals
        if (payload.squad)           window.squad          = payload.squad;
        if (payload.current_matches) window.currentMatches = payload.current_matches;

        // 3. UI
        this.setStatus('approved', `You're in, ${passport.playerName}!`, 'Added to the rotation ✅');
        this._subscribeAndPoll(this._joinCode, passport);
        setTimeout(() => this._updateStatus(passport), 1500);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // LIVE FEED — broadcast 'game_state'
    // ─────────────────────────────────────────────────────────────────────────

    _onGameStateUpdate(payload) {
        const passport = Passport.get();
        if (!passport) return;
        if (payload.next_up) window._lastNextUp = payload.next_up;
        SidelineView.refresh();
        this._updateStatus(passport);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // POSTGRES FALLBACK — 'postgres_changes'
    // ─────────────────────────────────────────────────────────────────────────

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
    // MATCH RESULT — broadcast 'match_result' (per-UUID private stat update)
    //
    // Issue #4 — BUG FIX:
    //   The `playerUUID` in the broadcast comes from squad[n].uuid (stored at
    //   approval), which is the SAME uuid as passport.playerUUID (generated
    //   locally and sent in the play-request). Strict equality check.
    // ─────────────────────────────────────────────────────────────────────────

    _onMatchResult(payload) {
        const passport = Passport.get();
        if (!passport) return;

        const { playerUUID, event } = payload;
        const isMe = playerUUID === passport.playerUUID;

        if (event === 'WIN' && isMe) {
            // 1. localStorage first
            const updated = Passport.recordWin();
            // 2. UI update
            this._renderStats(updated);
            SidelineView.refresh();
            VictoryCard.show(passport.playerName);
        } else if (event === 'LOSS') {
            const myName = passport.playerName?.toLowerCase();
            const wasPlaying = (window.currentMatches || []).some(m =>
                [...(m.teams[0]||[]), ...(m.teams[1]||[])].map(n => n.toLowerCase()).includes(myName)
            );
            if (wasPlaying || isMe) {
                const updated = Passport.recordLoss();
                this._renderStats(updated);
                SidelineView.refresh();
            }
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // MATCH RESOLVED — broadcast 'match_resolved' (round-level event)
    //
    // Issue #4 — "Next Round" button trigger:
    //   This is fired by processAndNext() in logic.js (the Next Round button).
    //   All players receive it. Handles:
    //     - Win/loss stat recording (delegates to _onMatchResult)
    //     - Last Match Winner display on sideline feed
    //     - Match history entry for Performance Lab
    // ─────────────────────────────────────────────────────────────────────────

    _onMatchResolved(payload) {
        const passport = Passport.get();
        if (!passport) return;

        const { winnerNames, winnerUUIDs = [], loserUUIDs = [], gameLabel } = payload;
        const myUUID = passport.playerUUID;

        // Determine this player's outcome
        const isWinner = winnerUUIDs.includes(myUUID);
        const isLoser  = loserUUIDs.includes(myUUID);
        const wasInMatch = isWinner || isLoser;

        // 1. Write localStorage FIRST, before any UI
        if (isWinner) {
            Passport.recordWin();
            MatchHistory.push('WIN', '—', gameLabel);
            VictoryCard.show(passport.playerName);
        } else if (isLoser) {
            Passport.recordLoss();
            MatchHistory.push('LOSS', winnerNames, gameLabel);
        }

        // 2. Show "Last Match Winner" on feed for ALL players
        window._lastMatchWinner = winnerNames ? `🏆 ${winnerNames}` : null;

        // 3. Update UI after storage writes
        this._renderStats(Passport.get());
        SidelineView.refresh();

        // 4. Haptic feedback
        if (wasInMatch && window.Haptic) {
            isWinner ? Haptic.success() : Haptic.bump();
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // STATUS CARD
    // ─────────────────────────────────────────────────────────────────────────

    _updateStatus(passport) {
        const name    = passport.playerName?.toLowerCase();
        const squad   = window.squad          || [];
        const matches = window.currentMatches || [];

        const playing = matches.some(m =>
            [...(m.teams[0]||[]), ...(m.teams[1]||[])].map(n => n.toLowerCase()).includes(name)
        );
        const inSquad = squad.some(p => p.name?.toLowerCase() === name);

        const playingNames = new Set(
            matches.flatMap(m => [...(m.teams[0]||[]), ...(m.teams[1]||[])])
                   .map(n => n.toLowerCase())
        );
        const bench = squad.filter(p => p.active && !playingNames.has(p.name?.toLowerCase()));
        const qPos  = bench.findIndex(p => p.name?.toLowerCase() === name);

        const nextUpRaw = window._lastNextUp || '';
        const isNextUp  = name && nextUpRaw.toLowerCase().includes(name);

        if (playing) {
            this.setStatus('playing', 'You\'re on court!', 'Give it everything 🏀');
        } else if (isNextUp) {
            this.setStatus('on-deck', 'You\'re on deck!', 'Get ready — you\'re up next 🟡');
        } else if (inSquad && qPos >= 0) {
            const pos = qPos + 1;
            const sfx = pos === 1 ? 'st' : pos === 2 ? 'nd' : pos === 3 ? 'rd' : 'th';
            this.setStatus('resting', `#${pos}${sfx} in line`, `${bench.length} player${bench.length !== 1 ? 's' : ''} on bench`);
        } else if (inSquad) {
            this.setStatus('resting', 'In the squad', 'Waiting for next rotation');
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // DB APPROVAL — broadcast 'session_members' postgres_changes UPDATE
    // Fired by _handleMemberChange in sync.js when status flips to 'active'.
    // This is the "Approval Memory" realtime delivery path.
    // ─────────────────────────────────────────────────────────────────────────

    _onMemberActivated(memberRecord) {
        const passport = Passport.get();
        if (!passport) return;
        // Strict UUID check — only react to our own row
        if (memberRecord.player_uuid !== passport.playerUUID) return;

        // 1. Write sessionStorage first (enables fast refresh skip next time)
        this._markApprovedInSession(this._joinCode);

        // 2. Update name if host edited it during approval
        if (memberRecord.player_name && memberRecord.player_name !== passport.playerName) {
            Passport.rename(memberRecord.player_name);
            this._renderIdentity(Passport.get());
        }

        // 3. Show approved status
        const p = Passport.get();
        this.setStatus('approved', `You're in, ${p.playerName}!`, 'Added to the rotation ✅');

        // 4. Show sideline view and compute queue position
        SidelineView.show();
        setTimeout(() => this._updateStatus(p), 1200);

        // 5. Haptic + toast
        if (window.Haptic) Haptic.success();
        if (typeof showSessionToast === 'function') {
            showSessionToast("🏀 You're approved! Welcome to the court.");
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // JOIN SESSION — submit the play request to host
    // ─────────────────────────────────────────────────────────────────────────

    async _submitJoinRequest(passport, joinCode) {
        this.setStatus('pending', 'Request sent!', 'Waiting for host to approve… 🏀');
        try {
            const res = await fetch('/api/play-request', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    room_code:   joinCode,
                    name:        passport.playerName,
                    player_uuid: passport.playerUUID,
                }),
            });

            if (!res.ok) {
                this.setStatus('pending', 'Could not join', 'Check the room code and try again');
                return;
            }

            const data = await res.json();

            if (data.alreadyActive) {
                // Race condition: approved between upsert check and play-request submission
                this._markApprovedInSession(joinCode);
                this.setStatus('approved', `Welcome back, ${passport.playerName}!`, "You're in the squad ✅");
                SidelineView.refresh();
                setTimeout(() => this._updateStatus(passport), 800);
            }
            // Otherwise: stay on pending screen, wait for _onMemberActivated()
            // which fires when the host approves via the realtime channel.

        } catch(e) {
            this.setStatus('pending', 'Connection failed', 'Check your internet');
            console.error('[PlayerMode] join request failed:', e);
        }
    },

    // Legacy _joinSession — kept for compatibility with any external callers
    async _joinSession(passport, joinCode) {
        return this._submitJoinRequest(passport, joinCode);
    },

    _subscribeAndPoll(joinCode, passport) {
        // joinOnlineSession is now called once at the top of boot() to ensure
        // currentRoomCode is set before memberUpsert runs. Calling it again
        // here would trigger a second session-get fetch and potentially reset
        // isOperator/isOnlineSession state. We only start the signal poll.
        this._startSignalPoll(joinCode, passport);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // SIGNAL POLL — DB fallback if WS broadcast missed
    // ─────────────────────────────────────────────────────────────────────────

    _startSignalPoll(joinCode, passport) {
        clearInterval(this._pollTimer);
        this._pollTimer = setInterval(() => this._pollSignal(joinCode, passport), 8000);
    },

    async _pollSignal(joinCode, passport) {
        try {
            const r = await fetch(
                `/api/passport-signal?player_uuid=${encodeURIComponent(passport.playerUUID)}&room_code=${encodeURIComponent(joinCode)}`
            );
            const d = await r.json();
            if (d.signal) {
                this._onMatchResult({
                    playerUUID: d.signal.player_uuid,
                    event:      d.signal.event,
                    gameLabel:  d.signal.game_label,
                });
                await fetch('/api/passport-signal', {
                    method:  'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ player_uuid: passport.playerUUID, room_code: joinCode }),
                }).catch(() => {});
            }
        } catch { /* silent */ }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // TOKEN & SESSION STORAGE
    // ─────────────────────────────────────────────────────────────────────────

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
            // session-get returns fields directly on the response object,
            // NOT nested under a `session` key. Reading data?.session was always
            // undefined, making every token verification fail silently.
            const approved = data?.approved_players || {};
            const entry    = approved[passport.playerUUID] || approved[passport.playerName];
            if (!entry || entry.token !== savedToken.token) return false;
            if (data) {
                window.squad          = data.squad           || [];
                window.currentMatches = data.current_matches || [];
                window._sessionUUIDMap  = data.uuid_map         || {};
                window._approvedPlayers = data.approved_players || {};
            }
            return true;
        } catch { return false; }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // UI HELPERS
    // ─────────────────────────────────────────────────────────────────────────

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
        if (avatarEl) avatarEl.textContent = (passport.playerName || '?').charAt(0).toUpperCase();
    },

    _renderStats(passport) {
        const p = passport || Passport.get();
        if (!p) return;
        const w = document.getElementById('slPrivateWins');
        const g = document.getElementById('slPrivateGames');
        const r = document.getElementById('slPrivateWR');
        if (w) w.textContent = p.privateLifetimeWins || 0;
        if (g) g.textContent = p.privateTotalGames   || 0;
        if (r) r.textContent = Passport.winRate()    || '—';
    },

    // ─────────────────────────────────────────────────────────────────────────
    // NAME ENTRY — resolves when player submits their name.
    //
    // This always calls _showNameEntry(callback), which renders the form AND
    // wires the button listener in one synchronous operation. We never try to
    // re-use a form that was pre-rendered by DOMContentLoaded — those nodes
    // have no listeners attached and clicking them does nothing (the "dead
    // button" bug). By always rendering fresh, we guarantee the listener is
    // bound to the exact DOM node that is currently on screen.
    // ─────────────────────────────────────────────────────────────────────────

    _promptName() {
        return new Promise(resolve => {
            // _showNameEntry renders the form AND wires the button in one tick.
            // The callback fires when the player submits a non-empty name.
            this._showNameEntry((name) => resolve(name));
        });
    },

    _promptForCode() {
        this.setStatus('pending', 'No room code', 'Ask the host for the QR code');
        const el = document.getElementById('slCurrentMatches');
        if (el) el.innerHTML = `
            <div class="sl-code-entry">
                <div class="sl-code-label">Enter Room Code</div>
                <input id="slCodeInput" class="sl-code-input" placeholder="XXXX-XXXX"
                    autocomplete="off" autocapitalize="characters" maxlength="9"
                    onkeydown="if(event.key==='Enter') PlayerMode._manualJoin()">
                <button class="sl-code-btn" onclick="PlayerMode._manualJoin()">Join →</button>
            </div>`;
    },

    async _manualJoin() {
        const input = document.getElementById('slCodeInput');
        const code  = (input?.value || '').trim().toUpperCase();
        if (!code) return;
        this._joinCode = code;
        const codeEl = document.getElementById('slSessionCode');
        if (codeEl) codeEl.textContent = code;
        const el = document.getElementById('slCurrentMatches');
        if (el) el.innerHTML = '<div class="sl-empty">Connecting…</div>';
        await this._joinSession(Passport.get(), code);
    },
};