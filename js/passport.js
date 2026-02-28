// =============================================================================
// PASSPORT.JS — Private Player Identity System  v6
// =============================================================================
// PRIVACY CONTRACT:
//   - playerUUID and playerName travel over the wire (handshake only)
//
// FEATURES:
//   #3  Name sync:       editName → localStorage → broadcast NAME_UPDATE
//   #NEW Invite QR:      show session QR so players can invite friends
//   #TechVerify UUID:    UUID stored on squad member, survives name changes
// =============================================================================

const PASSPORT_KEY = 'cs_player_passport';
// =============================================================================
// PLAYER STATS — localStorage-only, signal-driven
// Written on every WIN/LOSS passport signal. Never reads window.squad.
// Key: 'cs_player_stats'
// Shape: { sessions: { [room_code]: { wins, losses, streak, entries: [{result,ts}] } } }
// =============================================================================

const PlayerStats = {
    _KEY: 'cs_player_stats',

    _load() {
        try { return JSON.parse(localStorage.getItem(this._KEY) || '{"sessions":{}}'); }
        catch { return { sessions: {} }; }
    },

    _save(data) {
        try { localStorage.setItem(this._KEY, JSON.stringify(data)); } catch {}
    },

    /** Record a WIN or LOSS for a given room_code. Called from _pollSignal. */
    record(roomCode, result) {
        if (!roomCode || (result !== 'WIN' && result !== 'LOSS')) return;
        const data    = this._load();
        const session = data.sessions[roomCode] || { wins: 0, losses: 0, streak: 0, entries: [] };

        session.entries.push({ result, ts: Date.now() });
        if (result === 'WIN') {
            session.wins++;
            session.streak = (session.streak > 0 ? session.streak : 0) + 1;
        } else {
            session.losses++;
            session.streak = 0;
        }

        data.sessions[roomCode] = session;
        this._save(data);
    },

    /** Get stats for a room_code. Returns { wins, losses, streak, games, winRate }. */
    get(roomCode) {
        if (!roomCode) return null;
        const data    = this._load();
        const session = data.sessions[roomCode];
        if (!session) return { wins: 0, losses: 0, streak: 0, games: 0, winRate: 0 };
        const games   = session.wins + session.losses;
        const winRate = games > 0 ? Math.round((session.wins / games) * 100) : 0;
        return { wins: session.wins, losses: session.losses, streak: session.streak, games, winRate };
    },

    /** Clear stats for a room_code (called on session end / new join). */
    clear(roomCode) {
        if (!roomCode) return;
        const data = this._load();
        delete data.sessions[roomCode];
        this._save(data);
    },
};

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
                playerUUID: this._uuid(),
                playerName: name || '',
                createdAt:  Date.now(),
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

    _uuid() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
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
        if (panel) {
            panel.style.display = 'flex';
            this.refresh();
            // Inject tab bar on first show — safe to call multiple times
            _injectStatsTabs();
        }
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

        const nameEl = document.getElementById('slPassportName');
        if (nameEl) nameEl.textContent = passport.playerName;

        this._renderMatches();
        this._renderNextUp();
        this._renderLastWinner();
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
            const tA      = m.teams[0] || [];
            const tB      = m.teams[1] || [];
            const playing = myName && [...tA, ...tB].map(n => n.toLowerCase()).includes(myName);
            const odds    = m.odds || [50, 50];
            const winIdx  = m.winnerTeamIndex;
            const hasWinner = winIdx !== null && winIdx !== undefined;

            // Timer
            let timerHTML = '';
            if (m.startedAt) {
                const elapsed = Math.floor((Date.now() - m.startedAt) / 1000);
                const mins = Math.floor(elapsed / 60);
                const secs = elapsed % 60;
                const timeStr = `${mins}:${String(secs).padStart(2, '0')}`;
                const warnClass = elapsed > 15 * 60 ? 'sl-timer-alert' : elapsed > 10 * 60 ? 'sl-timer-warn' : '';
                timerHTML = `<span class="sl-court-timer ${warnClass}">⏱ ${timeStr}</span>`;
            }

            // Winner banner
            const winnerBanner = hasWinner
                ? `<div class="sl-winner-banner">🏆 ${(m.teams[winIdx] || []).join(' & ')} won</div>`
                : '';

            // Team styling
            const aClass = hasWinner ? (winIdx === 0 ? 'sl-team sl-team-won' : 'sl-team sl-team-lost') : 'sl-team';
            const bClass = hasWinner ? (winIdx === 1 ? 'sl-team sl-team-won' : 'sl-team sl-team-lost') : 'sl-team';

            return `
                <div class="sl-match-card ${playing ? 'sl-match-mine' : ''} ${hasWinner ? 'sl-match-decided' : ''}">
                    <div class="sl-match-header">
                        <div class="sl-match-label">COURT ${i + 1}${playing ? ' · <span class="sl-you-badge">YOU</span>' : ''}</div>
                        ${timerHTML}
                    </div>
                    <div class="sl-match-teams">
                        <div class="sl-team-col">
                            <span class="${aClass}">${tA.join(' &amp; ')}</span>
                        </div>
                        <span class="sl-vs">VS</span>
                        <div class="sl-team-col">
                            <span class="${bClass}">${tB.join(' &amp; ')}</span>
                        </div>
                    </div>
                    ${winnerBanner}
                    ${playing && !hasWinner ? `
                    <button class="sl-share-match-btn" onclick="slShareMatch(${i})">
                        📲 Share this matchup
                    </button>` : ''}
                </div>`;
        }).join('');

        // Start live timer ticks
        this._tickMatchTimers();
    },

    _tickMatchTimers() {
        if (this._timerInterval) clearInterval(this._timerInterval);
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        this._timerInterval = setInterval(() => {
            const matches = window.currentMatches || [];
            matches.forEach((m, i) => {
                if (!m.startedAt) return;
                const elapsed = Math.floor((Date.now() - m.startedAt) / 1000);
                const mins = Math.floor(elapsed / 60);
                const secs = elapsed % 60;
                const el = container.querySelector(`.sl-match-card:nth-child(${i + 1}) .sl-court-timer`);
                if (el) {
                    el.textContent = `⏱ ${mins}:${String(secs).padStart(2, '0')}`;
                    el.classList.toggle('sl-timer-warn',  elapsed > 10 * 60);
                    el.classList.toggle('sl-timer-alert', elapsed > 15 * 60);
                }
            });
        }, 1000);
    },

    _renderNextUp() {
        const el    = document.getElementById('slNextUp');
        const rowEl = document.getElementById('slNextUpRow');
        if (!el || !rowEl) return;
        const text = window._lastNextUp || (document.getElementById('nextUpNames')?.textContent?.trim() || '');
        if (!text) { rowEl.style.display = 'none'; return; }

        // Parse names and render with avatars if Avatar is available
        if (window.Avatar) {
            const names = text.split(/\s*[,&]\s*/).map(n => n.trim()).filter(Boolean);
            el.innerHTML = names.map(name =>
                `<span class="sl-next-avatar-chip">
                    <span class="sl-next-avatar" style="background:${Avatar.color(name)}">${Avatar.initials(name)}</span>
                    <span class="sl-next-name">${escapeHTML ? escapeHTML(name) : name}</span>
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
};

// =============================================================================
// VICTORY CARD — stubbed out
// =============================================================================

const VictoryCard = { show() {}, hide() {}, share() {} };

// =============================================================================
// INVITE QR — shows session join QR on player's phone
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
            }, err => { if (err) console.error('InviteQR: QR gen failed', err); });
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
// PLAYER MODE — boot controller for ?role=player  v6
// =============================================================================

const LS_TOKENS   = 'cs_session_tokens';
const SS_APPROVED = 'cs_approved';

const PlayerMode = {

    _joinCode:  null,
    _pollTimer: null,

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
            this._subscribeAndPoll(joinCode, passport);
            return;
        }

        this._subscribeAndPoll(joinCode, passport);
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
            this.setStatus('pending',
                'Court not found',
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
        this._subscribeAndPoll(this._joinCode, passport);
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
    // MATCH RESOLVED — shows winner banner + haptic only. No stat recording.
    // ─────────────────────────────────────────────────────────────────────────

    _onMatchResolved(payload) {
        const { winnerNames, winnerUUIDs = [], loserUUIDs = [] } = payload;
        const myUUID     = Passport.get()?.playerUUID;
        const isWinner   = myUUID && winnerUUIDs.includes(myUUID);
        const wasInMatch = myUUID && (winnerUUIDs.includes(myUUID) || loserUUIDs.includes(myUUID));

        // Record stat locally the moment the broadcast arrives — this is the
        // primary delivery path. _pollSignal is just a slow DB fallback.
        if (wasInMatch) {
            const roomCode = this._joinCode || window.currentRoomCode;
            PlayerStats.record(roomCode, isWinner ? 'WIN' : 'LOSS');
            _renderStatsTab(roomCode);
        }

        window._lastMatchWinner = winnerNames ? `🏆 ${winnerNames}` : null;

        SidelineView.show();
        SidelineView.refresh();

        if (wasInMatch && window.Haptic) {
            isWinner ? Haptic.success() : Haptic.bump();
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

        // Determine new status key before setting UI
        let newStatus = null;
        if (playing)                   newStatus = 'playing';
        else if (isNextUp)             newStatus = 'on-deck';
        else if (inSquad && qPos >= 0) newStatus = 'resting';
        else if (inSquad)              newStatus = 'squad';

        // Fire haptic + banner ONLY on transition INTO 'playing'
        if (newStatus === 'playing' && this._prevStatus !== 'playing') {
            if (window.Haptic) Haptic.success();
            _showYoureUpBanner();
        }

        // Fire haptic ONLY on transition INTO 'on-deck'
        if (newStatus === 'on-deck' && this._prevStatus !== 'on-deck') {
            if (window.Haptic) Haptic.bump();
        }

        this._prevStatus = newStatus;

        // Update the profile play count badge whenever status refreshes
        _renderPlayCount(passport.playerName);

        if (playing) {
            this.setStatus('playing', "You're on court!", 'Give it everything 🏀');
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
                // Record WIN/LOSS only if _onMatchResolved hasn't already done it
                // via the faster broadcast path. We detect this by checking if the
                // signal timestamp is recent — if the stat was already recorded in
                // the last 10s for this room, skip to avoid double-counting.
                if (d.signal.event === 'WIN' || d.signal.event === 'LOSS') {
                    const existing = PlayerStats.get(joinCode);
                    const lastEntry = PlayerStats._load().sessions?.[joinCode]?.entries?.slice(-1)[0];
                    const alreadyRecorded = lastEntry && (Date.now() - lastEntry.ts) < 10000;
                    if (!alreadyRecorded) {
                        PlayerStats.record(joinCode, d.signal.event);
                        _renderStatsTab(joinCode);
                    }
                }

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
};
// =============================================================================
// "YOU'RE UP!" BANNER — fires once on transition into playing state
// =============================================================================

function _showYoureUpBanner() {
    // Remove any existing banner first
    document.getElementById('_csYoureUpBanner')?.remove();

    const banner = document.createElement('div');
    banner.id = '_csYoureUpBanner';
    Object.assign(banner.style, {
        position:        'fixed',
        top:             '0',
        left:            '0',
        right:           '0',
        zIndex:          '10000',
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
        transition:      'transform 0.35s cubic-bezier(0.22,1,0.36,1)',
        borderRadius:    '0 0 16px 16px',
    });
    banner.innerHTML = `
        <div style="font-size:1.5rem;margin-bottom:4px;">🏀</div>
        <div>YOU'RE UP — GET ON COURT!</div>
    `;
    document.body.appendChild(banner);

    // Slide in
    requestAnimationFrame(() => {
        requestAnimationFrame(() => { banner.style.transform = 'translateY(0)'; });
    });

    // Slide out after 4s
    setTimeout(() => {
        banner.style.transform = 'translateY(-100%)';
        setTimeout(() => banner.remove(), 400);
    }, 4000);

    // Tap to dismiss
    banner.addEventListener('click', () => {
        banner.style.transform = 'translateY(-100%)';
        setTimeout(() => banner.remove(), 400);
    });
}

// =============================================================================
// MY STATS TAB — injected into the sideline panel, driven by PlayerStats
// =============================================================================

/**
 * Injects the LIVE / MY STATS tab bar into the sideline panel once.
 * Safe to call multiple times — guards with _slTabsInjected flag.
 */
let _slTabsInjected = false;

function _injectStatsTabs() {
    if (_slTabsInjected) return;
    const inner = document.querySelector('#sidelinePanel .sl-inner');
    if (!inner) return;

    // ── Tab bar — insert after .sl-identity ────────────────────────────────
    const identity = inner.querySelector('.sl-identity');
    if (!identity) return;

    const tabBar = document.createElement('div');
    tabBar.id        = 'slTabBar';
    tabBar.className = 'sl-tab-bar';
    tabBar.innerHTML = `
        <button class="sl-tab sl-tab-active" id="slTabLive" onclick="_slSwitchTab('live')">
            <span class="sl-tab-live-dot"></span>LIVE
        </button>
        <button class="sl-tab" id="slTabStats" onclick="_slSwitchTab('stats')">
            ✦ MY STATS
        </button>`;
    identity.insertAdjacentElement('afterend', tabBar);

    // ── Stats panel — insert after tab bar ─────────────────────────────────
    const statsPanel = document.createElement('div');
    statsPanel.id        = 'slStatsPanel';
    statsPanel.className = 'sl-stats-panel';
    statsPanel.style.display = 'none';
    tabBar.insertAdjacentElement('afterend', statsPanel);

    // ── Wrap all existing live content so we can hide/show it as one unit ──
    const liveWrapper = document.createElement('div');
    liveWrapper.id = 'slLiveWrapper';
    const liveEls = inner.querySelectorAll(
        '.sl-section-label, #slCurrentMatches, #slNextUpRow, #slLastWinnerRow, .sl-invite-btn'
    );
    if (liveEls[0]) {
        inner.insertBefore(liveWrapper, liveEls[0]);
        liveEls.forEach(el => liveWrapper.appendChild(el));
    }

    // ── Inline styles — no separate CSS file needed ────────────────────────
    if (!document.getElementById('slStatsStyles')) {
        const style = document.createElement('style');
        style.id = 'slStatsStyles';
        style.textContent = `
            .sl-tab-bar {
                display: flex; gap: 8px;
                margin: 14px 0 4px;
                padding-bottom: 12px;
                border-bottom: 1.5px solid rgba(255,255,255,0.07);
            }
            .sl-tab {
                flex: 1; padding: 10px 0;
                background: transparent;
                border: 1.5px solid rgba(255,255,255,0.1);
                border-radius: 10px;
                color: rgba(255,255,255,0.4);
                font-family: 'Arial Narrow', Arial, sans-serif;
                font-size: 0.75rem; font-weight: 600; letter-spacing: 4px;
                cursor: pointer; transition: all 0.2s;
                display: flex; align-items: center; justify-content: center; gap: 6px;
            }
            .sl-tab-active {
                background: rgba(0,255,163,0.1);
                border-color: rgba(0,255,163,0.45);
                color: #00ffa3;
            }
            .sl-tab-live-dot {
                width: 7px; height: 7px;
                background: #00ffa3; border-radius: 50%;
                animation: slPulse 1.8s ease-in-out infinite;
            }
            @keyframes slPulse {
                0%,100% { opacity:1; transform:scale(1); }
                50%      { opacity:0.5; transform:scale(0.8); }
            }
            .sl-stats-panel { padding: 4px 0 20px; min-height: 160px; }
            .sl-stats-empty {
                display: flex; flex-direction: column; align-items: center;
                justify-content: center; padding: 40px 24px; gap: 10px;
                color: rgba(255,255,255,0.3);
                font-family: 'Arial Narrow', Arial, sans-serif;
                font-size: 0.85rem; letter-spacing: 2px; text-align: center;
            }
            .sl-stats-content { display: flex; flex-direction: column; gap: 12px; padding: 8px 0; }
            .sl-stats-record {
                display: flex; align-items: center; gap: 18px;
                background: rgba(255,255,255,0.04);
                border: 1.5px solid rgba(255,255,255,0.07);
                border-radius: 16px; padding: 16px 18px;
            }
            .sl-stats-ring-wrap { position: relative; width: 80px; height: 80px; flex-shrink: 0; }
            .sl-ring-svg { width: 80px; height: 80px; transform: rotate(-90deg); }
            .sl-ring-bg  { fill: none; stroke: rgba(255,255,255,0.07); stroke-width: 7; }
            .sl-ring-fill {
                fill: none; stroke-width: 7; stroke-linecap: round;
                transition: stroke-dasharray 0.7s cubic-bezier(0.4,0,0.2,1);
            }
            .sl-ring-inner {
                position: absolute; inset: 0;
                display: flex; flex-direction: column;
                align-items: center; justify-content: center;
            }
            .sl-ring-pct  { font-family: 'Arial Narrow', Arial, sans-serif; font-size: 1.05rem; font-weight: 700; color: #fff; line-height: 1; }
            .sl-ring-lbl  { font-size: 0.42rem; letter-spacing: 2px; color: rgba(255,255,255,0.35); margin-top: 2px; }
            .sl-stats-pills { display: flex; flex-wrap: wrap; gap: 8px; flex: 1; }
            .sl-stat-pill {
                display: flex; flex-direction: column; align-items: center;
                background: rgba(255,255,255,0.05); border-radius: 10px;
                padding: 8px 12px; flex: 1; min-width: 48px;
            }
            .sl-stat-num  { font-family: 'Arial Narrow', Arial, sans-serif; font-size: 1.3rem; font-weight: 700; color: #fff; line-height: 1; }
            .sl-stat-lbl  { font-size: 0.5rem; letter-spacing: 2px; color: rgba(255,255,255,0.3); margin-top: 3px; }
            .sl-stat-win  { color: #00ffa3; }
            .sl-stat-loss { color: rgba(255,255,255,0.45); }
        `;
        document.head.appendChild(style);
    }

    _slTabsInjected = true;
}

function _slSwitchTab(tab) {
    const liveWrapper = document.getElementById('slLiveWrapper');
    const statsPanel  = document.getElementById('slStatsPanel');
    const tabLive     = document.getElementById('slTabLive');
    const tabStats    = document.getElementById('slTabStats');
    if (!liveWrapper || !statsPanel) return;

    if (tab === 'live') {
        liveWrapper.style.display = 'block';
        statsPanel.style.display  = 'none';
        tabLive?.classList.add('sl-tab-active');
        tabStats?.classList.remove('sl-tab-active');
    } else {
        liveWrapper.style.display = 'none';
        statsPanel.style.display  = 'block';
        tabLive?.classList.remove('sl-tab-active');
        tabStats?.classList.add('sl-tab-active');
        // Always re-render when switching to stats so it's never stale
        const roomCode = window.currentRoomCode ||
            (typeof PlayerMode !== 'undefined' ? PlayerMode._joinCode : null);
        _renderStatsTab(roomCode);
    }
    if (window.Haptic) Haptic.tap();
}

/**
 * Renders the stats panel from PlayerStats localStorage data.
 * Called on tab switch AND immediately after every WIN/LOSS signal.
 */
function _renderStatsTab(roomCode) {
    const panel = document.getElementById('slStatsPanel');
    if (!panel) return;

    // Inject tabs if not done yet (first signal may arrive before user taps)
    _injectStatsTabs();

    const stats = PlayerStats.get(roomCode);
    if (!stats || stats.games === 0) {
        panel.innerHTML = `
            <div class="sl-stats-empty">
                <div style="font-size:2rem;">🏸</div>
                <div>Play a game to see your stats!</div>
            </div>`;
        return;
    }

    const { wins, losses, streak, games, winRate } = stats;
    const ringColor = winRate >= 60 ? '#00ffa3' : winRate >= 40 ? '#ffd700' : '#ff6b6b';
    const circumference = Math.round(2 * Math.PI * 34);
    const filled        = Math.round(circumference * winRate / 100);

    panel.innerHTML = `
        <div class="sl-stats-content">

            <div class="sl-stats-record">
                <div class="sl-stats-ring-wrap">
                    <svg class="sl-ring-svg" viewBox="0 0 80 80">
                        <circle class="sl-ring-bg"   cx="40" cy="40" r="34"/>
                        <circle class="sl-ring-fill" cx="40" cy="40" r="34"
                            style="stroke:${ringColor};stroke-dasharray:${filled} ${circumference};"/>
                    </svg>
                    <div class="sl-ring-inner">
                        <div class="sl-ring-pct">${winRate}%</div>
                        <div class="sl-ring-lbl">WIN RATE</div>
                    </div>
                </div>

                <div class="sl-stats-pills">
                    <div class="sl-stat-pill">
                        <span class="sl-stat-num sl-stat-win">${wins}</span>
                        <span class="sl-stat-lbl">WINS</span>
                    </div>
                    <div class="sl-stat-pill">
                        <span class="sl-stat-num sl-stat-loss">${losses}</span>
                        <span class="sl-stat-lbl">LOSSES</span>
                    </div>
                    <div class="sl-stat-pill">
                        <span class="sl-stat-num">${streak > 0 ? '🔥' : ''}${streak}</span>
                        <span class="sl-stat-lbl">STREAK</span>
                    </div>
                </div>
            </div>

        </div>`;
}

// =============================================================================
// PLAY COUNT BADGE — renders session play count on player profile
// =============================================================================

function _renderPlayCount(playerName) {
    const el = document.getElementById('slPlayCount');
    if (!el) return;

    const squad = window.squad || [];
    const me    = squad.find(p => p.name?.toLowerCase() === playerName?.toLowerCase());
    const count = me?.sessionPlayCount ?? 0;

    el.textContent   = `${count} lifetime game${count !== 1 ? 's' : ''}`;
    el.style.display = 'inline-flex';
}

// =============================================================================
// PLAYER MATCH SHARE
// =============================================================================

// =============================================================================
// PLAYER MATCH SHARE — Canvas Story Card
// Generates a 9:16 Instagram-ready image using pure Canvas.
// No html2canvas, no DOM dependencies.
// =============================================================================

async function slShareMatch(matchIdx) {
    const m = (window.currentMatches || [])[matchIdx];
    if (!m) return;

    const tA = (m.teams[0] || []).join(' & ');
    const tB = (m.teams[1] || []).join(' & ');

    const W = 1080, H = 1920;
    const canvas = document.createElement('canvas');
    canvas.width  = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // ── Background ────────────────────────────────────────────────────────────
    // Deep dark base
    ctx.fillStyle = '#08080e';
    ctx.fillRect(0, 0, W, H);

    // Subtle radial glow — top centre
    const glow1 = ctx.createRadialGradient(W/2, 380, 0, W/2, 380, 680);
    glow1.addColorStop(0,   'rgba(0,255,163,0.13)');
    glow1.addColorStop(0.5, 'rgba(0,255,163,0.04)');
    glow1.addColorStop(1,   'rgba(0,255,163,0)');
    ctx.fillStyle = glow1;
    ctx.fillRect(0, 0, W, H);

    // Bottom accent glow
    const glow2 = ctx.createRadialGradient(W/2, H-200, 0, W/2, H-200, 500);
    glow2.addColorStop(0,   'rgba(0,200,120,0.10)');
    glow2.addColorStop(1,   'rgba(0,200,120,0)');
    ctx.fillStyle = glow2;
    ctx.fillRect(0, 0, W, H);

    // Noise grain overlay (procedural dots)
    _drawGrain(ctx, W, H, 0.018);

    // ── Court line art (subtle background) ───────────────────────────────────
    _drawCourtLines(ctx, W, H);

    // ── Sport silhouettes ────────────────────────────────────────────────────
    _drawSilhouettes(ctx, W, H);

    // ── Top branding ─────────────────────────────────────────────────────────
    // Logo — no box, just text with a glow
    ctx.save();
    ctx.shadowColor = 'rgba(0,255,163,0.6)';
    ctx.shadowBlur  = 28;
    ctx.fillStyle   = '#00ffa3';
    ctx.font        = 'bold 52px "Arial Narrow", Arial, sans-serif';
    ctx.letterSpacing = '10px';
    ctx.textAlign   = 'center';
    ctx.fillText('THE COURTSIDE', W/2, 168);
    ctx.restore();

    // Thin accent line under logo
    const lineGrad = ctx.createLinearGradient(W/2 - 220, 0, W/2 + 220, 0);
    lineGrad.addColorStop(0,   'rgba(0,255,163,0)');
    lineGrad.addColorStop(0.5, 'rgba(0,255,163,0.5)');
    lineGrad.addColorStop(1,   'rgba(0,255,163,0)');
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(W/2 - 220, 188); ctx.lineTo(W/2 + 220, 188);
    ctx.stroke();

    // Live dot + label — centred together
    const liveDotX = W/2 - 52;
    const liveTextX = W/2 + 14;
    const liveY = 232;
    ctx.beginPath();
    ctx.arc(liveDotX, liveY - 7, 8, 0, Math.PI*2);
    ctx.fillStyle = '#00ffa3';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(liveDotX, liveY - 7, 15, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(0,255,163,0.25)';
    ctx.lineWidth   = 2;
    ctx.stroke();
    ctx.fillStyle   = 'rgba(255,255,255,0.45)';
    ctx.font        = '500 26px Arial, sans-serif';
    ctx.letterSpacing = '4px';
    ctx.textAlign   = 'left';
    ctx.fillText('LIVE NOW', liveTextX, liveY);
    ctx.textAlign   = 'center';

    // ── Divider ───────────────────────────────────────────────────────────────
    const divY = 310;
    const divGrad = ctx.createLinearGradient(80, divY, W-80, divY);
    divGrad.addColorStop(0,   'rgba(0,255,163,0)');
    divGrad.addColorStop(0.3, 'rgba(0,255,163,0.4)');
    divGrad.addColorStop(0.7, 'rgba(0,255,163,0.4)');
    divGrad.addColorStop(1,   'rgba(0,255,163,0)');
    ctx.strokeStyle = divGrad;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(80, divY); ctx.lineTo(W-80, divY);
    ctx.stroke();

    // ── VERSUS layout ────────────────────────────────────────────────────────
    const midY = H * 0.46;

    // Team A
    ctx.save();
    ctx.textAlign = 'center';
    _drawTeamBlock(ctx, W/2, midY - 260, tA, '#ffffff', W);
    ctx.restore();

    // VS badge
    const vsCX = W/2, vsCY = midY;
    // outer ring
    ctx.beginPath();
    ctx.arc(vsCX, vsCY, 88, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(0,255,163,0.15)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // inner fill
    ctx.beginPath();
    ctx.arc(vsCX, vsCY, 72, 0, Math.PI*2);
    const vsGrad = ctx.createRadialGradient(vsCX, vsCY, 0, vsCX, vsCY, 72);
    vsGrad.addColorStop(0, 'rgba(0,255,163,0.18)');
    vsGrad.addColorStop(1, 'rgba(0,255,163,0.04)');
    ctx.fillStyle = vsGrad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,255,163,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // VS text
    ctx.fillStyle = '#00ffa3';
    ctx.font = 'bold 56px "Arial Narrow", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.letterSpacing = '4px';
    ctx.fillText('VS', vsCX, vsCY + 20);

    // horizontal lines through VS
    ctx.strokeStyle = 'rgba(0,255,163,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(80, vsCY); ctx.lineTo(vsCX-95, vsCY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(vsCX+95, vsCY); ctx.lineTo(W-80, vsCY); ctx.stroke();

    // Team B
    ctx.save();
    ctx.textAlign = 'center';
    _drawTeamBlock(ctx, W/2, midY + 170, tB, '#ffffff', W);
    ctx.restore();

    // ── "Who you got?" CTA ───────────────────────────────────────────────────
    const ctaY = H * 0.76;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    _roundRect(ctx, 120, ctaY - 52, W - 240, 80, 16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '500 32px Arial, sans-serif';
    ctx.letterSpacing = '3px';
    ctx.textAlign = 'center';
    ctx.fillText('WHO YOU GOT? 🏸', W/2, ctaY + 8);

    // ── Bottom branding strip ─────────────────────────────────────────────────
    const botY = H - 180;
    const stripGrad = ctx.createLinearGradient(0, botY, 0, H);
    stripGrad.addColorStop(0, 'rgba(0,0,0,0)');
    stripGrad.addColorStop(1, 'rgba(0,255,163,0.07)');
    ctx.fillStyle = stripGrad;
    ctx.fillRect(0, botY, W, H - botY);

    ctx.fillStyle = 'rgba(0,255,163,0.7)';
    ctx.font = 'bold 30px "Arial Narrow", Arial, sans-serif';
    ctx.letterSpacing = '6px';
    ctx.textAlign = 'center';
    ctx.fillText('THECOURTSIDEPRO.VERCEL.APP', W/2, H - 100);

    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '22px Arial, sans-serif';
    ctx.letterSpacing = '2px';
    ctx.fillText('thecourtsidepro.vercel.app', W/2, H - 58);

    // ── Share ────────────────────────────────────────────────────────────────
    canvas.toBlob(async (blob) => {
        const file = new File([blob], 'courtside-matchup.png', { type: 'image/png' });
        const shareText = `🏸 ${tA} vs ${tB} — who you got? #CourtSide`;

        if (navigator.share && navigator.canShare({ files: [file] })) {
            await navigator.share({ title: 'CourtSide Live', text: shareText, files: [file] })
                .catch(() => _downloadShareImage(blob));
        } else {
            _downloadShareImage(blob);
        }
    }, 'image/png');
}

function _downloadShareImage(blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'courtside-matchup.png';
    a.click();
    if (typeof showSessionToast === 'function') showSessionToast('📥 Image saved!');
}

// ── Canvas helpers ────────────────────────────────────────────────────────────

function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function _drawTeamBlock(ctx, cx, y, names, color, W) {
    // Split "Player A & Player B" into two lines
    const parts = names.split(/\s*&\s*/);
    if (parts.length >= 2) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = 'bold 72px "Arial Narrow", Arial, sans-serif';
        ctx.letterSpacing = '2px';
        ctx.textAlign = 'center';
        ctx.fillText(parts[0].toUpperCase(), cx, y);
        ctx.fillStyle = 'rgba(0,255,163,0.6)';
        ctx.font = '500 34px Arial, sans-serif';
        ctx.letterSpacing = '4px';
        ctx.fillText('&', cx, y + 54);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = 'bold 72px "Arial Narrow", Arial, sans-serif';
        ctx.letterSpacing = '2px';
        ctx.fillText(parts[1].toUpperCase(), cx, y + 108);
    } else {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = 'bold 72px "Arial Narrow", Arial, sans-serif';
        ctx.letterSpacing = '2px';
        ctx.textAlign = 'center';
        ctx.fillText(names.toUpperCase(), cx, y + 54);
    }
}

function _drawGrain(ctx, W, H, density) {
    // Lightweight procedural grain — sparse random dots
    const count = Math.floor(W * H * density);
    ctx.save();
    for (let i = 0; i < count; i++) {
        const x = Math.random() * W;
        const y = Math.random() * H;
        const a = Math.random() * 0.06 + 0.01;
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.fillRect(x, y, 1, 1);
    }
    ctx.restore();
}

function _drawCourtLines(ctx, W, H) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0,255,163,0.04)';
    ctx.lineWidth = 2;

    // Outer court boundary
    const m = 80;
    ctx.strokeRect(m, H*0.22, W - m*2, H*0.56);

    // Centre line
    ctx.beginPath();
    ctx.moveTo(m, H*0.5); ctx.lineTo(W-m, H*0.5);
    ctx.stroke();

    // Service boxes
    ctx.beginPath();
    ctx.moveTo(W/2, H*0.22); ctx.lineTo(W/2, H*0.78);
    ctx.stroke();

    // Short service line
    const ssl = H * 0.12;
    ctx.beginPath();
    ctx.moveTo(m, H*0.5 - ssl); ctx.lineTo(W-m, H*0.5 - ssl);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(m, H*0.5 + ssl); ctx.lineTo(W-m, H*0.5 + ssl);
    ctx.stroke();

    ctx.restore();
}

