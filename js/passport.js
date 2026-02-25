// =============================================================================
// PASSPORT.JS — Private Player Identity System  v4
// =============================================================================
// PRIVACY CONTRACT:
//   - playerUUID and playerName travel over the wire (handshake only)
//   - privateLifetimeWins and privateTotalGames NEVER leave this device
//   - localStorage is written BEFORE any UI re-render (prevents data loss)
// =============================================================================

const PASSPORT_KEY = 'cs_player_passport';

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

    // BUG 3: write localStorage FIRST, then caller can update UI
    rename(newName) {
        const p = this.get();
        if (!p) return null;
        p.playerName = newName.trim();
        this.save(p);   // localStorage written before any render
        return p;
    },

    // BUG 4: write localStorage FIRST before any UI update
    recordWin() {
        const p = this.get();
        if (!p) return null;
        p.privateLifetimeWins++;
        p.privateTotalGames++;
        this.save(p);   // localStorage written first
        return p;
    },

    recordLoss() {
        const p = this.get();
        if (!p) return null;
        p.privateTotalGames++;
        this.save(p);   // localStorage written first
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
        const winsEl  = document.getElementById('slPrivateWins');
        const gamesEl = document.getElementById('slPrivateGames');
        const wrEl    = document.getElementById('slPrivateWR');
        if (nameEl)  nameEl.textContent  = passport.playerName;
        if (winsEl)  winsEl.textContent  = passport.privateLifetimeWins;
        if (gamesEl) gamesEl.textContent = passport.privateTotalGames;
        if (wrEl)    wrEl.textContent    = Passport.winRate();
        this._renderMatches();
        this._renderNextUp();
    },

    _renderMatches() {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        const matches = window.currentMatches || [];
        if (matches.length === 0) {
            container.innerHTML = `<div class="sl-empty">No active matches yet</div>`;
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
        const el     = document.getElementById('slNextUp');
        const rowEl  = document.getElementById('slNextUpRow');
        const ticker = document.getElementById('nextUpNames');
        if (!el || !rowEl) return;
        const text = ticker?.textContent?.trim() || window._lastNextUp || '';
        if (text) {
            el.textContent          = text;
            rowEl.style.display     = 'flex';
        } else {
            rowEl.style.display = 'none';
        }
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
                    a.href = URL.createObjectURL(blob);
                    a.download = 'courtside-victory.png';
                    a.click();
                }
                if (window.Haptic) Haptic.success();
            }, 'image/png');
        } catch (e) { console.error('Victory share failed:', e); }
    },
};

// =============================================================================
// PLAYER MODE — boot controller for ?role=player
//
// FOUR BUGS FIXED:
//   Bug 1 (Stuck Request): _onApprovalReceived catches 'session_joined' broadcast,
//          matches UUID, saves token to sessionStorage, flips UI to active.
//   Bug 2 (Blind Player):  _onGameStateUpdate catches 'game_state' broadcast,
//          updates live feed in real-time. Queue position computed precisely.
//   Bug 3 (Name Revert):   passportRename writes localStorage FIRST, then calls
//          broadcastNameUpdate so host receives the change via broadcast.
//   Bug 4 (Win Counter):   _onMatchResult catches 'match_result' broadcast,
//          strict UUID equality, localStorage written before any UI update.
// =============================================================================

// Storage keys
const LS_TOKENS = 'cs_session_tokens';  // { roomCode: { token, approvedAt } }
const SS_APPROVED = 'cs_approved';      // sessionStorage — { roomCode: true }

