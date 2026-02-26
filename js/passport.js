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

        // ── JOIN URL — identical construction to the host's Session Hub QR ──────
        // MUST use ?join= because that is the parameter read by:
        //   index.html boot    → params.get('join')
        //   sync.js            → urlParams.get('join')
        //   PlayerMode.boot()  → joinCode argument from index.html
        // Using any other parameter name produces "No Room Code" on the player screen.
        const joinUrl = window.location.origin + window.location.pathname + '?join=' + code + '&role=player';

        // Log so both host and player can verify in console
        console.log('[CourtSide] InviteQR generating for:', joinUrl);

        // Build overlay DOM — use a div for the QR so qrcodejs can append into it
        this._overlay = document.createElement('div');
        this._overlay.className = 'sl-invite-overlay';
        this._overlay.innerHTML = `
            <div class="sl-invite-card">
                <div class="sl-invite-header">
                    <div class="sl-invite-title">INVITE TO COURT</div>
                    <button class="sl-invite-close" id="inviteCloseBtn">✕</button>
                </div>
                <div class="sl-invite-sub">Scan to join this session</div>
                <div id="inviteQrDiv" class="sl-invite-canvas" style="display:flex;justify-content:center;margin:0 auto;"></div>
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

        // ── QR GENERATION — mirrors host QR exactly ───────────────────────────
        // QRCodeConstructor (qrcodejs) is saved in index.html before qrcode@1.5.1
        // overwrites the global. Fall back to QRCode.toCanvas if only one library loaded.
        const qrDiv  = this._overlay.querySelector('#inviteQrDiv');
        const QRCtor = window.QRCodeConstructor;

        if (qrDiv && QRCtor) {
            // Use the same constructor API as the host QR
            new QRCtor(qrDiv, {
                text:         joinUrl,
                width:        220,
                height:       220,
                colorDark:    '#0a0a0f',
                colorLight:   '#ffffff',
                correctLevel: QRCtor.CorrectLevel?.H || 0,
            });
        } else if (qrDiv && window.QRCode && typeof window.QRCode.toCanvas === 'function') {
            // Fallback: qrcode@1.5.1 toCanvas API (canvas element needed)
            const canvas = document.createElement('canvas');
            qrDiv.appendChild(canvas);
            window.QRCode.toCanvas(canvas, joinUrl,
                { width: 220, margin: 2, color: { dark: '#0a0a0f', light: '#ffffff' } },
                err => { if (err) console.error('[InviteQR] QR gen failed:', err); }
            );
        } else if (qrDiv) {
            // Both libraries unavailable — show the URL as tappable text
            console.warn('[InviteQR] No QRCode library available, showing plain URL');
            const txt = document.createElement('div');
            txt.className   = 'sl-invite-url';
            txt.textContent = joinUrl;
            txt.style.cssText = 'word-break:break-all;font-size:11px;color:#00ffa3;padding:12px;text-align:center;';
            qrDiv.appendChild(txt);
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
// PLAYER MODE — v6  Two-Layer Architecture
// =============================================================================
//
// LAYER 1 — IDENTITY  (localStorage, instant, always shown)
//   Show name + avatar the moment the page loads.
//   This is recognition only — it does NOT mean the player is in the game.
//
// LAYER 2 — SESSION  (DB check, async, the real gatekeeper)
//   After identity is shown, check session_members for roomCode + playerUUID.
//
//   State A — NO RECORD:  Show large "JOIN COURT" button. Name already known.
//   State B — PENDING:    Show "Request sent. Waiting for host…"
//   State C — ACTIVE:     Hide join UI. Show Live Match Feed + Queue Position.
//
// Live Now only appears in State C. It reads from window.currentMatches which
// is populated by /api/session-get immediately after State C is confirmed.
//
// Reconnecting indicator: non-blocking, console only. Never blocks the UI.
// =============================================================================

const LS_TOKENS   = 'cs_session_tokens';
const SS_APPROVED = 'cs_approved';

const PlayerMode = {

    _joinCode:   null,
    _pollTimer:  null,
    _sessionState: 'unknown', // 'unknown' | 'none' | 'pending' | 'active'

    // =========================================================================
    // BOOT — Entry point called from index.html window.onload
    // =========================================================================

    async boot(passport, joinCode) {
        this._joinCode = joinCode;

        // ── LAYER 1: IDENTITY (synchronous, instant) ──────────────────────────
        // Show who this person is immediately from localStorage.
        // This is cosmetic ONLY — does not imply session membership.
        this._renderIdentity(passport);
        this._renderStats(passport);

        const codeEl = document.getElementById('slSessionCode');
        if (codeEl && joinCode) codeEl.textContent = joinCode;

        if (!joinCode) {
            // Genuinely no code — player typed URL manually without scanning.
            // This is the only legitimate case for the room code entry form.
            this._showStateA_NoCode();
            return;
        }

        // Set globals sync before any async calls
        if (typeof currentRoomCode !== 'undefined') currentRoomCode = joinCode;
        if (typeof isOnlineSession !== 'undefined') isOnlineSession = true;

        // If no name yet, collect it first (new player)
        const hasName = !!(passport.playerName && passport.playerName.trim());
        if (!hasName) {
            this._showNameEntry_Blocking(joinCode);
            return;
        }

        // ── LAYER 2: SESSION CHECK (async DB) ────────────────────────────────
        // Show a neutral loading state while we check.
        // Do NOT say "Welcome back" or "You're in" until DB confirms.
        this._showLoadingState();

        // Subscribe to realtime BEFORE the DB call so we never miss an event
        this._subscribeAndPoll(joinCode, passport);

        await this._checkSessionAndRender(joinCode, passport);
    },

    // =========================================================================
    // LAYER 2 CORE — Check DB and render the correct state
    // =========================================================================

    async _checkSessionAndRender(joinCode, passport) {
        let result = null;
        try {
            result = await this._memberUpsert(passport, joinCode);
        } catch (e) {
            console.error('[PlayerMode] member-upsert error:', e);
        }

        if (!result) {
            // Network error — retry once after 3s silently, stay on loading
            console.warn('[PlayerMode] upsert returned null, retrying in 3s…');
            setTimeout(async () => {
                let retry = null;
                try { retry = await this._memberUpsert(Passport.get(), joinCode); }
                catch (e) { console.error('[PlayerMode] retry failed:', e); }
                this._applySessionResult(retry, joinCode, Passport.get());
            }, 3000);
            return;
        }

        this._applySessionResult(result, joinCode, passport);
    },

    _applySessionResult(result, joinCode, passport) {
        if (!result) {
            // Still null after retry — show join button, player can try manually
            this._showStateA_Join(passport);
            return;
        }

        if (result.status === 'active') {
            this._markApprovedInSession(joinCode);
            this._hydrateFromUpsert(result);
            this._showStateC_Active(Passport.get(), joinCode);
            return;
        }

        // status === 'pending'
        this._showStateB_Pending(passport);
    },

    // =========================================================================
    // STATE RENDERERS — One method per state, each owns its UI completely
    // =========================================================================

    // State A (no code): player opened URL directly — ask for room code
    _showStateA_NoCode() {
        this.setStatus('pending', 'No room code', 'Scan the host QR or enter code below');
        const el = document.getElementById('slCurrentMatches');
        if (!el) return;
        el.innerHTML = `
            <div class="sl-join-block">
                <div class="sl-join-label">ENTER ROOM CODE</div>
                <input id="slCodeInput" class="sl-code-input" placeholder="XXXX-XXXX"
                    autocomplete="off" autocapitalize="characters" maxlength="9"
                    onkeydown="if(event.key==='Enter') PlayerMode._manualJoin()">
                <button class="sl-join-btn" onclick="PlayerMode._manualJoin()">JOIN →</button>
            </div>`;
    },

    // State A (has code, no session record): show JOIN COURT button
    _showStateA_Join(passport) {
        this._sessionState = 'none';
        this.setStatus('pending', `Hey ${passport.playerName}!`, 'Tap below to request to join');
        const el = document.getElementById('slCurrentMatches');
        if (!el) return;
        el.innerHTML = `
            <div class="sl-join-block">
                <div class="sl-join-icon">🏀</div>
                <div class="sl-join-title">READY TO PLAY?</div>
                <div class="sl-join-sub">The host will approve your request.</div>
                <button class="sl-join-btn" onclick="PlayerMode._sendJoinRequest()">
                    JOIN COURT →
                </button>
            </div>`;
    },

    // State B: request sent, waiting for host
    _showStateB_Pending(passport) {
        this._sessionState = 'pending';
        this.setStatus('pending', 'Request sent ⏳', 'Waiting for host to approve…');
        const el = document.getElementById('slCurrentMatches');
        if (!el) return;
        el.innerHTML = `
            <div class="sl-pending-block">
                <div class="sl-pending-icon">🏀</div>
                <div class="sl-pending-title">REQUEST SENT</div>
                <div class="sl-pending-sub">
                    The host will approve you shortly.<br>
                    This screen will update automatically.
                </div>
            </div>`;
    },

    // State C: active — show live feed, queue position, matches
    _showStateC_Active(passport, joinCode) {
        this._sessionState = 'active';
        this.setStatus('approved', `Welcome back, ${passport.playerName}! 🎉`, "You're in the rotation ✅");
        // Fetch live data then render
        this._fetchAndRenderLiveFeed(joinCode, passport);
    },

    // Loading state while DB responds
    _showLoadingState() {
        const el = document.getElementById('slCurrentMatches');
        if (el) el.innerHTML = `
            <div class="sl-loading-state">
                <div class="sl-loading-spinner"></div>
                <div class="sl-loading-text">Checking court…</div>
            </div>`;
    },

    // =========================================================================
    // LIVE FEED — Only shown in State C
    // =========================================================================

    _fetchAndRenderLiveFeed(joinCode, passport) {
        if (!joinCode) return;
        fetch(`/api/session-get?code=${encodeURIComponent(joinCode)}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (data?.squad)           window.squad          = data.squad;
                if (data?.current_matches) window.currentMatches = data.current_matches;
                SidelineView.show();
                this._updateStatus(passport);
            })
            .catch(e => console.error('[PlayerMode] session-get failed:', e));
    },

    // =========================================================================
    // NAME ENTRY — New player, blocking (waits before proceeding)
    // =========================================================================

    _showNameEntry_Blocking(joinCode) {
        this.setStatus('pending', 'Almost there…', 'Enter your name to join');
        const el = document.getElementById('slCurrentMatches');
        if (!el) return;
        el.innerHTML = `
            <div class="sl-join-block" id="slNameEntryForm">
                <div class="sl-join-title">ENTER YOUR NAME</div>
                <div class="sl-join-sub">The host will approve your request.</div>
                <input type="text" id="slNameEntryInput" class="sl-name-input"
                    placeholder="Your name…" autocomplete="off" autocorrect="off"
                    autocapitalize="words" maxlength="30" inputmode="text">
                <button class="sl-join-btn" id="slNameEntrySubmit">JOIN COURT →</button>
            </div>`;

        const input = document.getElementById('slNameEntryInput');
        const btn   = document.getElementById('slNameEntrySubmit');
        if (!input || !btn) return;

        const submit = () => {
            const val = (input.value || '').trim();
            if (!val) {
                input.classList.add('sl-input-error');
                setTimeout(() => input.classList.remove('sl-input-error'), 600);
                input.focus();
                return;
            }
            btn.disabled  = true;
            btn.innerHTML = '<span class="sl-btn-spinner"></span> REQUESTING…';
            Passport.rename(val);
            const p = Passport.get();
            this._renderIdentity(p);
            // Set globals then do full session check
            if (typeof currentRoomCode !== 'undefined') currentRoomCode = joinCode;
            if (typeof isOnlineSession !== 'undefined') isOnlineSession = true;
            this._subscribeAndPoll(joinCode, p);
            this._showLoadingState();
            this._checkSessionAndRender(joinCode, p);
        };
        btn.addEventListener('click', submit);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
        setTimeout(() => input.focus(), 80);
    },

    // =========================================================================
    // JOIN REQUEST — called from State A "JOIN COURT" button
    // =========================================================================

    async _sendJoinRequest() {
        const passport  = Passport.get();
        const joinCode  = this._joinCode;
        if (!passport || !joinCode) return;
        this._showStateB_Pending(passport);
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
                console.error('[PlayerMode] play-request failed:', res.status);
                this._showStateA_Join(passport); // back to join button on error
                return;
            }
            const data = await res.json();
            if (data.alreadyActive) {
                // Race: host approved between upsert and play-request
                this._markApprovedInSession(joinCode);
                this._showStateC_Active(passport, joinCode);
            }
            // Otherwise stay in State B — realtime will call _onMemberActivated
        } catch (e) {
            console.error('[PlayerMode] play-request error:', e);
            this._showStateA_Join(passport);
        }
    },

    // =========================================================================
    // REALTIME EVENTS
    // =========================================================================

    // Host approved us (postgres_changes: status → 'active')
    _onMemberActivated(memberRecord) {
        const passport = Passport.get();
        if (!passport || memberRecord.player_uuid !== passport.playerUUID) return;
        this._markApprovedInSession(this._joinCode);
        if (memberRecord.player_name && memberRecord.player_name !== passport.playerName) {
            Passport.rename(memberRecord.player_name);
            this._renderIdentity(Passport.get());
        }
        const p = Passport.get();
        if (window.Haptic) Haptic.success();
        if (typeof showSessionToast === 'function') showSessionToast("🏀 You're in! Welcome to the court.");
        this._showStateC_Active(p, this._joinCode);
    },

    // Host broadcast approved us (session_joined broadcast)
    _onApprovalReceived(payload) {
        const passport = Passport.get();
        if (!passport || payload.playerUUID !== passport.playerUUID) return;
        this._markApprovedInSession(this._joinCode);
        if (payload.token) this._saveToken(this._joinCode, payload.token, passport.playerName, passport.playerUUID);
        if (payload.squad)           window.squad          = payload.squad;
        if (payload.current_matches) window.currentMatches = payload.current_matches;
        const p = Passport.get();
        if (window.Haptic) Haptic.success();
        this._showStateC_Active(p, this._joinCode);
    },

    // Host removed this player
    _onRemovedFromSession() {
        const joinCode = this._joinCode;
        this._clearApprovedInSession(joinCode);
        if (joinCode) this._clearToken(joinCode);
        this._sessionState = 'none';
        this.setStatus('pending', 'Removed from court', 'The host removed you.');
        const el = document.getElementById('slCurrentMatches');
        if (!el) return;
        el.innerHTML = `
            <div class="sl-join-block">
                <div class="sl-join-icon">🚫</div>
                <div class="sl-join-title" style="color:#ff6b6b">REMOVED BY HOST</div>
                <div class="sl-join-sub">You were removed from this session.</div>
                <button class="sl-join-btn" style="background:rgba(255,107,107,0.12);border-color:rgba(255,107,107,0.35);color:#ff6b6b"
                    onclick="PlayerMode._sendJoinRequest()">Request to Rejoin →</button>
            </div>`;
    },

    // Game state broadcast — only relevant in State C
    _onGameStateUpdate(payload) {
        if (this._sessionState !== 'active') return;
        const passport = Passport.get();
        if (!passport) return;
        if (payload.next_up) window._lastNextUp = payload.next_up;
        SidelineView.refresh();
        this._updateStatus(passport);
    },

    // Postgres fallback for session row updates
    _onSessionUpdate(session) {
        if (this._sessionState !== 'active') return;
        const passport = Passport.get();
        if (!passport) return;
        SidelineView.refresh();
        this._updateStatus(passport);
    },

    // Match result (per-UUID stat update)
    _onMatchResult(payload) {
        const passport = Passport.get();
        if (!passport) return;
        const { playerUUID, event } = payload;
        const isMe = playerUUID === passport.playerUUID;
        if (event === 'WIN' && isMe) {
            const updated = Passport.recordWin();
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

    // Round resolved (win/loss with UUIDs)
    _onMatchResolved(payload) {
        const passport = Passport.get();
        if (!passport) return;
        const { winnerNames, winnerUUIDs = [], loserUUIDs = [], gameLabel } = payload;
        const myUUID   = passport.playerUUID;
        const isWinner = winnerUUIDs.includes(myUUID);
        const isLoser  = loserUUIDs.includes(myUUID);
        if (isWinner) {
            Passport.recordWin();
            MatchHistory.push('WIN', '—', gameLabel);
            VictoryCard.show(passport.playerName);
        } else if (isLoser) {
            Passport.recordLoss();
            MatchHistory.push('LOSS', winnerNames, gameLabel);
        }
        window._lastMatchWinner = winnerNames ? `🏆 ${winnerNames}` : null;
        this._renderStats(Passport.get());
        SidelineView.refresh();
        if ((isWinner || isLoser) && window.Haptic) isWinner ? Haptic.success() : Haptic.bump();
    },

    // =========================================================================
    // STATUS CARD — reflects queue position (State C only)
    // =========================================================================

    _updateStatus(passport) {
        if (this._sessionState !== 'active') return;
        const name    = passport.playerName?.toLowerCase();
        const squad   = window.squad          || [];
        const matches = window.currentMatches || [];
        const playing = matches.some(m =>
            [...(m.teams[0]||[]), ...(m.teams[1]||[])].map(n => n.toLowerCase()).includes(name)
        );
        const playingNames = new Set(
            matches.flatMap(m => [...(m.teams[0]||[]), ...(m.teams[1]||[])]).map(n => n.toLowerCase())
        );
        const bench   = squad.filter(p => p.active && !playingNames.has(p.name?.toLowerCase()));
        const qPos    = bench.findIndex(p => p.name?.toLowerCase() === name);
        const inSquad = squad.some(p => p.name?.toLowerCase() === name);
        const isNextUp = name && (window._lastNextUp || '').toLowerCase().includes(name);

        if (playing) {
            this.setStatus('playing', "You're on court!", 'Give it everything 🏀');
        } else if (isNextUp) {
            this.setStatus('on-deck', "You're on deck!", "Get ready — you're up next 🟡");
        } else if (inSquad && qPos >= 0) {
            const pos = qPos + 1;
            const sfx = pos===1?'st':pos===2?'nd':pos===3?'rd':'th';
            this.setStatus('resting', `#${pos}${sfx} in line`, `${bench.length} player${bench.length!==1?'s':''} on bench`);
        } else if (inSquad) {
            this.setStatus('resting', 'In the squad', 'Waiting for next rotation');
        }
        // If not in squad yet, leave the approved status as-is
    },

    // =========================================================================
    // REALTIME SUBSCRIPTION + DB SIGNAL POLL
    // =========================================================================

    _subscribeAndPoll(joinCode, passport) {
        if (typeof subscribeRealtime === 'function' && joinCode) subscribeRealtime(joinCode);
        this._startSignalPoll(joinCode, passport);
    },

    _startSignalPoll(joinCode, passport) {
        clearInterval(this._pollTimer);
        this._pollTimer = setInterval(() => this._pollSignal(joinCode, passport), 8000);
    },

    async _pollSignal(joinCode, passport) {
        try {
            const r = await fetch(`/api/passport-signal?player_uuid=${encodeURIComponent(passport.playerUUID)}&room_code=${encodeURIComponent(joinCode)}`);
            const d = await r.json();
            if (d.signal) {
                this._onMatchResult({ playerUUID: d.signal.player_uuid, event: d.signal.event, gameLabel: d.signal.game_label });
                await fetch('/api/passport-signal', {
                    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ player_uuid: passport.playerUUID, room_code: joinCode }),
                }).catch(() => {});
            }
        } catch { /* silent */ }
    },

    // =========================================================================
    // MEMBER UPSERT
    // =========================================================================

    async _memberUpsert(passport, joinCode) {
        if (typeof memberUpsert !== 'function') return null;
        return await memberUpsert(passport.playerUUID, passport.playerName);
    },

    _hydrateFromUpsert(result) {
        if (result?.member?.player_name) {
            const serverName = result.member.player_name;
            const p = Passport.get();
            if (p && p.playerName !== serverName) {
                Passport.rename(serverName);
                this._renderIdentity(Passport.get());
            }
        }
    },

    // =========================================================================
    // SESSION STORAGE — tracks approval state across page refreshes
    // =========================================================================

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

    _clearApprovedInSession(roomCode) {
        try {
            const m = JSON.parse(sessionStorage.getItem(SS_APPROVED) || '{}');
            delete m[roomCode];
            sessionStorage.setItem(SS_APPROVED, JSON.stringify(m));
        } catch { }
    },

    // =========================================================================
    // TOKEN STORAGE
    // =========================================================================

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

    // =========================================================================
    // UI HELPERS
    // =========================================================================

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
        if (nameEl)   nameEl.textContent   = passport?.playerName || 'Tap to set name';
        if (avatarEl) avatarEl.textContent = (passport?.playerName || '?').charAt(0).toUpperCase();
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

    // Manual code entry (only when player has no code at all)
    async _manualJoin() {
        const input = document.getElementById('slCodeInput');
        const code  = (input?.value || '').trim().toUpperCase();
        if (!code) return;
        this._joinCode = code;
        const codeEl = document.getElementById('slSessionCode');
        if (codeEl) codeEl.textContent = code;
        if (typeof currentRoomCode !== 'undefined') currentRoomCode = code;
        if (typeof isOnlineSession !== 'undefined') isOnlineSession = true;
        const passport = Passport.get();
        this._subscribeAndPoll(code, passport);
        this._showLoadingState();
        await this._checkSessionAndRender(code, passport);
    },
};