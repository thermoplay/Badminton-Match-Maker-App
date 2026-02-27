// =============================================================================
// PASSPORT.JS — Private Player Identity System  v6
// =============================================================================
// FIXES IN THIS VERSION:
//   #1  — dispatchWinSignals is called ONLY from processAndNext (logic.js).
//         _onMatchResolved no longer calls recordWin/recordLoss by itself;
//         it delegates to _applyMatchOutcome which uses a per-ROUND dedup key
//         (not per-gameLabel) so it correctly clears between rounds.
//   #7  — _processedResults is now cleared at the start of every new round
//         via clearRoundDedup(), called from processAndNext in logic.js.
//   #8  — editPlayerName in app.js still used prompt(); that call has been
//         replaced with the inline DOM rename flow used everywhere else.
// =============================================================================

const PASSPORT_KEY   = 'cs_player_passport';
const MATCH_HIST_KEY = 'cs_match_history';
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
        try {
            return JSON.parse(localStorage.getItem(MATCH_HIST_KEY) || '[]');
        } catch { return []; }
    },

    push(result, opponentNames, gameLabel) {
        const hist = this.get();
        hist.unshift({
            result,
            opponents: opponentNames || 'Unknown',
            gameLabel: gameLabel || '',
            date:      Date.now(),
        });
        if (hist.length > MAX_HIST) hist.splice(MAX_HIST);
        try { localStorage.setItem(MATCH_HIST_KEY, JSON.stringify(hist)); } catch { }
        return hist;
    },

    clear() {
        try { localStorage.removeItem(MATCH_HIST_KEY); } catch { }
    },

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

        const nameEl  = document.getElementById('slPassportName');
        if (nameEl) nameEl.textContent = passport.playerName;

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

    _renderPerformanceLab() {
        const container = document.getElementById('slLabHistory');
        if (!container) return;
        container.innerHTML = MatchHistory.renderList();
    },
};

// =============================================================================
// VICTORY CARD — removed as intrusive; wins recorded silently in stats
// =============================================================================
const VictoryCard = { show() {}, hide() {}, share() {} };

// =============================================================================
// INVITE QR
// =============================================================================

const InviteQR = {
    _overlay: null,

    show(roomCode) {
        if (!roomCode) { alert('No active session to share.'); return; }
        if (this._overlay) this._overlay.remove();

        const joinUrl = `${window.location.origin}${window.location.pathname}?join=${roomCode}&role=player`;

        this._overlay = document.createElement('div');
        this._overlay.className = 'sl-invite-overlay';
        this._overlay.innerHTML = `
            <div class="sl-invite-card">
                <div class="sl-invite-header">
                    <div class="sl-invite-title">INVITE TO COURT</div>
                    <button class="sl-invite-close" onclick="InviteQR.hide()">✕</button>
                </div>
                <div class="sl-invite-sub">Scan to join this session</div>
                <canvas id="inviteQrCanvas" class="sl-invite-canvas"></canvas>
                <div class="sl-invite-code">${roomCode}</div>
                <div class="sl-invite-hint">Players who scan will see the player view</div>
            </div>
        `;
        document.body.appendChild(this._overlay);
        requestAnimationFrame(() => this._overlay.classList.add('sl-invite-open'));

        this._overlay.addEventListener('click', e => {
            if (e.target === this._overlay) this.hide();
        });

        if (window.QRCode) {
            QRCode.toCanvas(document.getElementById('inviteQrCanvas'), joinUrl, {
                width:  220,
                margin: 2,
                color: { dark: '#0a0a0f', light: '#ffffff' },
            }, err => {
                if (err) {
                    console.error('InviteQR: QR gen failed', err);
                    // Show URL as readable fallback instead of silent failure
                    const canvas = document.getElementById('inviteQrCanvas');
                    if (canvas) {
                        canvas.style.display = 'none';
                        const txt = document.createElement('div');
                        txt.className = 'sl-invite-url';
                        txt.textContent = joinUrl;
                        canvas.parentNode.insertBefore(txt, canvas.nextSibling);
                    }
                }
            });
        } else {
            const canvas = document.getElementById('inviteQrCanvas');
            if (canvas) {
                canvas.style.display = 'none';
                const txt = document.createElement('div');
                txt.className = 'sl-invite-url';
                txt.textContent = joinUrl;
                canvas.parentNode.insertBefore(txt, canvas.nextSibling);
            }
        }
    },

    hide() {
        if (!this._overlay) return;
        this._overlay.classList.remove('sl-invite-open');
        setTimeout(() => { this._overlay?.remove(); this._overlay = null; }, 300);
    },
};