const PlayerMode = {

    _joinCode:  null,
    _pollTimer: null,

    // ─────────────────────────────────────────────────────────────────────────
    // BOOT
    // ─────────────────────────────────────────────────────────────────────────

    async boot(passport, joinCode) {
        this._joinCode = joinCode;
        this._renderIdentity(passport);
        this._renderStats(passport);
        const codeEl = document.getElementById('slSessionCode');
        if (codeEl && joinCode) codeEl.textContent = joinCode;

        if (!joinCode) {
            this._promptForCode();
            return;
        }

        // ── BUG 1: Check sessionStorage for in-session approval ────────────
        // sessionStorage survives page refresh but clears when tab closes.
        const ssApproved = this._isApprovedInSession(joinCode);
        if (ssApproved) {
            this.setStatus('approved', `Welcome back, ${passport.playerName}`, 'You\'re in the rotation');
            this._subscribeAndPoll(joinCode, passport);
            return;
        }

        // ── Check localStorage for a persisted token (cross-session) ──────
        const savedToken = this._loadToken(joinCode);
        if (savedToken) {
            const valid = await this._verifyToken(joinCode, savedToken, passport);
            if (valid) {
                // Re-save to sessionStorage for fast refresh
                this._markApprovedInSession(joinCode);
                this.setStatus('approved', `Welcome back, ${passport.playerName}`, 'You\'re in the squad');
                this._subscribeAndPoll(joinCode, passport);
                return;
            } else {
                this._clearToken(joinCode);
            }
        }

        // No token — send fresh join request
        await this._joinSession(passport, joinCode);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // BUG 1: APPROVAL RECEIVED via broadcast 'session_joined'
    // ─────────────────────────────────────────────────────────────────────────

    _onApprovalReceived(payload) {
        const passport = Passport.get();
        if (!passport) return;

        // Strict UUID match — only the approved player reacts
        if (payload.playerUUID !== passport.playerUUID) return;

        // 1. Write sessionStorage BEFORE any render
        this._markApprovedInSession(this._joinCode);

        // 2. Write localStorage token for cross-session persistence
        if (payload.token) {
            this._saveToken(this._joinCode, payload.token, passport.playerName, passport.playerUUID);
        }

        // 3. Update globals with the payload data (squad + matches arrived with approval)
        if (payload.squad)           window.squad          = payload.squad;
        if (payload.current_matches) window.currentMatches = payload.current_matches;

        // 4. Update UI
        this.setStatus('approved', `You're in, ${passport.playerName}!`, 'Added to the rotation ✅');

        // 5. Start full live feed
        this._subscribeAndPoll(this._joinCode, passport);

        // 6. After brief celebration, show real position
        setTimeout(() => this._updateStatus(passport), 1500);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // BUG 2: LIVE MATCH FEED via broadcast 'game_state'
    // ─────────────────────────────────────────────────────────────────────────

    _onGameStateUpdate(payload) {
        const passport = Passport.get();
        if (!passport) return;

        // Globals already updated by sync.js _handleBroadcast before this call
        // Cache next_up for SidelineView._renderNextUp
        if (payload.next_up) window._lastNextUp = payload.next_up;

        // Render match cards
        SidelineView.refresh();

        // Update status
        this._updateStatus(passport);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // BUG 3: SESSION UPDATE via postgres_changes (fallback for heavy sync)
    // ─────────────────────────────────────────────────────────────────────────

    _onSessionUpdate(session) {
        const passport = Passport.get();
        if (!passport) return;

        // Check for approval in DB (fallback if broadcast was missed)
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
        // Globals are already set by applyRemoteState before this call
        SidelineView.refresh();
        this._updateStatus(passport);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // BUG 4: MATCH RESULT via broadcast 'match_result'
    // ─────────────────────────────────────────────────────────────────────────

    _onMatchResult(payload) {
        const passport = Passport.get();
        if (!passport) return;

        const { playerUUID, event } = payload;
        const isMe = playerUUID === passport.playerUUID;

        if (event === 'WIN' && isMe) {
            // 1. Write localStorage FIRST, before any UI
            const updated = Passport.recordWin();
            // 2. Then update stats display
            this._renderStats(updated);
            // 3. Show victory card
            VictoryCard.show(passport.playerName);

        } else if (event === 'LOSS') {
            // Only record loss if this player was actually in the match
            const name = passport.playerName?.toLowerCase();
            const matches = window.currentMatches || [];
            const wasPlaying = matches.some(m =>
                [...(m.teams[0]||[]), ...(m.teams[1]||[])].map(n => n.toLowerCase()).includes(name)
            );
            if (wasPlaying || isMe) {
                // 1. Write localStorage FIRST
                const updated = Passport.recordLoss();
                // 2. Then update UI
                this._renderStats(updated);
            }
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // STATUS CARD — computes current position from live squad/matches
    // ─────────────────────────────────────────────────────────────────────────

    _updateStatus(passport) {
        const name    = passport.playerName?.toLowerCase();
        const squad   = window.squad          || [];
        const matches = window.currentMatches || [];

        const playing = matches.some(m =>
            [...(m.teams[0]||[]), ...(m.teams[1]||[])].map(n => n.toLowerCase()).includes(name)
        );
        const inSquad = squad.some(p => p.name?.toLowerCase() === name);

        // Bench queue: active squad members not currently playing
        const playingNames = new Set(
            matches.flatMap(m => [...(m.teams[0]||[]), ...(m.teams[1]||[])])
                   .map(n => n.toLowerCase())
        );
        const bench = squad.filter(p => p.active && !playingNames.has(p.name?.toLowerCase()));
        const qPos  = bench.findIndex(p => p.name?.toLowerCase() === name);

        // Next Up names from broadcast payload
        const nextUpRaw = window._lastNextUp || '';
        const nextNames = nextUpRaw.split('·').map(s => s.trim().toLowerCase()).filter(Boolean);
        const isNextUp  = name && nextNames.includes(name);

        if (playing) {
            this.setStatus('playing', 'You\'re on court!', 'Give it everything 🏀');
        } else if (isNextUp) {
            this.setStatus('on-deck', 'You\'re on deck!', 'Get ready — you\'re up next 🟡');
        } else if (inSquad && qPos >= 0) {
            const pos = qPos + 1;
            const sfx = pos === 1 ? 'st' : pos === 2 ? 'nd' : pos === 3 ? 'rd' : 'th';
            this.setStatus('resting', `#${pos}${sfx} in line`, `${bench.length} player${bench.length !== 1 ? 's' : ''} on the bench`);
        } else if (inSquad) {
            this.setStatus('resting', 'In the squad', 'Waiting for next rotation');
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // JOIN SESSION (no token, first time)
    // ─────────────────────────────────────────────────────────────────────────

    async _joinSession(passport, joinCode) {
        this.setStatus('pending', 'Joining session…', 'Connecting to ' + joinCode);
        try {
            // Subscribe FIRST — so we catch the approval broadcast
            this._subscribeAndPoll(joinCode, passport);

            let name = passport.playerName;
            if (!name) {
                name = await this._promptName();
                if (!name) return;
                Passport.rename(name);
                this._renderIdentity(Passport.get());
            }

            const res = await fetch('/api/play-request', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ room_code: joinCode, name, player_uuid: passport.playerUUID }),
            });

            if (res.ok) {
                this.setStatus('pending', 'Request sent!', 'Waiting for host to approve…');
            } else {
                this.setStatus('pending', 'Could not join', 'Check the room code and try again');
            }
        } catch(e) {
            this.setStatus('pending', 'Connection failed', 'Check your internet');
            console.error('[PlayerMode] join failed:', e);
        }
    },

    _subscribeAndPoll(joinCode, passport) {
        // Join the Supabase realtime channel via sync.js
        if (typeof joinOnlineSession === 'function') {
            joinOnlineSession(joinCode).catch(() => {});
        }
        // Signal poll as backup (catches signals if WS drops)
        this._startSignalPoll(joinCode, passport);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // SIGNAL POLL — backup for when WS broadcast is missed
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
                // Convert API signal format to broadcast payload format and reuse _onMatchResult
                this._onMatchResult({
                    playerUUID: d.signal.player_uuid,
                    event:      d.signal.event,
                    gameLabel:  d.signal.game_label,
                });
                // Acknowledge
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

    // sessionStorage: survives refresh, clears when tab closes
    _isApprovedInSession(roomCode) {
        try {
            const map = JSON.parse(sessionStorage.getItem(SS_APPROVED) || '{}');
            return !!map[roomCode];
        } catch { return false; }
    },

    _markApprovedInSession(roomCode) {
        try {
            const map = JSON.parse(sessionStorage.getItem(SS_APPROVED) || '{}');
            map[roomCode] = true;
            sessionStorage.setItem(SS_APPROVED, JSON.stringify(map));
        } catch { }
    },

    // localStorage: persists across sessions
    _loadToken(roomCode) {
        try {
            const map = JSON.parse(localStorage.getItem(LS_TOKENS) || '{}');
            return map[roomCode] || null;
        } catch { return null; }
    },

    _saveToken(roomCode, token, name, uuid) {
        try {
            const map = JSON.parse(localStorage.getItem(LS_TOKENS) || '{}');
            map[roomCode] = { token, name, uuid, savedAt: Date.now() };
            localStorage.setItem(LS_TOKENS, JSON.stringify(map));
        } catch { }
    },

    _clearToken(roomCode) {
        try {
            const map = JSON.parse(localStorage.getItem(LS_TOKENS) || '{}');
            delete map[roomCode];
            localStorage.setItem(LS_TOKENS, JSON.stringify(map));
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
            // Hydrate globals
            if (data.session) {
                window.squad          = data.session.squad           || [];
                window.currentMatches = data.session.current_matches || [];
                window._sessionUUIDMap  = data.session.uuid_map         || {};
                window._approvedPlayers = data.session.approved_players || {};
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

    _promptName() {
        return new Promise(resolve => {
            const n = prompt('Enter your name to join:');
            resolve(n ? n.trim() : null);
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