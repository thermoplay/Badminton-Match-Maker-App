// =============================================================================
// COURTSIDE PRO — passport.js  v6  (REWRITTEN — structural fixes applied)
// =============================================================================
// KEY FIXES IN THIS VERSION:
//
//   #A — DEAD JOIN BUTTON:
//        saveName() now updates the global `passport` object, saves to
//        localStorage, AND immediately calls joinSession() — no second click.
//
//   #B — QR URL:
//        InviteQR.show() uses ?room=XXXX-XXXX (not ?join=) matching the host
//        QR format. tryAutoRejoin() in sync.js reads both params for compat.
//
//   #C — ASYNC BOOT ORDER:
//        bootApp() runs AFTER DOMContentLoaded — all globals (currentRoomID,
//        isOnlineSession, etc.) are available when it executes.
//
//   #D — currentRoomID set BEFORE memberUpsert:
//        PlayerMode.boot() sets currentRoomID synchronously from the URL param
//        before calling any network functions that read it.
//
// PRIVACY CONTRACT:
//   playerUUID and playerName travel over the wire (handshake only).
//   privateLifetimeWins, privateTotalGames, matchHistory NEVER leave device.
// =============================================================================

const PASSPORT_KEY  = 'cs_player_passport';
const MATCH_HIST_KEY = 'cs_match_history';
const MAX_HIST       = 5;

// =============================================================================
// PASSPORT — localStorage-only identity
// =============================================================================