function _drawSilhouettes(ctx, W, H) {
    ctx.save();
    ctx.globalAlpha = 0.055;
    ctx.fillStyle = '#00ffa3';

    // ── Badminton racket (top-left, large, rotated) ───────────────────────────
    _drawRacket(ctx, 130, 520, 200, -0.5);

    // ── Badminton racket (bottom-right, mirrored) ─────────────────────────────
    _drawRacket(ctx, W - 130, H - 460, 180, 2.8);

    // ── Shuttlecock (top-right) ───────────────────────────────────────────────
    _drawShuttle(ctx, W - 160, 480, 80);

    // ── Shuttlecock (bottom-left, smaller) ───────────────────────────────────
    _drawShuttle(ctx, 180, H - 420, 55);

    // ── Small racket accent (centre-left) ────────────────────────────────────
    _drawRacket(ctx, 90, H*0.5, 100, 0.3);

    ctx.restore();
}

function _drawRacket(ctx, cx, cy, size, angle) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    const headR = size * 0.38;
    const handleL = size * 0.55;
    const handleW = size * 0.06;
    const throatH = size * 0.15;

    // Head (oval)
    ctx.beginPath();
    ctx.ellipse(0, -size*0.18, headR * 0.72, headR, 0, 0, Math.PI*2);
    ctx.fill();

    // Knock out string area (negative space effect — slightly transparent)
    ctx.save();
    ctx.globalAlpha = 0.0;
    ctx.beginPath();
    ctx.ellipse(0, -size*0.18, headR * 0.58, headR * 0.84, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();

    // String lines (horizontal)
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = '#00ffa3';
    ctx.lineWidth = size * 0.018;
    ctx.beginPath();
    ctx.ellipse(0, -size*0.18, headR * 0.72, headR, 0, 0, Math.PI*2);
    ctx.clip();
    for (let i = -5; i <= 5; i++) {
        const yy = -size*0.18 + i * (headR * 2 / 6);
        ctx.beginPath();
        ctx.moveTo(-headR * 0.72, yy); ctx.lineTo(headR * 0.72, yy);
        ctx.stroke();
        const xx = i * (headR * 1.44 / 6);
        ctx.beginPath();
        ctx.moveTo(xx, -size*0.18 - headR); ctx.lineTo(xx, -size*0.18 + headR);
        ctx.stroke();
    }
    ctx.restore();

    // Throat (tapered triangle connecting head to handle)
    const throatTop = -size*0.18 + headR;
    ctx.beginPath();
    ctx.moveTo(-handleW*1.8, throatTop);
    ctx.lineTo( handleW*1.8, throatTop);
    ctx.lineTo( handleW,     throatTop + throatH);
    ctx.lineTo(-handleW,     throatTop + throatH);
    ctx.closePath();
    ctx.fill();

    // Handle
    _roundRectFill(ctx, -handleW, throatTop + throatH, handleW*2, handleL, handleW);

    // Grip wrap lines
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = '#08080e';
    ctx.lineWidth = size * 0.022;
    const gripStart = throatTop + throatH + handleL * 0.35;
    for (let i = 0; i < 5; i++) {
        const gy = gripStart + i * (handleL * 0.12);
        ctx.beginPath();
        ctx.moveTo(-handleW - 2, gy); ctx.lineTo(handleW + 2, gy);
        ctx.stroke();
    }
    ctx.restore();

    ctx.restore();
}