// =============================================================================
// PLAYER MODE — boot controller  v6
// =============================================================================

const LS_TOKENS   = 'cs_session_tokens';
const SS_APPROVED = 'cs_approved';

const PlayerMode = {

    _joinCode:  null,
    _pollTimer: null,

    // ─────────────────────────────────────────────────────────────────────────
    // FIX #7: per-round dedup set.
    // Cleared by clearRoundDedup() which is called from processAndNext()
    // in logic.js at the start of every new round.
    // Key format: `${playerUUID}-${gameLabel}` where gameLabel is "Game N".
    // ─────────────────────────────────────────────────────────────────────────
    _processedResults: new Set(),

    clearRoundDedup() {
        this._processedResults.clear();
    },

    _markResultProcessed(gameLabel) {
        const passport = Passport.get();
        if (!passport) return false;
        const key = `${passport.playerUUID}-${gameLabel || '_'}`;
        if (this._processedResults.has(key)) return true;
        this._processedResults.add(key);
        return false;
    },

    // ─────────────────────────────────────────────────────────────────────────
    // BOOT
    // ─────────────────────────────────────────────────────────────────────────

    async boot(passport, joinCode) {
        if (!joinCode) {
            try { joinCode = localStorage.getItem('cs_player_room_code') || null; } catch {}
        }

        this._joinCode = joinCode;

        if (joinCode) {
            try { localStorage.setItem('cs_player_room_code', joinCode); } catch {}
        }

        const panel = document.getElementById('sidelinePanel');
        if (panel) panel.classList.add('sl-booting');

        this._renderIdentity(passport);
        this._renderStats(passport);

        const codeEl = document.getElementById('slSessionCode');
        if (codeEl && joinCode) codeEl.textContent = joinCode;

        if (!joinCode) {
            if (panel) panel.classList.remove('sl-booting');
            this._promptForCode();
            return;
        }

        const hasName = !!(passport.playerName && passport.playerName.trim());
        if (hasName) {
            this._showWelcomeBack(passport.playerName, joinCode);
            this.setStatus('pending', `Welcome back, ${passport.playerName}`, 'Joining court…');
        } else {
            this.setStatus('pending', 'Almost there…', 'Enter your name to join');
            this._showNameEntry();
            const name = await this._promptName();
            if (!name) {
                if (panel) panel.classList.remove('sl-booting');
                return;
            }
            Passport.rename(name);
            this._renderIdentity(Passport.get());
            this.setStatus('pending', `Hey ${name}!`, 'Connecting to court…');
        }

        if (this._isApprovedInSession(joinCode)) {
            if (panel) panel.classList.remove('sl-booting');
            this.setStatus('approved', `Welcome back, ${passport.playerName}`, "You're in the rotation");
            // FIX #6: subscribe BEFORE calling _updateStatus so the sideline
            // is populated before any game_state broadcast can arrive.
            this._startSignalPoll(joinCode, Passport.get());
            if (typeof joinOnlineSession === 'function') {
                joinOnlineSession(joinCode).catch(() => {});
            }
            return;
        }

        this._showSearchingSpinner();

        let upsertResult = null;
        try {
            upsertResult = await this._memberUpsert(Passport.get(), joinCode);
        } catch (err) {
            console.error('[PlayerMode.boot] member-upsert threw:', err);
        }

        if (panel) panel.classList.remove('sl-booting');
        this._clearSearchingSpinner();

        if (!upsertResult) {
            this.setStatus('pending', 'Court not found',
                'The session may have ended. Check the room code.');
            console.error('[CourtSide] Session lookup failed for room:', joinCode);
            this._promptForCode();
            return;
        }

        if (upsertResult.status === 'active') {
            this._markApprovedInSession(joinCode);
            this._hydrateFromUpsert(upsertResult);
            const p = Passport.get();
            this.setStatus('approved', `Welcome back, ${p.playerName}!`, "You're in the squad ✅");
            SidelineView.refresh();
            // FIX #6: subscribe AFTER we know the player is active, so the
            // queued-state block is never rendered for already-approved players.
            this._startSignalPoll(joinCode, p);
            if (typeof joinOnlineSession === 'function') {
                joinOnlineSession(joinCode).catch(() => {});
            }
            setTimeout(() => this._updateStatus(p), 800);
            return;
        }

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

        // FIX #6: submit join request FIRST, THEN subscribe.
        // This guarantees the queued-state block is rendered before any
        // incoming game_state broadcast can call _renderMatches and overwrite it.
        await this._submitJoinRequest(Passport.get(), joinCode);
        this._startSignalPoll(joinCode, Passport.get());
        if (typeof joinOnlineSession === 'function') {
            joinOnlineSession(joinCode).catch(() => {});
        }
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

        this.setStatus('approved', `You're in, ${passport.playerName}!`, 'Added to the rotation ✅');
        setTimeout(() => this._updateStatus(passport), 1500);
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
    // FIX #1: _applyMatchOutcome — single authoritative path for recording
    // win/loss to localStorage. Called by BOTH _onMatchResolved (broadcast)
    // and _onMatchResult (DB poll). The dedup key prevents double-counting
    // even when both fire for the same game.
    //
    // FIX #7: The dedup set is cleared between rounds by clearRoundDedup()
    // in logic.js, so "Game 1" in Round 2 correctly records a new result.
    // ─────────────────────────────────────────────────────────────────────────

    _applyMatchOutcome(isWinner, opponentNames, gameLabel) {
        // Dedup: return early if we've already processed this game this round
        if (this._markResultProcessed(gameLabel)) return;

        if (isWinner) {
            Passport.recordWin();
            MatchHistory.push('WIN', opponentNames || '—', gameLabel);
        } else {
            Passport.recordLoss();
            MatchHistory.push('LOSS', opponentNames || '—', gameLabel);
        }

        this._renderStats(Passport.get());
        SidelineView.show();
        SidelineView.refresh();
    },

    _onMatchResult(payload) {
        const passport = Passport.get();
        if (!passport) return;

        const { playerUUID, event, gameLabel } = payload;
        if (playerUUID !== passport.playerUUID) return;

        // Delegate to shared outcome handler (handles dedup internally)
        this._applyMatchOutcome(event === 'WIN', '—', gameLabel || '');

        if (window.Haptic) {
            event === 'WIN' ? Haptic.success() : Haptic.bump();
        }
    },

    _onMatchResolved(payload) {
        const passport = Passport.get();
        if (!passport) return;

        const { winnerNames, winnerUUIDs = [], loserUUIDs = [], gameLabel } = payload;
        const myUUID = passport.playerUUID;

        const isWinner   = winnerUUIDs.includes(myUUID);
        const isLoser    = loserUUIDs.includes(myUUID);
        const wasInMatch = isWinner || isLoser;

        // Show "Last Match Winner" for ALL players regardless of participation
        window._lastMatchWinner = winnerNames ? `🏆 ${winnerNames}` : null;

        if (wasInMatch) {
            // Opponent names: if winner, opponents are losers and vice versa
            const opponentUUIDs = isWinner ? loserUUIDs : winnerUUIDs;
            // We don't have names here, but winnerNames gives the winner display string
            const opponentLabel = isWinner ? '—' : winnerNames || '—';

            this._applyMatchOutcome(isWinner, opponentLabel, gameLabel);

            if (window.Haptic) {
                isWinner ? Haptic.success() : Haptic.bump();
            }
        } else {
            // Not in this match — just refresh the feed display
            SidelineView.show();
            SidelineView.refresh();
        }
    },

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

        SidelineView.show();
        setTimeout(() => this._updateStatus(p), 1200);

        if (window.Haptic) Haptic.success();
        if (typeof showSessionToast === 'function') {
            showSessionToast("🏀 You're approved! Welcome to the court.");
        }
    },

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

    // FIX #6: _subscribeAndPoll removed as a combined function.
    // subscribe and poll are now called separately after _submitJoinRequest
    // completes, ensuring the queued-state block is always rendered first.
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
                window.squad            = data.session.squad           || [];
                window.currentMatches   = data.session.current_matches || [];
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

    _promptName() {
        return new Promise(resolve => {
            let input = document.getElementById('slNameEntryInput');
            let btn   = document.getElementById('slNameEntrySubmit');

            if (!input || !btn) {
                const container = document.getElementById('slCurrentMatches');
                if (!container) {
                    const n = window.prompt('Enter your name to join:');
                    return resolve(n ? n.trim() : null);
                }
                this._showNameEntry();
                input = document.getElementById('slNameEntryInput');
                btn   = document.getElementById('slNameEntrySubmit');
            }

            const submit = () => {
                const val = (input?.value || '').trim();
                if (!val) { input?.focus(); return; }
                if (btn) { btn.disabled = true; btn.textContent = 'JOINING…'; }
                resolve(val);
            };

            btn?.addEventListener('click', submit);
            input?.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
            setTimeout(() => input?.focus(), 80);
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
        await this._submitJoinRequest(Passport.get(), code);
    },
};