const Passport = {
    get() {
        try { const r = localStorage.getItem(PASSPORT_KEY); return r ? JSON.parse(r) : null; }
        catch { return null; }
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
        return p ? { playerUUID: p.playerUUID, playerName: p.playerName } : null;
    },
    rename(newName) {
        const p = this.get();
        if (!p) return null;
        p.playerName = newName.trim();
        this.save(p);
        return p;
    },
    recordWin() {
        const p = this.get();
        if (!p) return null;
        p.privateLifetimeWins++;
        p.privateTotalGames++;
        this.save(p);
        return p;
    },
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
        try { return JSON.parse(localStorage.getItem(MATCH_HIST_KEY) || '[]'); }
        catch { return []; }
    },
    push(result, opponentNames, gameLabel) {
        const hist = this.get();
        hist.unshift({ result, opponents: opponentNames || 'Unknown', gameLabel: gameLabel || '', date: Date.now() });
        if (hist.length > MAX_HIST) hist.splice(MAX_HIST);
        try { localStorage.setItem(MATCH_HIST_KEY, JSON.stringify(hist)); } catch { }
        return hist;
    },
    clear() { try { localStorage.removeItem(MATCH_HIST_KEY); } catch { } },
    _formatDate(ts) {
        const d = new Date(ts), now = new Date();
        const isToday = d.toDateString() === now.toDateString();
        const hh = String(d.getHours()).padStart(2,'0'), mm = String(d.getMinutes()).padStart(2,'0');
        const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        return isToday ? `Today ${hh}:${mm}` : `${days[d.getDay()]} ${hh}:${mm}`;
    },
    renderList() {
        const hist = this.get();
        if (!hist.length) return `<div class="sl-lab-empty">No matches recorded yet.</div>`;
        return hist.map(h => `
            <div class="sl-hist-item sl-hist-${h.result === 'WIN' ? 'win' : 'loss'}">
                <div class="sl-hist-badge">${h.result === 'WIN' ? 'W' : 'L'}</div>
                <div class="sl-hist-details">
                    <div class="sl-hist-label">${h.gameLabel || 'Match'}</div>
                    <div class="sl-hist-opp">vs ${h.opponents}</div>
                </div>
                <div class="sl-hist-time">${this._formatDate(h.date)}</div>
            </div>`).join('');
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
        const p = Passport.get();
        if (!p) return;
        const nameEl = document.getElementById('slPassportName');
        if (nameEl) nameEl.textContent = p.playerName;
        const winsEl  = document.getElementById('slPrivateWins');
        const gamesEl = document.getElementById('slPrivateGames');
        const wrEl    = document.getElementById('slPrivateWR');
        if (winsEl)  winsEl.textContent  = p.privateLifetimeWins;
        if (gamesEl) gamesEl.textContent = p.privateTotalGames;
        if (wrEl)    wrEl.textContent    = Passport.winRate();
        this._renderMatches();
        this._renderNextUp();
        this._renderLastWinner();
        this._renderPerformanceLab();
    },
    _renderMatches() {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;

        // Don't clobber the pending card while waiting for approval
        if (container.querySelector('.sl-pending-card')) return;

        const matches = window.currentMatches || [];
        const squad   = window.squad || [];
        const p       = Passport.get();
        const myName  = p?.playerName?.toLowerCase() || '';

        if (!matches.length) {
            // Show queue position if player is in squad
            if (myName && squad.length) {
                const activePlayers    = squad.filter(s => s.active);
                const playingNames     = new Set(); // empty — no matches yet
                const bench            = activePlayers.filter(s => !playingNames.has(s.name?.toLowerCase()));
                const pos              = bench.findIndex(s => s.name?.toLowerCase() === myName);
                if (pos >= 0) {
                    const rank = pos + 1;
                    const sfx  = rank===1?'st':rank===2?'nd':rank===3?'rd':'th';
                    container.innerHTML = `
                        <div class="sl-queue-card">
                            <div class="sl-queue-number">#${rank}<span class="sl-queue-sfx">${sfx}</span></div>
                            <div class="sl-queue-label">IN THE QUEUE</div>
                            <div class="sl-queue-sub">out of ${bench.length} on bench</div>
                        </div>`;
                    return;
                }
            }
            container.innerHTML = `<div class="sl-empty">No active round yet</div>`;
            return;
        }

        const playingNames = new Set(matches.flatMap(m => [...(m.teams[0]||[]), ...(m.teams[1]||[])]).map(n => n.toLowerCase()));
        const bench = (squad.filter(s => s.active && !playingNames.has(s.name?.toLowerCase())));
        const myQueuePos = bench.findIndex(s => s.name?.toLowerCase() === myName);

        let queueHtml = '';
        if (myName && !playingNames.has(myName) && myQueuePos >= 0) {
            const rank = myQueuePos + 1;
            const sfx  = rank===1?'st':rank===2?'nd':rank===3?'rd':'th';
            queueHtml = `
                <div class="sl-queue-inline">
                    <span class="sl-queue-inline-rank">#${rank}${sfx} in line</span>
                    <span class="sl-queue-inline-total">${bench.length} on bench</span>
                </div>`;
        }

        const matchCards = matches.map((m, i) => {
            const tA      = m.teams[0] || [];
            const tB      = m.teams[1] || [];
            const playing = myName && [...tA, ...tB].map(n => n.toLowerCase()).includes(myName);
            const hasWinner = m.winnerTeamIndex !== null;
            return `
                <div class="sl-match-card ${playing ? 'sl-match-mine' : ''} ${hasWinner ? 'sl-match-done' : ''}">
                    <div class="sl-match-label">
                        GAME ${i+1}
                        ${playing ? '<span class="sl-you-badge">YOU</span>' : ''}
                        ${hasWinner ? '<span class="sl-done-badge">✓ DONE</span>' : '<span class="sl-live-badge">LIVE</span>'}
                    </div>
                    <div class="sl-match-teams">
                        <span class="sl-team ${hasWinner && m.winnerTeamIndex===0 ? 'sl-team-winner' : ''}">${tA.join(' &amp; ')}</span>
                        <span class="sl-vs">VS</span>
                        <span class="sl-team ${hasWinner && m.winnerTeamIndex===1 ? 'sl-team-winner' : ''}">${tB.join(' &amp; ')}</span>
                    </div>
                </div>`;
        }).join('');

        container.innerHTML = queueHtml + matchCards;
    },
    _renderNextUp() {
        const el    = document.getElementById('slNextUp');
        const rowEl = document.getElementById('slNextUpRow');
        if (!el || !rowEl) return;
        const text = window._lastNextUp || (document.getElementById('nextUpNames')?.textContent?.trim() || '');
        if (text) { el.textContent = text; rowEl.style.display = 'flex'; }
        else { rowEl.style.display = 'none'; }
    },
    _renderLastWinner() {
        const el    = document.getElementById('slLastWinner');
        const rowEl = document.getElementById('slLastWinnerRow');
        if (!el || !rowEl) return;
        if (window._lastMatchWinner) { el.textContent = window._lastMatchWinner; rowEl.style.display = 'flex'; }
        else { rowEl.style.display = 'none'; }
    },
    _renderPerformanceLab() {
        const container = document.getElementById('slLabHistory');
        if (container) container.innerHTML = MatchHistory.renderList();
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
};