function _drawShuttle(ctx, cx, cy, size) {
    ctx.save();
    ctx.translate(cx, cy);

    // Cork base (rounded bottom)
    ctx.beginPath();
    ctx.ellipse(0, 0, size*0.22, size*0.18, 0, 0, Math.PI*2);
    ctx.fill();

    // Feather fan (8 feathers radiating upward)
    const numFeathers = 8;
    const fanSpread = 0.55; // radians total spread
    for (let i = 0; i < numFeathers; i++) {
        const t = i / (numFeathers - 1);
        const angle = -Math.PI/2 + (t - 0.5) * fanSpread * 2;
        const tipX = Math.cos(angle) * size * 0.95;
        const tipY = Math.sin(angle) * size * 0.95 - size * 0.1;
        const baseX = Math.cos(angle) * size * 0.22;
        const baseY = Math.sin(angle) * size * 0.15;

        ctx.beginPath();
        ctx.moveTo(baseX, baseY);
        ctx.quadraticCurveTo(
            tipX * 0.5 + (i - numFeathers/2) * size * 0.04,
            tipY * 0.6,
            tipX, tipY
        );
        ctx.lineWidth = size * 0.04;
        ctx.strokeStyle = '#00ffa3';
        ctx.globalAlpha = 0.055;
        ctx.stroke();
    }

    // Rim circle connecting feather tips
    ctx.beginPath();
    ctx.ellipse(0, -size * 0.52, size * 0.48, size * 0.18, 0, 0, Math.PI*2);
    ctx.lineWidth = size * 0.04;
    ctx.strokeStyle = '#00ffa3';
    ctx.globalAlpha = 0.055;
    ctx.stroke();

    ctx.restore();
}

function _roundRectFill(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
}