// =============================================================================
// INVITE QR — shows session join QR on player's phone
// =============================================================================
//
// ── FIX #B: URL uses ?room= (not ?join=) ─────────────────────────────────────
// The host QR and the player invite QR must use the same parameter.
// sync.js tryAutoRejoin() reads both ?room= and ?join= for backward compat.
// Using ?room= ensures:
//   - When player scans, URL param is read
//   - currentRoomID is set synchronously from URL
//   - No manual code entry required
// =============================================================================

const InviteQR = {
    _overlay: null,

    show(roomCode) {
        // ── FIX #B: Resolve room code from all available sources ──────────────
        const code = roomCode
            || (typeof PlayerMode !== 'undefined' && PlayerMode._joinCode)
            || window.currentRoomID
            || window.currentRoomCode
            || null;

        if (!code) {
            if (typeof showSessionToast === 'function') showSessionToast('No active session to share.');
            else alert('No active session to share.');
            return;
        }

        if (this._overlay) this._overlay.remove();

        // ── FIX #B: Use ?room= consistently ──────────────────────────────────
        const joinUrl = `${window.location.origin}${window.location.pathname}?room=${code}&role=player`;
        console.log('[CourtSide] InviteQR URL:', joinUrl);

        this._overlay = document.createElement('div');
        this._overlay.className = 'sl-invite-overlay';
        this._overlay.innerHTML = `
            <div class="sl-invite-card">
                <div class="sl-invite-header">
                    <div class="sl-invite-title">INVITE TO COURT</div>
                    <button class="sl-invite-close" id="inviteCloseBtn">✕</button>
                </div>
                <div class="sl-invite-sub">Scan to join — no code needed</div>
                <div id="inviteQrDiv" class="sl-invite-canvas" style="display:flex;justify-content:center;margin:0 auto;"></div>
                <div class="sl-invite-code">${code}</div>
                <div class="sl-invite-hint">Host approves each player after scanning</div>
                <button class="sl-invite-copy-btn" id="inviteCopyBtn">
                    <span class="sl-invite-copy-icon">🔗</span>Copy Link
                </button>
            </div>`;
        document.body.appendChild(this._overlay);

        this._overlay.querySelector('#inviteCloseBtn').addEventListener('click', () => this.hide());
        this._overlay.querySelector('#inviteCopyBtn').addEventListener('click',  () => this._copyLink(joinUrl));
        this._overlay.addEventListener('click', e => { if (e.target === this._overlay) this.hide(); });

        requestAnimationFrame(() => this._overlay.classList.add('sl-invite-open'));

        const qrDiv  = this._overlay.querySelector('#inviteQrDiv');
        const QRCtor = window.QRCodeConstructor;
        if (qrDiv && QRCtor) {
            new QRCtor(qrDiv, { text: joinUrl, width: 220, height: 220, colorDark: '#0a0a0f', colorLight: '#ffffff', correctLevel: QRCtor.CorrectLevel?.H || 0 });
        } else if (qrDiv && window.QRCode?.toCanvas) {
            const canvas = document.createElement('canvas');
            qrDiv.appendChild(canvas);
            window.QRCode.toCanvas(canvas, joinUrl, { width: 220, margin: 2, color: { dark: '#0a0a0f', light: '#ffffff' } }, () => {});
        } else if (qrDiv) {
            const txt = document.createElement('div');
            txt.style.cssText = 'word-break:break-all;font-size:11px;color:#00ffa3;padding:12px;text-align:center;';
            txt.textContent = joinUrl;
            qrDiv.appendChild(txt);
        }
    },
    _copyLink(url) {
        const btn     = this._overlay?.querySelector('#inviteCopyBtn');
        const succeed = () => {
            if (btn) { btn.innerHTML = '✅ Link copied!'; btn.disabled = true;
                setTimeout(() => { btn.innerHTML = '<span class="sl-invite-copy-icon">🔗</span>Copy Link'; btn.disabled = false; }, 2500); }
        };
        const fail = () => {
            if (btn) { btn.innerHTML = '⚠️ Copy failed'; setTimeout(() => { btn.innerHTML = '<span class="sl-invite-copy-icon">🔗</span>Copy Link'; }, 2500); }
        };
        if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(url).then(succeed).catch(fail); }
        else {
            try {
                const ta = document.createElement('textarea');
                ta.value = url; ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
                document.body.appendChild(ta); ta.focus(); ta.select();
                document.execCommand('copy'); ta.remove(); succeed();
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
// PLAYER MODE — boot controller for ?role=player  v6
// =============================================================================

const LS_TOKENS   = 'cs_session_tokens';
const SS_APPROVED = 'cs_approved';

const PlayerMode = {
    _joinCode:  null,
    _pollTimer: null,

    // ─────────────────────────────────────────────────────────────────────────
    // BOOT — four-phase init
    //
    // ── FIX #A: Name entry now immediately calls joinSession() on submit ──────
    // ── FIX #D: currentRoomID set synchronously before any network calls ──────
    // ─────────────────────────────────────────────────────────────────────────

    async boot(p, joinCode) {
        this._joinCode = joinCode;

        const panel = document.getElementById('sidelinePanel');
        if (panel) panel.classList.add('sl-booting');

        this._renderIdentity(p);
        this._renderStats(p);

        const codeEl = document.getElementById('slSessionCode');
        if (codeEl && joinCode) codeEl.textContent = joinCode;

        if (!joinCode) {
            if (panel) panel.classList.remove('sl-booting');
            this._promptForCode();
            return;
        }

        // ── FIX #D: Set globals synchronously BEFORE any async calls ──────────
        // currentRoomID (and its legacy alias currentRoomCode) must be set before
        // memberUpsert(), _submitJoinRequest(), and subscribeRealtime() run.
        if (typeof window !== 'undefined') {
            window.currentRoomID   = joinCode;
            window.currentRoomCode = joinCode;
            window.isOnlineSession = true;
        }

        const hasName = !!(p.playerName && p.playerName.trim());

        if (hasName) {
            this._showWelcomeBack(p.playerName, joinCode);
            this.setStatus('pending', `Welcome back, ${p.playerName}`, 'Joining court…');
        } else {
            // ── FIX #A: _promptName() renders form + wires button atomically ──
            // The returned name is used immediately — no second click needed.
            this.setStatus('pending', 'Almost there…', 'Enter your name to join');
            const name = await this._promptName();
            if (!name) { if (panel) panel.classList.remove('sl-booting'); return; }

            // Update global passport FIRST (fix for global variable hoisting)
            const updated = Passport.rename(name);
            if (typeof window !== 'undefined') window._passport = updated;
            if (typeof passport !== 'undefined') passport = updated;

            this._renderIdentity(Passport.get());
            this.setStatus('pending', `Hey ${name}!`, 'Connecting to court…');
        }

        // Session storage fast-path (survives refresh in same tab)
        if (this._isApprovedInSession(joinCode)) {
            if (panel) panel.classList.remove('sl-booting');
            this.setStatus('approved', `Welcome back, ${Passport.get().playerName}`, "You're in the rotation");
            this._subscribeAndPoll(joinCode, Passport.get());
            return;
        }

        // Subscribe for realtime approval events before the upsert call
        this._subscribeAndPoll(joinCode, Passport.get());
        this._showSearchingSpinner();

        let upsertResult = null;
        try { upsertResult = await this._memberUpsert(Passport.get(), joinCode); }
        catch (err) { console.error('[PlayerMode.boot] member-upsert threw:', err); }

        if (panel) panel.classList.remove('sl-booting');
        this._clearSearchingSpinner();

        if (!upsertResult) {
            // Network/API blip — do NOT show room code entry (player already has the code from QR).
            // Stay on pending and let the realtime subscription deliver approval when it arrives.
            this.setStatus('pending', 'Connecting…', 'Waiting for court to respond. Stay put 🏀');
            // Retry upsert once after 3s in case of a cold-start delay
            setTimeout(async () => {
                try {
                    const retry = await this._memberUpsert(Passport.get(), joinCode);
                    if (retry?.status === 'active') {
                        this._markApprovedInSession(joinCode);
                        this._hydrateFromUpsert(retry);
                        await this._fetchAndApplySessionState(joinCode);
                        const cur = Passport.get();
                        this.setStatus('approved', `Welcome back, ${cur.playerName}!`, "You're in the squad ✅");
                        SidelineView.show();
                        this._updateStatus(cur);
                    } else if (retry?.status === 'pending') {
                        await this._submitJoinRequest(Passport.get(), joinCode);
                    }
                } catch { /* stay on connecting state */ }
            }, 3000);
            return;
        }

        // Returning approved player
        if (upsertResult.status === 'active') {
            this._markApprovedInSession(joinCode);
            this._hydrateFromUpsert(upsertResult);
            const current = Passport.get();
            this.setStatus('approved', `Welcome back, ${current.playerName}!`, "You're in the squad ✅");
            SidelineView.refresh();
            setTimeout(() => this._updateStatus(current), 800);
            return;
        }

        // Token fallback
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

        // New join — submit request and wait for host approval
        await this._submitJoinRequest(Passport.get(), joinCode);
    },

    _showWelcomeBack(playerName, roomCode) {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        container.innerHTML = `
            <div class="sl-welcome-back">
                <div class="sl-welcome-back-icon">🏀</div>
                <div class="sl-welcome-back-text">
                    <div class="sl-welcome-back-name">WELCOME BACK, ${playerName.toUpperCase()}</div>
                    <div class="sl-welcome-back-sub">Joining court ${roomCode}…</div>
                </div>
            </div>`;
    },

    // ── FIX #A: _showNameEntry renders form AND wires submit callback atomically
    // The button calls onSubmit(name) which in boot() leads directly to the
    // join flow — no second tap required.
    _showNameEntry(onSubmit) {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return null;

        container.innerHTML = `
            <div class="sl-name-entry" id="slNameEntryForm">
                <div class="sl-name-entry-title">ENTER YOUR NAME</div>
                <div class="sl-name-entry-sub">The host will approve your request to join the court.</div>
                <input type="text" id="slNameEntryInput" class="sl-name-input"
                    placeholder="Your name..." autocomplete="off" autocorrect="off"
                    autocapitalize="words" maxlength="30" inputmode="text">
                <button class="sl-name-submit" id="slNameEntrySubmit">JOIN COURT →</button>
            </div>`;

        const input = document.getElementById('slNameEntryInput');
        const btn   = document.getElementById('slNameEntrySubmit');

        if (onSubmit && input && btn) {
            const submit = () => {
                const val = (input.value || '').trim();
                if (!val) {
                    input.classList.add('sl-input-error');
                    setTimeout(() => input.classList.remove('sl-input-error'), 600);
                    input.focus();
                    return;
                }
                // Ensure passport UUID exists before proceeding
                if (typeof Passport !== 'undefined') {
                    const p = Passport.init();
                    if (typeof window !== 'undefined') window._passport = p;
                }
                btn.disabled  = true;
                btn.innerHTML = '<span class="sl-btn-spinner"></span> REQUESTING…';
                onSubmit(val);
            };
            btn.addEventListener('click', submit);
            input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
        }

        setTimeout(() => document.getElementById('slNameEntryInput')?.focus(), 80);
        return { input, btn };
    },

    _showSearchingSpinner() {
        const container = document.getElementById('slCurrentMatches');
        if (!container || container.querySelector('.sl-name-entry')) return;
        container.innerHTML = `
            <div class="sl-searching">
                <div class="sl-searching-spinner"></div>
                <div class="sl-searching-text">SEARCHING FOR COURT…</div>
            </div>`;
    },

    _clearSearchingSpinner() {
        const container = document.getElementById('slCurrentMatches');
        if (container?.querySelector('.sl-searching')) {
            container.innerHTML = '<div class="sl-empty">No active round yet</div>';
        }
    },

    // ── _fetchAndApplySessionState ────────────────────────────────────────────
    // Fetches the current session row and populates window.squad,
    // window.currentMatches so Live Now and queue position are immediately correct.
    // Called after approval (broadcast OR postgres_changes path).
    async _fetchAndApplySessionState(joinCode) {
        if (!joinCode) return;
        try {
            const res = await fetch(`/api/session-get?code=${encodeURIComponent(joinCode)}`);
            if (!res.ok) return;
            const data    = await res.json();
            const session = data?.session || data;
            if (session?.squad)           window.squad          = session.squad;
            if (session?.current_matches) window.currentMatches = session.current_matches;
            if (session?.uuid_map)        window._sessionUUIDMap  = session.uuid_map;
            // Refresh sideline if it's visible
            if (typeof SidelineView !== 'undefined' && SidelineView._visible) SidelineView.refresh();
        } catch { /* silent — non-critical */ }
    },

    async _memberUpsert(p, joinCode) {
        if (typeof memberUpsert !== 'function') return null;
        return await memberUpsert(p.playerUUID, p.playerName);
    },

    _hydrateFromUpsert(upsertResult) {
        if (upsertResult?.member?.player_name) {
            const serverName = upsertResult.member.player_name;
            const p          = Passport.get();
            if (p && p.playerName !== serverName) {
                Passport.rename(serverName);
                this._renderIdentity(Passport.get());
            }
        }
    },

    _onApprovalReceived(payload) {
        const p = Passport.get();
        if (!p || payload.playerUUID !== p.playerUUID) return;
        this._markApprovedInSession(this._joinCode);
        if (payload.token) this._saveToken(this._joinCode, payload.token, p.playerName, p.playerUUID);

        // Apply squad/matches from broadcast payload immediately (fastest path)
        if (payload.squad)           window.squad          = payload.squad;
        if (payload.current_matches) window.currentMatches = payload.current_matches;

        this.setStatus('approved', `You're in, ${p.playerName}! 🎉`, 'Added to the rotation ✅');
        SidelineView.show();

        // Also fetch full session state to guarantee Live Now is fresh
        this._fetchAndApplySessionState(this._joinCode).then(() => {
            this._updateStatus(Passport.get());
        });
    },

    _onGameStateUpdate(payload) {
        const p = Passport.get();
        if (!p) return;
        if (payload.next_up) window._lastNextUp = payload.next_up;
        SidelineView.refresh();
        this._updateStatus(p);
    },

    _onSessionUpdate(session) {
        const p = Passport.get();
        if (!p) return;
        const approved = session.approved_players || {};
        const myEntry  = approved[p.playerUUID] || approved[p.playerName];
        if (myEntry && !this._isApprovedInSession(this._joinCode)) {
            this._markApprovedInSession(this._joinCode);
            if (myEntry.token) this._saveToken(this._joinCode, myEntry.token, p.playerName, p.playerUUID);
            this.setStatus('approved', `You're in, ${p.playerName}!`, 'Added to the rotation ✅');
            setTimeout(() => this._updateStatus(p), 1500);
            return;
        }
        SidelineView.refresh();
        this._updateStatus(p);
    },

    _onMatchResult(payload) {
        const p = Passport.get();
        if (!p) return;
        const { playerUUID, event } = payload;
        const isMe = playerUUID === p.playerUUID;
        if (event === 'WIN' && isMe) {
            const updated = Passport.recordWin();
            this._renderStats(updated);
            SidelineView.refresh();
            VictoryCard.show(p.playerName);
        } else if (event === 'LOSS') {
            const myName     = p.playerName?.toLowerCase();
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

    _onMatchResolved(payload) {
        const p = Passport.get();
        if (!p) return;
        const { winnerNames, winnerUUIDs = [], loserUUIDs = [], gameLabel } = payload;
        const myUUID  = p.playerUUID;
        const isWinner = winnerUUIDs.includes(myUUID);
        const isLoser  = loserUUIDs.includes(myUUID);

        if (isWinner) {
            Passport.recordWin();
            MatchHistory.push('WIN', '—', gameLabel);
            VictoryCard.show(p.playerName);
        } else if (isLoser) {
            Passport.recordLoss();
            MatchHistory.push('LOSS', winnerNames, gameLabel);
        }

        window._lastMatchWinner = winnerNames ? `🏆 ${winnerNames}` : null;
        this._renderStats(Passport.get());
        SidelineView.refresh();
        if ((isWinner || isLoser) && window.Haptic) isWinner ? Haptic.success() : Haptic.bump();
    },

    _updateStatus(p) {
        const name    = p.playerName?.toLowerCase();
        const squad   = window.squad          || [];
        const matches = window.currentMatches || [];
        const playing = matches.some(m => [...(m.teams[0]||[]), ...(m.teams[1]||[])].map(n => n.toLowerCase()).includes(name));
        const inSquad = squad.some(s => s.name?.toLowerCase() === name);
        const playingNames = new Set(matches.flatMap(m => [...(m.teams[0]||[]), ...(m.teams[1]||[])]).map(n => n.toLowerCase()));
        const bench  = squad.filter(s => s.active && !playingNames.has(s.name?.toLowerCase()));
        const qPos   = bench.findIndex(s => s.name?.toLowerCase() === name);
        const isNextUp = name && (window._lastNextUp || '').toLowerCase().includes(name);

        if (playing)             this.setStatus('playing', "You're on court!", 'Give it everything 🏀');
        else if (isNextUp)       this.setStatus('on-deck', "You're on deck!", 'Get ready — you\'re up next 🟡');
        else if (inSquad && qPos >= 0) {
            const pos = qPos + 1, sfx = pos===1?'st':pos===2?'nd':pos===3?'rd':'th';
            this.setStatus('resting', `#${pos}${sfx} in line`, `${bench.length} player${bench.length!==1?'s':''} on bench`);
        } else if (inSquad) this.setStatus('resting', 'In the squad', 'Waiting for next rotation');
    },

    _onMemberActivated(memberRecord) {
        const p = Passport.get();
        if (!p || memberRecord.player_uuid !== p.playerUUID) return;
        this._markApprovedInSession(this._joinCode);
        if (memberRecord.player_name && memberRecord.player_name !== p.playerName) {
            Passport.rename(memberRecord.player_name);
            this._renderIdentity(Passport.get());
        }
        const current = Passport.get();

        // Fetch full session state immediately so Live Now + queue position are populated
        this._fetchAndApplySessionState(this._joinCode).then(() => {
            this.setStatus('approved', `You're in, ${current.playerName}! 🎉`, "Added to the rotation ✅");
            SidelineView.show();
            setTimeout(() => this._updateStatus(current), 400);
        });

        if (window.Haptic) Haptic.success();
        if (typeof showSessionToast === 'function') showSessionToast("🏀 You're approved! Welcome to the court.");
    },

    async _submitJoinRequest(p, joinCode) {
        this.setStatus('pending', 'Request sent! ⏳', 'Waiting for host to approve…');

        // Show a nice waiting card in the matches area
        const container = document.getElementById('slCurrentMatches');
        if (container) {
            container.innerHTML = `
                <div class="sl-pending-card">
                    <div class="sl-pending-icon">🏀</div>
                    <div class="sl-pending-title">REQUEST SENT</div>
                    <div class="sl-pending-sub">The host will approve you shortly.<br>This screen will update automatically.</div>
                </div>`;
        }

        try {
            const res = await fetch('/api/play-request', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ room_code: joinCode, name: p.playerName, player_uuid: p.playerUUID }),
            });
            if (!res.ok) {
                this.setStatus('pending', 'Could not join', 'Check your connection and try again');
                return;
            }
            const data = await res.json();
            if (data.alreadyActive) {
                this._markApprovedInSession(joinCode);
                await this._fetchAndApplySessionState(joinCode);
                const cur = Passport.get();
                this.setStatus('approved', `Welcome back, ${cur.playerName}! 🎉`, "You're in the squad ✅");
                SidelineView.show();
                setTimeout(() => this._updateStatus(cur), 400);
            }
            // Otherwise: realtime will deliver _onMemberActivated when host taps Approve
        } catch (e) {
            this.setStatus('pending', 'Connection failed', 'Check your internet and refresh');
            console.error('[PlayerMode] join request failed:', e);
        }
    },

    async _joinSession(p, joinCode) { return this._submitJoinRequest(p, joinCode); },

    _subscribeAndPoll(joinCode, p) {
        if (typeof subscribeRealtime === 'function' && joinCode) subscribeRealtime(joinCode);
        this._startSignalPoll(joinCode, p);
    },

    _startSignalPoll(joinCode, p) {
        clearInterval(this._pollTimer);
        this._pollTimer = setInterval(() => this._pollSignal(joinCode, p), 8000);
    },

    async _pollSignal(joinCode, p) {
        try {
            const r = await fetch(`/api/passport-signal?player_uuid=${encodeURIComponent(p.playerUUID)}&room_code=${encodeURIComponent(joinCode)}`);
            const d = await r.json();
            if (d.signal) {
                this._onMatchResult({ playerUUID: d.signal.player_uuid, event: d.signal.event, gameLabel: d.signal.game_label });
                await fetch('/api/passport-signal', {
                    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ player_uuid: p.playerUUID, room_code: joinCode }),
                }).catch(() => {});
            }
        } catch { /* silent */ }
    },

    _isApprovedInSession(roomCode) {
        try { return !!JSON.parse(sessionStorage.getItem(SS_APPROVED) || '{}')[roomCode]; } catch { return false; }
    },
    _markApprovedInSession(roomCode) {
        try { const m = JSON.parse(sessionStorage.getItem(SS_APPROVED)||'{}'); m[roomCode]=true; sessionStorage.setItem(SS_APPROVED, JSON.stringify(m)); } catch { }
    },
    _loadToken(roomCode) {
        try { return JSON.parse(localStorage.getItem(LS_TOKENS)||'{}')[roomCode] || null; } catch { return null; }
    },
    _saveToken(roomCode, token, name, uuid) {
        try { const m = JSON.parse(localStorage.getItem(LS_TOKENS)||'{}'); m[roomCode]={token,name,uuid,savedAt:Date.now()}; localStorage.setItem(LS_TOKENS, JSON.stringify(m)); } catch { }
    },
    _clearToken(roomCode) {
        try { const m = JSON.parse(localStorage.getItem(LS_TOKENS)||'{}'); delete m[roomCode]; localStorage.setItem(LS_TOKENS, JSON.stringify(m)); } catch { }
    },
    async _verifyToken(roomCode, savedToken, p) {
        try {
            const res  = await fetch(`/api/session-get?code=${encodeURIComponent(roomCode)}`);
            if (!res.ok) return false;
            const data     = await res.json();
            const approved = data?.approved_players || {};
            const entry    = approved[p.playerUUID] || approved[p.playerName];
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

    setStatus(state, text, sub) {
        const card = document.getElementById('slStatusCard');
        const icon = document.getElementById('slStatusIcon');
        const textEl = document.getElementById('slStatusText');
        const subEl  = document.getElementById('slStatusSub');
        const icons  = { pending:'⏳', 'on-deck':'🟡', playing:'🟢', resting:'🔵', approved:'✅' };
        if (card)   card.dataset.state = state;
        if (icon)   icon.textContent   = icons[state] || '⏳';
        if (textEl) textEl.textContent = text;
        if (subEl)  subEl.textContent  = sub || '';
    },

    _renderIdentity(p) {
        const nameEl   = document.getElementById('slPassportName');
        const avatarEl = document.getElementById('slPassportAvatar');
        if (nameEl)   nameEl.textContent   = p?.playerName || 'Tap to set name';
        if (avatarEl) avatarEl.textContent = (p?.playerName || '?').charAt(0).toUpperCase();
    },

    _renderStats(p) {
        const current = p || Passport.get();
        if (!current) return;
        const w = document.getElementById('slPrivateWins');
        const g = document.getElementById('slPrivateGames');
        const r = document.getElementById('slPrivateWR');
        if (w) w.textContent = current.privateLifetimeWins || 0;
        if (g) g.textContent = current.privateTotalGames   || 0;
        if (r) r.textContent = Passport.winRate()          || '—';
    },

    // ── FIX #A: _promptName wraps _showNameEntry in a Promise ────────────────
    // The form is rendered AND the button is wired in one synchronous step.
    // When the player submits, the Promise resolves — boot() continues
    // immediately without waiting for a second interaction.
    _promptName() {
        return new Promise(resolve => {
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
        // ── FIX #D: Set currentRoomID before the network call ─────────────────
        if (typeof window !== 'undefined') {
            window.currentRoomID   = code;
            window.currentRoomCode = code;
        }
        const codeEl = document.getElementById('slSessionCode');
        if (codeEl) codeEl.textContent = code;
        const el = document.getElementById('slCurrentMatches');
        if (el) el.innerHTML = '<div class="sl-empty">Connecting…</div>';
        await this._joinSession(Passport.get(), code);
    },
};

// =============================================================================
// BOOT APP — called from initApp() in app.js after DOMContentLoaded
// =============================================================================
//
// This is the async entry point for both player mode and host mode.
// All globals (currentRoomID, passport, etc.) are already set by the time
// this runs — DOMContentLoaded ensures script parse order.
//
// =============================================================================

let _bootAppRan = false; // idempotent guard

async function bootApp() {
    if (_bootAppRan) return;
    _bootAppRan = true;

    const params   = new URLSearchParams(window.location.search);
    // ── FIX #B: Read ?room= (primary) and ?join= (legacy) ─────────────────
    const joinCode = params.get('room') || params.get('join');
    const role     = params.get('role');

    if (role === 'player') {
        // ── PLAYER MODE ──────────────────────────────────────────────────────

        // Ensure host shell is hidden
        const hostRoot = document.getElementById('hostRoot');
        const hostNav  = document.getElementById('hostNav');
        if (hostRoot) hostRoot.style.display = 'none';
        if (hostNav)  hostNav.style.display  = 'none';

        // Init passport (creates UUID if new)
        const p = Passport.init();

        // Sync global `passport` variable declared in sync.js
        if (typeof window !== 'undefined') window._passport = p;
        // Allow app.js to also update its local reference
        try { if (typeof passport !== 'undefined') passport = p; } catch { }

        SidelineView.show();

        // Clean URL — remove room/join/role params so refreshing doesn't re-trigger boot
        if (joinCode) {
            const cleanUrl = `${window.location.origin}${window.location.pathname}?role=player`;
            window.history.replaceState({}, document.title, cleanUrl);
        }

        await PlayerMode.boot(p, joinCode);

    } else {
        // ── HOST / SPECTATOR MODE ─────────────────────────────────────────────
        if (typeof tryAutoRejoin === 'function') await tryAutoRejoin();
    }
}