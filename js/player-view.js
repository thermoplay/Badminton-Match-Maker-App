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
    _lastUpdateTS: 0,

    show() {
        this._visible = true;
        const panel = document.getElementById('sidelinePanel');
        if (panel) { 
            panel.style.display = 'flex';
            panel.style.flexDirection = 'column'; 
            this._ensureContainers();
            this._initPullToRefresh();
                this._initNetworkMonitor();
            this.refresh(); 
            this._startStalenessMonitor();
            this._startTimerTick();
        }
    },

    hide() {
        this._visible = false;
        const panel = document.getElementById('sidelinePanel');
        if (panel) panel.style.display = 'none';
    },

    _ensureContainers() {
        if (document.getElementById('slCourtMap')) return;
        const matchesContainer = document.getElementById('slCurrentMatches');
        if (!matchesContainer) return;
        
        const map = document.createElement('div');
        map.id = 'slCourtMap';
        map.className = 'sl-court-map';
        matchesContainer.parentNode.insertBefore(map, matchesContainer);
    },

    switchTab(tab) {
        this._currentTab = tab;
        document.querySelectorAll('.sl-tab').forEach(b => b.classList.toggle('active', b.textContent.toLowerCase().includes(tab)));
        document.getElementById('slViewLive').style.display = tab === 'live' ? 'block' : 'none';
        document.getElementById('slViewProfile').style.display = tab === 'profile' ? 'block' : 'none';
        this.refresh();
    },

    refresh() {
        if (!this._visible) return;
        const passport = Passport.get();
        if (!passport) return;
        this._lastUpdateTS = Date.now();

        const nameEl = document.getElementById('slPassportName');
        if (nameEl) nameEl.textContent = passport.playerName;

        const squad = window.squad || [];
        const squadMap = new Map(squad.map(p => [p.uuid, p]));
        const myUUID = passport.playerUUID;

        this._renderCourtMap(squadMap, myUUID);
        this._renderMatches(squadMap, myUUID);
        this._renderNextUp();
        this._renderLastWinner();
        if (this._currentTab === 'profile') this._renderProfile(squadMap, myUUID);
    },

    _startStalenessMonitor() {
        if (this._stalenessTimer) clearInterval(this._stalenessTimer);
        this._stalenessTimer = setInterval(() => {
            if (!this._visible || this._lastUpdateTS === 0) return;
            
            const secondsStale = (Date.now() - this._lastUpdateTS) / 1000;
            const container = document.getElementById('slCurrentMatches');
            const netIcon = document.getElementById('slNetworkIcon');

            if (secondsStale > 30) {
                if (container) container.classList.add('sl-stale-data');
                if (netIcon) netIcon.className = 'sl-network-icon weak';
            } else {
                if (container) container.classList.remove('sl-stale-data');
            }
        }, 5000);
    },

    _startTimerTick() {
        if (this._tickTimer) clearInterval(this._startTimerTick);
        this._tickTimer = setInterval(() => {
            if (!this._visible) return;
            const matches = window.currentMatches || [];
            matches.forEach((m, i) => {
                if (!m.startedAt || m.winnerTeamIndex !== null) return;
                const el = document.querySelector(`[data-timer-id="${i}"]`);
                if (!el) return;
                
                const elapsed = Math.floor((Date.now() - m.startedAt) / 1000);
                const min = Math.floor(elapsed / 60);
                const sec = elapsed % 60;
                el.textContent = `⏱ ${min}:${sec.toString().padStart(2, '0')}`;
                el.classList.toggle('sl-timer-warn', min >= 10);
                el.classList.toggle('sl-timer-alert', min >= 15);
            });
        }, 1000);
    },

    _esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    },

    /**
     * Visual Court Map: Renders a high-level grid of active courts
     * using player profile icons for instant recognition.
     */
    _renderCourtMap(squadMap, myUUID) {
        const container = document.getElementById('slCourtMap');
        if (!container) return;

        const matches = window.currentMatches || [];
        if (matches.length === 0 || this._currentTab !== 'live') {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';

        // Defensive: Reconstruct data if not provided (direct call safety)
        if (!squadMap) {
            const squad = window.squad || [];
            squadMap = new Map(squad.map(p => [p.uuid, p]));
            const p = Passport.get();
            myUUID = p ? p.playerUUID : null;
        }

        const findP = (uuid) => squadMap.get(uuid);

        const fragment = document.createDocumentFragment();
        const existingMiniCourts = new Map();
        container.querySelectorAll('.sl-mini-court').forEach(court => {
            const idx = parseInt(court.dataset.idx, 10);
            if (!isNaN(idx)) existingMiniCourts.set(idx, court);
        });

        matches.forEach((m, i) => {
            const tA = (m.teams[0] || []).map(u => findP(u)).filter(Boolean);
            const tB = (m.teams[1] || []).map(u => findP(u)).filter(Boolean);
            
            const renderIcons = (team) => team.map(p => Avatar.html(p.name, p.spiritAnimal)).join('');
            const isPlaying = myUUID && m.teams.flat().includes(myUUID);

            const courtContent = `
                <div class="sl-mini-team">${renderIcons(tA)}</div>
                <div class="sl-mini-net"></div>
                <div class="sl-mini-team">${renderIcons(tB)}</div>
                <div class="sl-mini-label">${i + 1}</div>
            `;
            const courtClasses = `sl-mini-court ${isPlaying ? 'active' : ''}`;

            let court = existingMiniCourts.get(i);

            if (court) {
                if (court.className !== courtClasses) {
                    court.className = courtClasses;
                }
                if (court.innerHTML.trim() !== courtContent.trim()) {
                    court.innerHTML = courtContent;
                }
                existingMiniCourts.delete(i);
            } else {
                const newCourt = document.createElement('div');
                newCourt.className = courtClasses;
                newCourt.dataset.idx = i;
                newCourt.innerHTML = courtContent;
                newCourt.onclick = () => SidelineView.openMatchPreview(i);
                fragment.appendChild(newCourt);
            }
        });

        existingMiniCourts.forEach(court => court.remove());
        if (fragment.children.length > 0) {
            container.appendChild(fragment);
        }
    },

    _renderMatches(squadMap, myUUID) {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;

        // Guard: don't overwrite queued-state or name-entry UI during join flow
        if (container.querySelector('.sl-queued-state') ||
            container.querySelector('.sl-name-entry') ||
            container.querySelector('.sl-code-entry')) return;

        const matches = window.currentMatches || [];
        if (matches.length === 0) {
            const emptyMessage = `<div class="sl-empty">No active round yet</div>`;
            if (container.innerHTML.trim() !== emptyMessage.trim()) {
                container.innerHTML = emptyMessage;
            }
            return;
        }

        const courtNames = window.courtNames || {};

        // Defensive: Reconstruct data if not provided (direct call safety)
        if (!squadMap) {
            const squad = window.squad || [];
            squadMap = new Map(squad.map(p => [p.uuid, p]));
            const p = Passport.get();
            myUUID = p ? p.playerUUID : null;
        }

        const findP = (uuid) => squadMap.get(uuid);

        const fragment = document.createDocumentFragment();
        const existingMatchCards = new Map();
        container.querySelectorAll('.sl-match-card').forEach(card => {
            const idx = parseInt(card.dataset.idx, 10);
            if (!isNaN(idx)) existingMatchCards.set(idx, card);
        });

        matches.forEach((m, i) => {
            const teams = m.teams || [];
            const tA_uuids = teams[0] || [];
            const tB_uuids = teams[1] || [];
            const playing = myUUID && [...tA_uuids, ...tB_uuids].includes(myUUID);
            const storyBadges = m.storyBadges || [];
            const winIdx = m.winnerTeamIndex;
            const courtName = courtNames[i] || `COURT ${i + 1}`;
            const hasWinner = winIdx !== null && winIdx !== undefined;
            const safeNames = (uuids) => uuids.map(u => this._esc(findP(u)?.name || 'Unknown')).join(' &amp; ');
            const timerHTML = m.startedAt ? `<span class="sl-court-timer" data-timer-id="${i}">⏱ 0:00</span>` : '';
            const winnerBanner = hasWinner ? `<div class="sl-winner-banner">🏆 ${safeNames(teams[winIdx] || [])} won</div>` : '';
            const aClass = hasWinner ? (winIdx === 0 ? 'sl-team sl-team-won' : 'sl-team sl-team-lost') : 'sl-team';
            const bClass = hasWinner ? (winIdx === 1 ? 'sl-team sl-team-won' : 'sl-team sl-team-lost') : 'sl-team';

            const cardContent = `
                <div class="sl-match-header">
                    <div class="sl-match-label">${courtName}${playing ? ' · <span class="sl-you-badge">YOU</span>' : ''}</div>
                    ${storyBadges.length ? `<div class="sl-story-badges">${storyBadges.map(b => `<span>${this._esc(b)}</span>`).join('')}</div>` : ''}
                    ${timerHTML}
                </div>
                <div class="sl-match-teams">
                    <div class="sl-team-col">
                        <span class="${aClass}">${safeNames(tA_uuids)}</span>
                    </div>
                    <span class="sl-vs">VS</span>
                    <div class="sl-team-col">
                        <span class="${bClass}">${safeNames(tB_uuids)}</span>
                    </div>
                </div>
                ${winnerBanner}
                ${playing && !hasWinner ? `
                <button class="sl-share-match-btn" onclick="event.stopPropagation(); slShareMatch(${i})">
                    📲 Share this matchup
                </button>` : ''}
            `;
            const cardClasses = `sl-match-card ${playing ? 'sl-match-mine' : ''} ${hasWinner ? 'sl-match-decided' : ''}`;

            let card = existingMatchCards.get(i);
            if (card) {
                if (card.className !== cardClasses) card.className = cardClasses;
                if (card.innerHTML.trim() !== cardContent.trim()) card.innerHTML = cardContent;
                existingMatchCards.delete(i);
            } else {
                const newCard = document.createElement('div');
                newCard.className = cardClasses;
                newCard.dataset.idx = i;
                newCard.innerHTML = cardContent;
                newCard.onclick = () => SidelineView.openMatchPreview(i);
                fragment.appendChild(newCard);
            }
        });

        existingMatchCards.forEach(card => card.remove());
        if (fragment.children.length > 0) container.appendChild(fragment);
    },

    openMatchPreview(idx) {
        const match = (window.currentMatches || [])[idx];
        if (!match) return;
        const squad = window.squad || [];
        const passport = Passport.get();
        const myUUID = passport?.playerUUID;

        // Helpers to get stats
        const getStats = (teamUUIDs) => {
            const players = teamUUIDs.map(id => squad.find(p => p.uuid === id)).filter(Boolean);
            if (players.length === 0) return { wr: 0, streak: 0, games: 0 };
            
            const totalWins = players.reduce((sum, p) => sum + p.wins, 0);
            const totalGames = players.reduce((sum, p) => sum + p.games, 0);
            const avgStreak = Math.round(players.reduce((sum, p) => sum + p.streak, 0) / players.length);
            const wr = totalGames > 0 ? Math.round((totalWins / totalGames) * 100) : 0;
            
            return { wr, streak: avgStreak, games: totalGames, count: players.length };
        };

        const tA = match.teams[0];
        const tB = match.teams[1];
        const statsA = getStats(tA);
        const statsB = getStats(tB);
        const odds = match.odds || [50, 50];

        const renderNames = (arr) => arr.map(uuid => {
            const p = squad.find(x => x.uuid === uuid);
            const name = p ? p.name : 'Unknown';
            const isMe = myUUID && uuid === myUUID;
            return isMe ? `<strong style="color: var(--accent);">${this._esc(name)}</strong>` : this._esc(name);
        }).join('<br>&amp;<br>');

        const html = `
            <div class="sl-tape-content">
                <div class="sl-tape-teams">
                    <div class="sl-tape-team">
                        <div class="sl-tape-name">${renderNames(tA)}</div>
                    </div>
                    <div class="sl-tape-vs">VS</div>
                    <div class="sl-tape-team">
                        <div class="sl-tape-name">${renderNames(tB)}</div>
                    </div>
                </div>

                <div class="sl-tape-row">
                    <div class="sl-tape-val ${odds[0] > odds[1] ? 'win' : ''}">${odds[0]}%</div>
                    <div class="sl-tape-label">Win Probability</div>
                    <div class="sl-tape-val ${odds[1] > odds[0] ? 'win' : ''}">${odds[1]}%</div>
                </div>

                <div class="sl-tape-row">
                    <div class="sl-tape-val ${statsA.wr > statsB.wr ? 'win' : ''}">${statsA.wr}%</div>
                    <div class="sl-tape-label">Win Rate</div>
                    <div class="sl-tape-val ${statsB.wr > statsA.wr ? 'win' : ''}">${statsB.wr}%</div>
                </div>

                <div class="sl-tape-row">
                    <div class="sl-tape-val">${statsA.streak}</div>
                    <div class="sl-tape-label">Current Streak</div>
                    <div class="sl-tape-val ${statsB.streak > statsA.streak ? 'win' : ''}">${statsB.streak}</div>
                </div>

                <div class="sl-tape-row">
                    <div class="sl-tape-val">${Math.round(statsA.games / statsA.count)}</div>
                    <div class="sl-tape-label">Avg Experience</div>
                    <div class="sl-tape-val">${Math.round(statsB.games / statsB.count)}</div>
                </div>
            </div>
        `;

        const contentEl = document.getElementById('slMatchPreviewContent');
        if (contentEl) {
            contentEl.innerHTML = html;
            document.getElementById('slMatchPreviewModal').style.display = 'flex';
            if (window.Haptic) Haptic.tap();
        }
    },

    closeMatchPreview() {
        document.getElementById('slMatchPreviewModal').style.display = 'none';
    },

    showRecap(recapData) {
        const modal = document.getElementById('slRecapModal');
        const content = document.getElementById('slRecapContent');
        if (!modal || !content || !recapData) return;

        const { totalGames, mvp, ironMan, hotHand, sharpShooter, squad = [] } = recapData;

        content.innerHTML = `
            <div class="sl-recap-item">
                <span class="sl-recap-val">${totalGames}</span>
                <span class="sl-recap-label">Total Games Played</span>
            </div>
            <div class="sl-recap-item" style="border-color:var(--accent); background:var(--accent-dim);">
                <div style="font-size:0.6rem; color:var(--accent); font-weight:900; letter-spacing:2px; margin-bottom:4px;">SESSION MVP</div>
                <span class="sl-recap-val" style="font-size:1.8rem;">${this._esc(mvp.name)}</span>
                <span class="sl-recap-label" style="color:var(--text);">${mvp.wins} Wins · ${mvp.games} Games</span>
                <button class="sl-share-match-btn" style="margin-top:12px; background:var(--accent); color:#000;" onclick="PlayerMode.shareMVPPoster()">📲 SHARE MVP POSTER</button>
            </div>
            <div class="sl-section-label" style="margin-top:14px;">🏅 SESSION RECORDS</div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px;">
                <div class="sl-recap-item" style="padding:12px;">
                    <div style="font-size:0.5rem; font-weight:800; color:var(--text-muted); text-transform:uppercase;">IRON MAN</div>
                    <div style="font-size:0.8rem; font-weight:700; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this._esc(ironMan.name)}</div>
                    <div style="font-size:0.6rem; color:var(--text-muted);">${ironMan.sessionPlayCount} Games</div>
                </div>
                <div class="sl-recap-item" style="padding:12px;">
                    <div style="font-size:0.5rem; font-weight:800; color:var(--text-muted); text-transform:uppercase;">HOT HAND</div>
                    <div style="font-size:0.8rem; font-weight:700; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this._esc(hotHand.name)}</div>
                    <div style="font-size:0.6rem; color:var(--text-muted);">${hotHand.streak} Win Streak</div>
                </div>
            </div>
            <div class="sl-section-label" style="margin-top:14px;">📊 FINAL STANDINGS</div>
            <div style="margin-top:10px; background:var(--surface2); border-radius:12px; border:1px solid var(--border); padding:0 12px;">
                ${squad.slice(0, 5).map((p, i) => `
                    <div style="display:flex; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid var(--border);">
                        <div style="font-family:var(--font-display); font-weight:900; color:var(--accent); width:16px;">${i+1}</div>
                        <div style="flex:1; font-size:0.8rem; font-weight:600;">${this._esc(p.name)}</div>
                        <div style="font-family:var(--font-display); font-weight:800; color:var(--text);">${p.wins}W</div>
                    </div>
                `).join('')}
            </div>
        `;

        this._lastRecap = recapData;
        modal.style.display = 'flex';
    },

    _renderNextUp() {
        const el    = document.getElementById('slNextUp');
        const rowEl = document.getElementById('slNextUpRow');
        if (!el || !rowEl) return;
        const text = window._lastNextUp || '';
        if (!text) { rowEl.style.display = 'none'; return; }

        // Parse names and render with avatars if Avatar is available
        if (window.Avatar) {
            const names = text.split(/\s*[,&]\s*/).map(n => n.trim()).filter(Boolean);
            const newHTML = names.map(name =>
                `<span class="sl-next-avatar-chip">
                    <span class="sl-next-avatar" style="background:${Avatar.color(name)}">${this._esc(Avatar.initials(name))}</span>
                    <span class="sl-next-name">${this._esc(name)}</span>
                </span>`
            ).join('<span class="sl-next-sep">·</span>');
            if (el.innerHTML.trim() !== newHTML.trim()) {
                el.innerHTML = newHTML;
            }
        } else {
            if (el.textContent.trim() !== text.trim()) {
                el.textContent = text;
            }
        }
        rowEl.style.display = 'flex';
    },

    _renderLastWinner() {
        const el    = document.getElementById('slLastWinner');
        const rowEl = document.getElementById('slLastWinnerRow');
        if (!el || !rowEl) return;
        if (window._lastMatchWinner) {
            if (el.textContent.trim() !== window._lastMatchWinner.trim()) {
                el.textContent      = window._lastMatchWinner;
            }
            rowEl.style.display = 'flex';
        } else {
            rowEl.style.display = 'none';
        }
    },

    _renderProfile(squadMap, myUUID) {
        const passport = Passport.get();
        if (!passport) return;

        // Defensive: If squadMap wasn't provided (e.g. direct call), 
        // reconstruct it from current global state.
        if (!squadMap) {
            const squad = window.squad || [];
            squadMap = new Map(squad.map(p => [p.uuid, p]));
            myUUID = passport.playerUUID;
        }

        const me = squadMap.get(myUUID);
        const profileView = document.getElementById('slViewProfile');
        if (!profileView) return;

        // --- 1. Enhanced Identity Header ---
        let header = document.getElementById('slProfileHeaderEnhanced');
        if (!header) {
            header = document.createElement('div');
            header.id = 'slProfileHeaderEnhanced';
            profileView.insertBefore(header, profileView.firstChild);
            
            // Hide legacy header elements if they exist
            ['slProfileName', 'slProfileAvatar', 'slProfileStats'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = 'none';
            });
        }

        // Determine Player Title
        const getTitle = (p) => {
            if (!p) return { title: 'Newcomer', icon: '👋' };
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
            return { title: 'The Veteran', icon: '🏅' };
        };

        const titleData = getTitle(me);
        const avatarColor = window.Avatar ? Avatar.color(passport.playerName) : '#666';
        const avatarInitial = (passport.playerName || '?').charAt(0).toUpperCase();
        const emoji = passport.spiritAnimal || '';

        // Calculate Trophy Counts (Gold, Silver, Bronze Tiers)
        // ALWAYS merge session achievements with all-time passport achievements
        const myAch = [...new Set([
            ...(me?.achievements || []), 
            ...(passport.achievements || [])
        ])];

        const counts = { gold: 0, silver: 0, bronze: 0 };
        if (window.Achievements) {
            Object.keys(window.Achievements).forEach(key => {
                const def = window.Achievements[key];
                if (def.tiers) {
                    def.tiers.forEach(tier => {
                        if (myAch.includes(`${key}_${tier.id}`)) {
                            if (tier.color === '#ffd700') counts.gold++;
                            else if (tier.color === '#c0c0c0') counts.silver++;
                            else if (tier.color === '#cd7f32') counts.bronze++;
                        }
                    });
                }
            });
        }

        const newHeaderHTML = `
            <div class="sl-profile-card">
                <div class="sl-profile-top-left">
                    <button class="sl-icon-btn" onclick="PlayerMode.pickSpiritAnimal()" title="Set Spirit Animal">${emoji || '🐾'}</button>
                </div>
                <div class="sl-profile-top-right">
                    <button class="sl-icon-btn" onclick="passportRename()" title="Edit Name">✏️</button>
                </div>
                <div class="sl-profile-avatar-large" style="background:${avatarColor}; font-style: ${emoji ? 'normal' : 'italic'};">
                    ${emoji || avatarInitial}
                    ${me && me.streak >= 3 ? `<div class="sl-streak-ring"></div>` : ''}
                </div>
                <div class="sl-profile-name-large">${this._esc(passport.playerName)}</div>
                <div class="sl-profile-title-badge">
                    <span>${titleData.icon}</span>
                    <span>${titleData.title}</span>
                </div>
                <div class="sl-trophy-tally" style="display:flex; gap:12px; margin-top:14px; padding:8px 16px; background:var(--bg2); border-radius:12px; border:1px solid var(--border);">
                    <div style="display:flex; align-items:center; gap:4px;" title="Gold Trophies">
                        <span style="color:#ffd700; font-size:0.9rem;">🥇</span>
                        <span style="font-family:var(--font-display); font-size:1rem; font-weight:800; color:#ffd700; line-height:1;">${counts.gold}</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:4px;" title="Silver Trophies">
                        <span style="color:#c0c0c0; font-size:0.9rem;">🥈</span>
                        <span style="font-family:var(--font-display); font-size:1rem; font-weight:800; color:#c0c0c0; line-height:1;">${counts.silver}</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:4px;" title="Bronze Trophies">
                        <span style="color:#cd7f32; font-size:0.9rem;">🥉</span>
                        <span style="font-family:var(--font-display); font-size:1rem; font-weight:800; color:#cd7f32; line-height:1;">${counts.bronze}</span>
                    </div>
                </div>
            </div>`;
        if (header.innerHTML.trim() !== newHeaderHTML.trim()) {
            header.innerHTML = newHeaderHTML;
        }

        // --- 2. Status Toggle (Ready / Resting) ---
        let statusToggle = document.getElementById('slStatusToggleCard');
        if (!statusToggle) {
            statusToggle = document.createElement('div');
            statusToggle.id = 'slStatusToggleCard';
            // Insert after header
            if (header.nextSibling) profileView.insertBefore(statusToggle, header.nextSibling);
            else profileView.appendChild(statusToggle);
        }
        
        const isActive = me ? me.active : true;
        const newStatusToggleHTML = `
            <div class="sl-toggle-icon">${isActive ? '🏸' : '☕'}</div>
            <div class="sl-toggle-info">
                <div class="sl-toggle-label">${isActive ? 'I\'M READY TO PLAY' : 'I\'M TAKING A BREAK'}</div>
                <div class="sl-toggle-sub">${isActive ? 'Included in next rotation' : 'Skipping next rounds'}</div>
            </div>
            <div class="sl-toggle-switch">
                <div class="sl-toggle-knob"></div>
            </div>
        `;
        if (statusToggle.className !== `sl-status-toggle-card ${isActive ? 'active' : 'resting'}`) {
            statusToggle.className = `sl-status-toggle-card ${isActive ? 'active' : 'resting'}`;
        }
        if (statusToggle.innerHTML.trim() !== newStatusToggleHTML.trim()) {
            statusToggle.innerHTML = newStatusToggleHTML;
            statusToggle.onclick = () => PlayerMode.toggleStatus(isActive); // Re-attach listener if content changes
        }

        // Render Stats Deck (Session + Career)
        let deck = document.getElementById('slStatsDeck');
        
        if (!deck && profileView) {
            deck = document.createElement('div');
            deck.id = 'slStatsDeck';
            // Insert before achievements container
            const ach = document.getElementById('slProfileAchievements');
            if (ach) profileView.insertBefore(deck, ach);
            else profileView.appendChild(deck);
        }

        let analyticsContainer = document.getElementById('slProfileAnalytics');
        if (!analyticsContainer && profileView) {
            analyticsContainer = document.createElement('div');
            analyticsContainer.id = 'slProfileAnalytics';
            const chem = document.getElementById('slProfileChemistry');
            if (chem) profileView.insertBefore(analyticsContainer, chem);
            else profileView.appendChild(analyticsContainer);
        }

        let chemContainer = document.getElementById('slProfileChemistry');
        if (!chemContainer && profileView) {
            chemContainer = document.createElement('div');
            chemContainer.id = 'slProfileChemistry';
            const ach = document.getElementById('slProfileAchievements');
            if (ach) profileView.insertBefore(chemContainer, ach);
            else profileView.appendChild(chemContainer);
        }

        if (deck) {
            const career = passport.stats || { wins: 0, games: 0 };
            const cWins  = career.wins || 0;
            const cGames = career.games || 0;
            const cWr    = cGames > 0 ? Math.round((cWins / cGames) * 100) : 0;
            const skillLevel = me ? me.skillLevel : (passport.skillLevel || 'Intermediate');
            
            let sWins = 0, sGames = 0, sWr = 0;
            if (me) {
                sWins = me.wins;
                sGames = me.games;
                sWr = sGames > 0 ? Math.round((sWins / sGames) * 100) : 0;
            }

            const newDeckHTML = `
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
                                <div class="sl-card-key">SESSION WR</div>
                                <div class="sl-wr-track">
                                    <div class="sl-wr-bar" style="width:${sWr}%"></div>
                                </div>
                            </div>
                        </div>` : `<div class="sl-card-empty">Not in a session</div>`}
                    </div>

                    <div class="sl-stat-card">
                        <div class="sl-card-label">CAREER RECORD</div>
                        <div class="sl-card-grid">
                            <div class="sl-card-item">
                                <div class="sl-card-val">${cGames}</div>
                                <div class="sl-card-key">TOTAL GAMES</div>
                            </div>
                            <div class="sl-card-item">
                                <div class="sl-card-val">${cWr}%</div>
                                <div class="sl-card-key">WIN RATE</div>
                            </div>
                            <div class="sl-card-item">
                                <div class="sl-card-val" style="font-size:1.2rem;">${skillLevel}</div>
                                <div class="sl-card-key">SKILL LEVEL</div>
                            </div>
                        </div>
                    </div>
                </div>`;
            if (deck.innerHTML.trim() !== newDeckHTML.trim()) {
                deck.innerHTML = newDeckHTML;
            }
        }

        if (analyticsContainer && me) {
            // Rival Logic
            let rivalName = 'None yet';
            let rivalCount = 0;
            if (me.opponentHistory) {
                const rivals = Object.entries(me.opponentHistory).sort(([,a], [,b]) => b - a);
                if (rivals.length > 0) {
                    const rivalP = squadMap.get(rivals[0][0]);
                    rivalName = rivalP ? rivalP.name : 'Unknown';
                    rivalCount = rivals[0][1];
                }
            }

            // Form Logic
            const formHTML = (me.form || []).map(r => 
                `<span style="display:inline-block; width:20px; height:20px; border-radius:50%; background:${r==='W'?'var(--accent)':'rgba(239,68,68,0.2)'}; color:${r==='W'?'#000':'#ef4444'}; font-size:0.6rem; font-weight:800; text-align:center; line-height:20px; margin:0 2px;">${r}</span>`
            ).join('');

            // Performance Lab: History List with UUID name resolution
            let historyHTML = '';
            if (me.matchHistory && me.matchHistory.length > 0) {
                historyHTML = `
                    <div class="sl-lab-history" style="margin-top:12px;">
                        ${me.matchHistory.map(h => {
                            const oppNames = (h.oppUUIDs || []).map(id => {
                                const p = squadMap.get(id);
                                return p ? this._esc(p.name) : 'Former Player';
                            }).join(' &amp; ');
                            
                            let partnerDisplay = '';
                            if (h.partnerUUID) {
                                const partnerP = squadMap.get(h.partnerUUID);
                                if (partnerP) {
                                    partnerDisplay = ` with ${this._esc(partnerP.name)}`;
                                }
                            }
                            const timeAgo = Math.floor((Date.now() - h.time) / 60000);
                            const timeStr = timeAgo < 1 ? 'Just now' : `${timeAgo}m ago`;
                            return `
                                <div class="sl-hist-item ${h.win ? 'sl-hist-win' : 'sl-hist-loss'}">
                                    <div class="sl-hist-badge">${h.win ? 'W' : 'L'}</div>
                                    <div class="sl-hist-details">
                                        <div class="sl-hist-label">${h.win ? 'Victory' : 'Defeat'}</div>
                                        <div class="sl-hist-opp">${partnerDisplay} vs ${oppNames}</div>
                                    </div>
                                    <div class="sl-hist-time">${timeStr}</div>
                                </div>`;
                        }).join('')}
                    </div>`;
            }

            const newAnalyticsHTML = `
                <div class="sl-section-label sl-section-lab" style="margin-top:24px;">
                    <span class="sl-dot-lab">📊</span> PERFORMANCE LAB
                    <span class="sl-lab-badge">SESSION LOG</span>
                </div>
                <div style="background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:16px; display:flex; justify-content:space-between; align-items:center;">
                    <div style="text-align:center; flex:1;">
                        <div style="font-size:0.6rem; color:var(--text-muted); font-weight:700; margin-bottom:6px; letter-spacing:1px;">RECENT FORM</div>
                        <div>${formHTML || '<span style="color:var(--text-muted); font-size:0.8rem;">-</span>'}</div>
                    </div>
                    <div style="width:1px; height:30px; background:var(--border);"></div>
                    <div style="text-align:center; flex:1;">
                        <div style="font-size:0.6rem; color:var(--text-muted); font-weight:700; margin-bottom:4px; letter-spacing:1px;">BIGGEST RIVAL</div>
                        <div style="font-size:0.9rem; font-weight:700;">${this._esc(rivalName)}</div>
                        <div style="font-size:0.65rem; color:var(--text-muted);">${rivalCount} games</div>
                    </div>
                </div>
                ${historyHTML}`;
            if (analyticsContainer.innerHTML.trim() !== newAnalyticsHTML.trim()) {
                analyticsContainer.innerHTML = newAnalyticsHTML;
            }
        }

        this._renderH2H(profileView, me, squadMap);

        if (chemContainer) {
            let newChemHTML = '';
            if (me && me.partnerStats && Object.keys(me.partnerStats).length > 0) {
                const partners = Object.entries(me.partnerStats);
                partners.sort(([, a], [, b]) => {
                    if (b.wins !== a.wins) return b.wins - a.wins;
                    return b.games - a.games;
                });
                const best = partners[0];
                if (best) {
                    const [uuid, stats] = best;
                    const partnerP = squadMap.get(uuid);
                    const wr = stats.games > 0 ? Math.round((stats.wins / stats.games) * 100) : 0;
                    newChemHTML = `
                        <div class="sl-section-label" style="margin-top:24px;">🤝 PARTNER CHEMISTRY</div>
                        <div class="sl-chem-card">
                            <div class="sl-chem-details">
                                <div class="sl-chem-name">Best with: <strong>${this._esc(partnerP ? partnerP.name : 'Unknown')}</strong></div>
                                <div class="sl-chem-stats">${stats.wins}W - ${stats.games - stats.wins}L (${wr}%)</div>
                            </div>
                        </div>`;
                }
            }
            if (chemContainer.innerHTML.trim() !== newChemHTML.trim()) {
                chemContainer.innerHTML = newChemHTML;
            }
        }

        // Render Achievements List
        let achLabel = document.getElementById('slProfileAchLabel');
        if (!achLabel && profileView) {
            achLabel = document.createElement('div');
            achLabel.id = 'slProfileAchLabel';
            achLabel.className = 'sl-section-label';
            achLabel.style.marginTop = '24px';
            const achList = document.getElementById('slProfileAchievements');
            if (achList) profileView.insertBefore(achLabel, achList);
        }
        if (achLabel) {
            const newAchLabelHTML = `
                <span>🏆 ACHIEVEMENTS</span>
                <button class="sl-rename-btn" style="margin-left:auto; font-size:0.6rem;" onclick="PlayerMode.openTrophyRoom()">
                    VIEW TROPHY ROOM →
                </button>
            `;
            if (achLabel.innerHTML.trim() !== newAchLabelHTML.trim()) {
                achLabel.innerHTML = newAchLabelHTML;
            }
        }

        const container = document.getElementById('slProfileAchievements');
        if (container && window.Achievements) {
            const myAch = [...new Set([
                ...(me?.achievements || []), 
                ...(passport.achievements || [])
            ])];
            const html = Object.keys(window.Achievements).map(key => {
                const data = window.getAchievementDisplay(key, myAch);
                const unlocked = data.unlocked;
                const safeName = this._esc(data.name);
                const safeDesc = this._esc(data.description);
                const statusClass = unlocked ? 'unlocked' : 'locked';
                const tapAction = `showSessionToast('${unlocked ? '🏆' : '🔒'} ${safeName}: ${safeDesc}')`;
                
                return `
                    <div class="sl-achievement-badge ${statusClass}" onclick="${tapAction}" style="${unlocked ? `border-color:${data.color}; box-shadow: 0 0 10px ${data.color}44;` : ''}"
                         onmousedown="startAchPress('${key}', '${passport.playerUUID}')" onmouseup="endAchPress()"
                         ontouchstart="startAchPress('${key}', '${passport.playerUUID}')" ontouchend="endAchPress()"
                         oncontextmenu="event.preventDefault(); return false;">
                        <div class="sl-ach-icon-large">${data.icon}</div>
                        <div class="sl-ach-label">${safeName}</div>
                    </div>
                `;
            }).join('');
            if (container.className !== 'sl-achievements-grid') {
                container.className = 'sl-achievements-grid';
            }
            if (container.innerHTML.trim() !== html.trim()) {
                container.innerHTML = html;
            }
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
            leaveBtn.textContent = 'End Session';
            leaveBtn.onclick = () => PlayerMode.confirmEndSession();

            const hint = document.createElement('p');
            hint.className = 'sl-leave-hint';
            hint.textContent = 'You will be removed from the rotation. You can rejoin later.';

            supportSection.appendChild(leaveBtn);
            supportSection.appendChild(hint);
            actionsEl.appendChild(supportSection);
            profileView.appendChild(actionsEl);
        }
    },

    _renderH2H(profileView, me, squadMap) {
        if (!me) return;
        let container = document.getElementById('slProfileH2H');
        if (!container) {
            container = document.createElement('div');
            container.id = 'slProfileH2H';
            container.className = 'sl-h2h-section';
            
            // Try to insert before the Achievements section (Label + List)
            const achList = document.getElementById('slProfileAchievements');
            let anchor = achList;
            if (achList && achList.previousElementSibling && 
                achList.previousElementSibling.classList.contains('sl-section-label') &&
                achList.previousElementSibling.textContent.includes('ACHIEVEMENTS')) {
                anchor = achList.previousElementSibling;
            }

            if (anchor) profileView.insertBefore(container, anchor);
            else profileView.appendChild(container);
        }

        const select = document.getElementById('slH2HSelect');
        const selectedVal = select ? select.value : '';

        const others = Array.from(squadMap.values()).filter(p => p.uuid !== me.uuid).sort((a,b) => a.name.localeCompare(b.name));

        const newH2HHTML = `
            <div class="sl-section-label">⚔️ HEAD TO HEAD</div>
            <div class="sl-h2h-select-wrap">
                <select id="slH2HSelect" class="sl-h2h-select" onchange="SidelineView._renderH2HStats()">
                    <option value="" disabled ${selectedVal ? '' : 'selected'}>Compare with...</option>
                    ${others.map(p => `<option value="${p.uuid}" ${p.uuid === selectedVal ? 'selected' : ''}>${this._esc(p.name)}</option>`).join('')}
                </select>
                <div class="sl-h2h-arrow">▼</div>
            </div>
            <div id="slH2HStats"></div>
        `;
        if (container.innerHTML.trim() !== newH2HHTML.trim()) {
            container.innerHTML = newH2HHTML;
        }
        
        if (selectedVal) this._renderH2HStats();
    },

    _renderH2HStats() {
        const select = document.getElementById('slH2HSelect');
        const container = document.getElementById('slH2HStats');
        if (!select || !container) return;
        
        const targetUUID = select.value;
        if (!targetUUID) { container.innerHTML = ''; return; }

        const passport = Passport.get();
        const me = (window.squad || []).find(p => p.uuid === passport.playerUUID);
        if (!me) return;

        const vsGames = (me.opponentHistory || {})[targetUUID] || 0;
        const withStats = (me.partnerStats || {})[targetUUID] || { wins: 0, games: 0 };
        const withWr = withStats.games > 0 ? Math.round((withStats.wins / withStats.games) * 100) : 0;

        const newH2HStatsHTML = `
            <div class="sl-h2h-card">
                <div class="sl-h2h-row">
                    <div class="sl-h2h-label">VERSUS (RIVALRY)</div>
                    <div class="sl-h2h-val sl-h2h-vs">${vsGames} <span style="font-size:0.7rem;color:var(--text-muted);font-weight:600;">GAMES</span></div>
                </div>
                <div style="height:1px;background:var(--border);margin:10px 0;"></div>
                <div class="sl-h2h-row">
                    <div class="sl-h2h-label">WITH (CHEMISTRY)</div>
                    <div class="sl-h2h-val sl-h2h-with">${withStats.wins}/${withStats.games} <span style="font-size:0.7rem;color:var(--text-muted);font-weight:600;">(${withWr}%)</span></div>
                </div>
            </div>
        `;
        if (container.innerHTML.trim() !== newH2HStatsHTML.trim()) {
            container.innerHTML = newH2HStatsHTML;
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

    async _performRefresh(silent = false) {
        const start = Date.now();
        const code = window.currentRoomCode || localStorage.getItem('cs_player_room_code');
        const netIcon = document.getElementById('slNetworkIcon');

        if (!code) return;
        try {
            const res = await fetch(`/api/session-get?code=${encodeURIComponent(code)}`);
            if (res.ok) {
                const data = await res.json();
                if (data.session && typeof applyRemoteState === 'function') {
                    applyRemoteState(data.session);
                    if (!silent && typeof showSessionToast === 'function') showSessionToast('Synced');
                }
                if (netIcon && navigator.onLine) {
                    netIcon.className = 'sl-network-icon online';
                    netIcon.title = 'Online';
                }
            } else {
                if (netIcon) {
                    netIcon.className = 'sl-network-icon weak';
                    netIcon.title = 'Connection Weak';
                }
            }
        } catch (e) { 
            console.error('Refresh failed', e); 
            if (netIcon) {
                netIcon.className = 'sl-network-icon weak';
                netIcon.title = 'Connection Weak';
            }
        }
        // UX: Ensure spinner shows for at least 500ms so it doesn't flicker
        const elapsed = Date.now() - start;
        if (elapsed < 500) await new Promise(r => setTimeout(r, 500 - elapsed));
    },

    _initNetworkMonitor() {
        const el = document.getElementById('slNetworkIcon');
        if (!el || el._monitorInit) return;
        el._monitorInit = true;
        
        const update = () => {
            if (navigator.onLine) {
                el.className = 'sl-network-icon online';
                el.title = 'Online';
            } else {
                el.className = 'sl-network-icon offline';
                el.title = 'Offline';
            }
        };
        
        window.addEventListener('online', update);
        window.addEventListener('offline', update);
        update(); // Initial check
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
const LS_APPROVED = 'cs_approved_sessions';

const PlayerMode = {

    _isJoining: false,
    _joinCode:  null,
    _statePollTimer: null,
    _retryInterval: null,
    _joinRetryTimeout: null,
    _isOpenParty: false,

    resetAndTryAgain() {
        this._joinCode = null;
        localStorage.removeItem('cs_player_room_code');
        this._promptForCode();
    },

    confirmEndSession() {
        UIManager.confirm({
            title: 'End Session?',
            message: 'You will be removed from the rotation and see your session results.',
            confirmText: 'End Session',
            isDestructive: true,
            onConfirm: () => {
                const passport = Passport.get();
                const code = this._joinCode || localStorage.getItem('cs_player_room_code') || window.currentRoomCode;

                // 1. Calculate local recap before state is cleared
                const squad = window.squad || [];
                const sorted = [...squad].sort((a,b) => b.wins - a.wins || b.rating - a.rating);
                const mvp = sorted[0] || { name: 'N/A', wins: 0, games: 0 };
                const sortedByGames = [...squad].sort((a,b) => b.sessionPlayCount - a.sessionPlayCount);
                const ironMan = sortedByGames[0] || { name: 'N/A', sessionPlayCount: 0 };
                const sortedByStreak = [...squad].sort((a,b) => b.streak - a.streak);
                const hotHand = sortedByStreak[0] || { name: 'N/A', streak: 0 };

                const recapData = {
                    totalGames: '—',
                    mvp: { name: mvp.name, wins: mvp.wins, games: mvp.games },
                    ironMan: { name: ironMan.name, sessionPlayCount: ironMan.sessionPlayCount },
                    hotHand: { name: hotHand.name, streak: hotHand.streak },
                    sharpShooter: { name: '—', wr: 0 },
                    squad: sorted.slice(0, 10)
                };

                // 2. Notify host that we are leaving
                if (passport && code) {
                    try {
                        if (typeof window.broadcastPlayerLeaving === 'function') {
                            window.broadcastPlayerLeaving(passport.playerUUID, passport.playerName);
                        }
                    } catch (e) {}
                }

                // 3. Clean up local state
                clearInterval(this._statePollTimer);
                this._clearJoinRetryTimer();
                localStorage.removeItem('cs_player_room_code');
                this._clearApprovedInSession(code);
                if (typeof StateStore !== 'undefined') {
                    StateStore.setState({ squad: [], currentMatches: [], playerQueue: [], roundHistory: [] });
                }

                // 4. Show Recap
                SidelineView.showRecap(recapData);
            }
        });
    },

    _onRemovedFromSession() {
        clearInterval(this._statePollTimer);
        localStorage.removeItem('cs_player_room_code');
        this._clearApprovedInSession(this._joinCode);

        // Clear local session data so the landing page (menu) appears on reload
        if (typeof StateStore !== 'undefined') {
            StateStore.setState({ squad: [], currentMatches: [], playerQueue: [], roundHistory: [] });
        }

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
        // Clean up previous state if rebooting with a new code
        this._isJoining = false;
        clearInterval(this._statePollTimer);
        this._clearJoinRetryTimer();

        window.currentMatches = []; // Clear stale matches to ensure a clean UI state

        // 1. Determine room code from URL param or localStorage
        if (!joinCode) {
            try { joinCode = localStorage.getItem('cs_player_room_code') || null; } catch {}
        }

        // Normalize room code early to ensure consistency across all API calls
        if (joinCode) {
            joinCode = joinCode.replace(/[^A-Z0-9]/gi, '').toUpperCase();
            if (joinCode.length === 8) joinCode = joinCode.slice(0, 4) + '-' + joinCode.slice(4);
        }
        this._joinCode = joinCode;

        // Fetch session metadata first to check for Open Party
        let session = null;
        if (joinCode) {
            try {
                const res = await fetch(`/api/session-get?code=${encodeURIComponent(joinCode)}`);
                if (res.ok) {
                    const data = await res.json();
                    session = data.session || {};
                    this._isOpenParty = !!session.is_open_party;
                }
            } catch (e) {}
        }

        // 2. Initial UI setup
        this._bootUI(passport, joinCode);

        // Ensure the sideline panel is unhidden and ready to render matches
        SidelineView.show();

        // 3. If no code, prompt user to enter one and stop.
        if (!joinCode) {
            this._promptForCode();
            return;
        }

        // Check if player is already in the squad or approved to bypass manual check-in
        const inSquad = session && (session.squad || []).some(p => p.uuid === passport.playerUUID);
        const isApproved = this._isApprovedInSession(joinCode);

        // 4. Handle name entry if the player is new
        const hasName = !!(passport.playerName && passport.playerName.trim());
        if (!hasName) {
            const name = await this._handleNewPlayerName();
            if (!name) return; // Player cancelled name entry
            passport = Passport.get(); // Re-fetch passport with new name
        } else if (!inSquad && !isApproved) {
            const action = await this._promptCheckIn(passport, joinCode);
            if (action === 'rename') {
                const name = await this._handleNewPlayerName();
                if (!name) return;
                passport = Passport.get();
            }
            this.setStatus('pending', `Welcome back, ${passport.playerName}`, 'Joining court…');
        } else {
            this.setStatus('pending', `Welcome back, ${passport.playerName}`, 'Reconnecting…');
        }

        // 5. Core join and sync logic
        await this._joinAndSync(passport, joinCode);
    },

    /** Sets up the initial UI elements during boot. */
    _bootUI(passport, joinCode) {
        const panel = document.getElementById('sidelinePanel');
        if (panel) panel.classList.add('sl-booting');

        // Inject menu button into topbar for navigation
        const topbar = document.querySelector('.sl-topbar');
        if (topbar && !document.getElementById('slMenuBtn')) {
            const btn = document.createElement('button');
            btn.id = 'slMenuBtn';
            btn.className = 'sl-icon-btn';
            btn.style.flexShrink = '0';
            btn.innerHTML = '⋮';
            btn.onclick = () => PlayerMode.openNavigation();
            topbar.appendChild(btn);
        }

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

        // PROACTIVE CHECK: Try to fetch session first. If we are already in the squad, 
        // we can skip the join request entirely. This prevents redundant notifications 
        // for players the host has already manually added or approved previously.
        try {
            const [sessionRes, requestRes] = await Promise.all([
                fetch(`/api/session-get?code=${encodeURIComponent(joinCode)}`),
                fetch(`/api/play-request?room_code=${encodeURIComponent(joinCode)}`)
            ]);

            if (sessionRes.ok) {
                const data = await sessionRes.json();
                const session = data.session || {};
                if (data.global) Passport.hydrate(data.global);
                const inSquad = (session.squad || []).some(p => p.uuid === passport.playerUUID);

                this._isOpenParty = !!session.is_open_party;

                if (inSquad) {
                    this._markApprovedInSession(joinCode);
                    console.log('[PlayerMode] Proactive bypass: already in squad.');
                    // Ensure spirit animal is synced on reconnection bypass
                    if (passport.spiritAnimal && typeof broadcastSpiritAnimalUpdate === 'function') {
                        broadcastSpiritAnimalUpdate(passport.playerUUID, passport.spiritAnimal);
                    }
                    this._subscribeAndPoll(joinCode, passport);
                    this.setStatus('approved', `Welcome back, ${passport.playerName}`, "Reconnected ✅");
                    if (panel) panel.classList.remove('sl-booting');
                    SidelineView.show();
                    SidelineView.refresh();
                    setTimeout(() => this._updateStatus(passport), 800);
                    return;
                } else if (requestRes.ok) {
                    // Check if we are already in the pending list to prevent duplicate requests
                    const reqData = await requestRes.json();
                    const isPending = (reqData.requests || []).some(r => r.player_uuid === passport.playerUUID);
                    if (isPending) {
                        console.log('[PlayerMode] Proactive bypass: already in pending requests.');
                        this._subscribeAndPoll(joinCode, passport);
                        this._showQueuedState(passport.playerName);
                        if (panel) panel.classList.remove('sl-booting');
                        return;
                    }
                }
            }
        } catch (e) {}

        // Shortcut: If already approved in this browser session, go straight to live view.
        if (this._isApprovedInSession(joinCode)) {
            if (panel) panel.classList.remove('sl-booting');
            this.setStatus('approved', `Welcome back, ${passport.playerName}`, "You're in the rotation");
            this._subscribeAndPoll(joinCode, passport);
            // Re-sync spirit animal on reload to ensure Host/Spectators have it
            if (passport.spiritAnimal && typeof broadcastSpiritAnimalUpdate === 'function') {
                broadcastSpiritAnimalUpdate(passport.playerUUID, passport.spiritAnimal);
            }
            return;
        }
        
        // Start polling and show a loading state.
        this._subscribeAndPoll(joinCode, passport);
        
        panel?.classList.remove('sl-booting');
        this._clearSearchingSpinner();

        // Atomic Join Request: checks status, inserts request, or confirms active.
        await this._submitJoinRequest(passport, joinCode, {
            statusMessage: this._isOpenParty ? 'Joining Court…' : 'Connecting to court…',
            statusSubMessage: this._isOpenParty ? 'Instant Entry Enabled 🔓' : 'Verifying session'
        });
    },


    // ─────────────────────────────────────────────────────────────────────────
    // QUEUED STATE
    // ─────────────────────────────────────────────────────────────────────────

    _showQueuedState(playerName) {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        const newHTML = `
            <div class="sl-queued-state" id="slQueuedBlock">
                <div class="sl-queued-icon">🏀</div>
                <div class="sl-queued-title">${this._isOpenParty ? 'JOINING NOW' : 'REQUEST SENT'}</div>
                <div class="sl-queued-sub">
                    ${this._isOpenParty 
                        ? 'The court is open. You will be added to the rotation in a few seconds.' 
                        : 'Waiting for the host to approve you.<br>You\'ll be added to the rotation automatically.'}
                </div>
                <div id="slRetryNote" class="sl-retry-note" style="display:none;"></div>
                <button class="sl-queued-resend" id="slResendBtn">Resend Request</button>
                <div class="sl-queued-note">
                    Already approved?
                    <span class="sl-queued-check" id="slCheckBtn">Check now →</span>
                </div>
            </div>`;
        if (container.innerHTML.trim() !== newHTML.trim()) {
            container.innerHTML = newHTML;
        }

        document.getElementById('slResendBtn')?.addEventListener('click', () => PlayerMode._resendRequest());
        document.getElementById('slCheckBtn')?.addEventListener('click',  () => PlayerMode._checkApprovalNow());
    },

    _clearQueuedState() {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        if (container.querySelector('.sl-queued-state')) {
            const emptyMessage = '<div class="sl-empty">No active round yet</div>';
            if (container.innerHTML.trim() !== emptyMessage.trim()) {
                container.innerHTML = emptyMessage;
            }
        }
    },

    async _resendRequest() {
        this._clearJoinRetryTimer();
        const passport = Passport.get();
        if (!passport || !this._joinCode || this._isJoining) return;

        this._isJoining = true;
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
                    spirit_animal: passport.spiritAnimal,
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
        } finally {
            this._isJoining = false;
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
                if (result.global) Passport.hydrate(result.global);
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
        const esc = (s) => (typeof escapeHTML === 'function' ? escapeHTML(s) : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&#39;'}[c])));
        const newHTML = `
            <div class="sl-name-entry">
                <div class="iwtp-title">Welcome back,</div>
                <div class="iwtp-passport-name" style="font-family:var(--font-display); font-size:1.8rem; font-weight:900; font-style:italic; text-transform:uppercase; color:#fff; margin-bottom:0.25rem;">${esc(playerName)}</div>
                <div class="iwtp-subtitle">Your passport was found on this device.</div>
                <button class="iwtp-btn" id="slCheckInBtn">
                    🏀 ${this._isOpenParty ? 'Join Instantly' : 'Check-in to Room'} ${esc(roomCode || '')}
                </button>
                <button class="iwtp-choice-btn iwtp-choice-existing" style="margin-top:10px;" id="slRenameJoinBtn">
                    ✏️ Join with a different name
                </button>
            </div>`;
        if (container.innerHTML.trim() !== newHTML.trim()) {
            container.innerHTML = newHTML;
        }
    },

    /** Interactive prompt for re-joining players. */
    _promptCheckIn(passport, joinCode) {
        return new Promise(resolve => {
            this._showWelcomeBack(passport.playerName, joinCode);
            
            const joinBtn = document.getElementById('slCheckInBtn');
            const renameBtn = document.getElementById('slRenameJoinBtn');
            
            if (joinBtn) joinBtn.onclick = () => resolve('join');
            if (renameBtn) renameBtn.onclick = () => resolve('rename');
        });
    },

    _showNameEntry() {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        const newHTML = `
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
                    CHECK-IN NOW →
                </button>
                <button class="sl-back-btn" id="slNameEntryCancel" style="margin-top:10px;">
                    Cancel
                </button>
            </div>`;
        if (container.innerHTML.trim() !== newHTML.trim()) {
            container.innerHTML = newHTML;
        }
        setTimeout(() => document.getElementById('slNameEntryInput')?.focus(), 120);
    },

    _showSearchingSpinner() {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        if (container.querySelector('.sl-name-entry')) return;
        const newHTML = `
            <div class="sl-searching">
                <div class="sl-searching-spinner"></div>
                <div class="sl-searching-text">SEARCHING FOR COURT…</div>
            </div>`;
        if (container.innerHTML.trim() !== newHTML.trim()) {
            container.innerHTML = newHTML;
        }
    },

    _clearSearchingSpinner() {
        const container = document.getElementById('slCurrentMatches');
        if (!container) return;
        if (container.querySelector('.sl-searching')) {
            const emptyMessage = '<div class="sl-empty">No active round yet</div>';
            if (container.innerHTML.trim() !== emptyMessage.trim()) {
                container.innerHTML = emptyMessage;
            }
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

    _onSessionEnded(recapData) {
        if (window.Haptic) Haptic.success();
        this.showRecap(recapData);
    },

    _onApprovalReceived(payload) {
        const passport = Passport.get();
        if (!passport) return;
        if (payload.playerUUID !== passport.playerUUID) return;

        this._markApprovedInSession(this._joinCode);
        this._isJoining = false;
        if (payload.token) this._saveToken(this._joinCode, payload.token, passport.playerName, passport.playerUUID);

        if (payload.squad)           window.squad          = payload.squad;
        if (payload.current_matches) window.currentMatches = payload.current_matches;
        if (payload.courtNames)      window.courtNames     = payload.courtNames;

        this._clearQueuedState();
        this._clearJoinRetryTimer();

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
                    if (typeof Passport !== 'undefined') Passport.recordAchievements(ids);
                    SidelineView.refresh();
                }
            }).catch(() => {});
        }

        // Ensure host has our current spirit animal after approval
        if (passport.spiritAnimal && typeof broadcastSpiritAnimalUpdate === 'function') {
            broadcastSpiritAnimalUpdate(passport.playerUUID, passport.spiritAnimal);
        }

        setTimeout(() => this._updateStatus(passport), 800);
    },

    /**
     * Deep Connection Resilience: Catch-Up Mechanism
     * Checks the player's session history for results that occurred while offline.
     */
    _checkForMissedResults(squad) {
        const passport = Passport.get();
        if (!passport || !squad) return;

        const me = squad.find(p => p.uuid === passport.playerUUID);
        if (!me || !me.matchHistory || me.matchHistory.length === 0) return;

        const lastTS = passport.lastProcessedTS || 0;
        // Find matches newer than our last processed one, oldest first
        const missed = me.matchHistory.filter(h => h.time > lastTS).reverse();

        if (missed.length > 0) {
            console.log(`[PlayerMode] Catching up on ${missed.length} missed results.`);
            missed.forEach((h, i) => {
                // Stagger animations so they don't overlap too much
                setTimeout(() => {
                    this._triggerResultFeedback(h.win, h.oppUUIDs, squad);
                }, i * 1500);
                
                // Update local tracker
                if (h.time > lastTS) passport.lastProcessedTS = h.time;
            });
            Passport.save(passport);
        }
    },

    _triggerResultFeedback(isWin, oppUUIDs, squad) {
        const oppNames = (oppUUIDs || []).map(uuid => {
            const p = squad.find(s => s.uuid === uuid);
            return p ? p.name : 'Unknown';
        }).join(' & ');

        if (typeof Passport.recordGame === 'function') Passport.recordGame(isWin);
        if (window.Haptic) isWin ? Haptic.success() : Haptic.bump();
        if (isWin && typeof Confetti !== 'undefined') {
            Confetti.burst(window.innerWidth / 2, window.innerHeight * 0.4);
        }
        if (typeof showSessionToast === 'function') {
            showSessionToast(isWin ? `🏆 Victory against ${oppNames}!` : `💔 Defeat vs ${oppNames}`);
        }
    },

    _onGameStateUpdate(payload) {
        const passport = Passport.get();
        if (!passport) return;

        // Connectivity Improvement: State Drift Detection
        // Compare host's broadcast hash with our new local state to verify consistency.
        if (payload.hash && typeof window._generateStateHash === 'function') {
            const incomingHash = window._generateStateHash(payload.squad, payload.player_queue);
            if (incomingHash !== payload.hash) {
                console.warn('[CourtSide] State drift detected! Triggering background resync...');
                SidelineView._performRefresh(true);
                return; // Stop here; the refresh will handle the rest.
            }
        }

        // Sync achievements to passport from broadcast
        if (payload.squad) {
            const me = payload.squad.find(p => p.uuid === passport.playerUUID);
            if (me && Array.isArray(me.achievements)) {
                Passport.recordAchievements(me.achievements);
            }
        }

        if (payload.next_up) window._lastNextUp = payload.next_up;
        SidelineView.refresh();
        this._checkForMissedResults(payload.squad);
        this._updateStatus(passport);
    },

    _onSessionUpdate(session) {
        const passport = Passport.get();
        if (!passport) return;
        const approved = session.approved_players || {};
        const myEntry  = approved[passport.playerUUID] || approved[passport.playerName];
        if (myEntry && !this._isApprovedInSession(this._joinCode)) {
            this._markApprovedInSession(this._joinCode);
            this._clearJoinRetryTimer();
            if (myEntry.token) this._saveToken(this._joinCode, myEntry.token, passport.playerName, passport.playerUUID);
            this.setStatus('approved', `You're in, ${passport.playerName}!`, 'Added to the rotation ✅');
            setTimeout(() => this._updateLiveFeed(session, passport), 1500);
            return;
        }
        this._updateLiveFeed(session, passport);
        if (session.squad) this._checkForMissedResults(session.squad);
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
        const myUUID = passport.playerUUID;

        const onCourtNow = new Set(matches.flatMap(m => (m.teams || []).flat()));
        const playing = me ? onCourtNow.has(me.uuid) : false; // Use UUID for lookup
        const inSquad = !!me;

        // The bench is anyone active and not on court.
        const bench = squad.filter(p => p.active && !onCourtNow.has(p.uuid)); // Use UUID for lookup
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
                if (all.some(uuid => uuid === myUUID)) { // Use UUID for lookup
                    const myTeam = teamA.some(uuid => uuid === myUUID) ? teamA : teamB;
                    const partnerUUID = myTeam.find(uuid => uuid !== myUUID);
                    const partner = (window.squad || []).find(p => p.uuid === partnerUUID);
                    courtInfo = { num: idx + 1, partner: partner?.name };
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
            
            // Audio Announcement
            if (localStorage.getItem('cs_audio_announce') === 'true') {
                const msg = new SpeechSynthesisUtterance();
                msg.text = `${passport.playerName}, you are up on court ${courtInfo?.num || 'one'}`;
                msg.rate = 0.9;
                window.speechSynthesis.speak(msg);
            }

            // Background Notification: Alert the player if they are in another tab
            if (document.visibilityState !== 'visible' && "Notification" in window && Notification.permission === 'granted') {
                try {
                    new Notification("🏸 You're Up!", {
                        body: `Court ${courtInfo?.num || '?'}${courtInfo?.partner ? ' with ' + courtInfo.partner : ''}. Get to the court!`,
                        tag: 'court-call',
                        requireInteraction: true
                    });
                } catch (e) {}
            }
        }

        // Fire haptic ONLY on transition INTO 'on-deck'
        if (newStatus === 'on-deck' && this._prevStatus !== 'on-deck') {
            if (window.Haptic) Haptic.bump();

            // Background Notification: Soft warning when they are next
            if (document.visibilityState !== 'visible' && "Notification" in window && Notification.permission === 'granted') {
                try {
                    new Notification("🟡 You're On Deck!", {
                        body: "You are up next. Head towards the courts!",
                        tag: 'court-call'
                    });
                } catch (e) {}
            }
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
            // Server name takes priority on activation
            Passport.rename(memberRecord.player_name);
            this._renderIdentity(Passport.get());
        }

        this._clearQueuedState();
        this._clearJoinRetryTimer();

        const p = (typeof Passport !== 'undefined') ? Passport.get() : null;
        const name = p?.playerName || 'Player';
        this.setStatus('approved', `You're in, ${name}!`, 'Added to the rotation ✅');

        if (window.Haptic) Haptic.success();

        SidelineView.show();

        // Self-repair: Fetch achievements locally
        if (window.fetchPlayerAchievements) {
            window.fetchPlayerAchievements(passport.playerUUID).then(achs => {
                const me = (window.squad || []).find(p => p.uuid === passport.playerUUID);
                if (me && achs && achs.length > 0) {
                    const ids = achs.map(a => a.achievement_id);
                    me.achievements = [...new Set([...(me.achievements || []), ...ids])];
                    if (typeof Passport !== 'undefined') Passport.recordAchievements(ids);
                    SidelineView.refresh();
                }
            }).catch(() => {});
        }

        // Ensure host has our current spirit animal after approval (Postgres change path)
        if (passport.spiritAnimal && typeof broadcastSpiritAnimalUpdate === 'function') {
            broadcastSpiritAnimalUpdate(passport.playerUUID, passport.spiritAnimal);
        }

        setTimeout(() => this._updateStatus(p), 1200);

        if (window.Haptic) Haptic.success();
        if (typeof showSessionToast === 'function') {
            showSessionToast("🏀 You're approved! Welcome to the court.");
        }
    },

    async _submitJoinRequest(passport, joinCode, options = {}) {
        const { force = false, statusMessage, statusSubMessage } = options;

        if (this._isJoining && !force) return;
        this._isJoining = true;

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
                    spirit_animal: passport.spiritAnimal,
                    force:       force,
                }),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                const container = document.getElementById('slCurrentMatches');
                const safeCode = typeof escapeHTML === 'function' ? escapeHTML(joinCode) : joinCode;

                if (res.status === 404) {
                    this.setStatus('pending', 'Connection Error', data.error || `Room "${safeCode}" not found or technical issue.`);
                    if (container) {
                        const newHTML = `
                            <div class="sl-code-entry" style="text-align:center; padding: 2rem 1.5rem;">
                                <div style="font-size:2.5rem; margin-bottom:1rem;">❌</div>
                                <div class="sl-code-label" style="margin-bottom:0.5rem; color:var(--red);">ROOM NOT FOUND</div>
                                <div class="sl-queued-sub" style="margin-bottom:1.5rem;">
                                    The code <strong>${safeCode}</strong> was not found.
                                </div>
                                <button class="sl-code-btn" onclick="PlayerMode.resetAndTryAgain()">
                                    Try Another Code
                                </button>
                                <button class="sl-back-btn" onclick="window.location.href=window.location.origin + window.location.pathname">
                                    ← Back to Host View
                                </button>
                            </div>`;
                        if (container.innerHTML.trim() !== newHTML.trim()) {
                            container.innerHTML = newHTML;
                        }
                    }
                } else if (res.status === 400) {
                    this.setStatus('pending', 'Invalid Request', data.error || 'Check your entry and try again.');
                } else {
                    const subMsg = data.error || 'The server had trouble processing your request. Try again?';
                    this.setStatus('pending', 'Could not join', subMsg);
                }
                return;
            }

            const data = await res.json();

            if (data.alreadyActive || data.status === 'active') {
                this._isJoining = false;
                if (data.global) Passport.hydrate(data.global);
                this._markApprovedInSession(joinCode);
                const msg = data.autoApproved ? "Joined instantly! 🔓" : "Reconnected to court ✅";
                this.setStatus('approved', `You're in, ${passport.playerName}!`, msg);
                SidelineView.show();
                SidelineView.refresh();
                // Ensure host has spirit animal on reconnection
                if (passport.spiritAnimal && typeof broadcastSpiritAnimalUpdate === 'function') {
                    broadcastSpiritAnimalUpdate(passport.playerUUID, passport.spiritAnimal);
                }
                // Notify host immediately so they add you to their local StateStore.squad
                if (typeof broadcastAutoJoin === 'function') {
                    broadcastAutoJoin(passport.playerUUID, passport.playerName);
                }
                setTimeout(() => this._updateStatus(passport), 800);
                return;
            }

            this._showQueuedState(passport.playerName);
            this._isJoining = false;

            // Immediate notification to host:
            // This ensures the host sees your request in <100ms, bypassing DB polling latency.
            if (!data.alreadyRequested && typeof broadcastEvent === 'function') {
                broadcastEvent('incoming_play_request', {
                    id: data.id,
                    name: passport.playerName,
                    player_uuid: passport.playerUUID,
                    spirit_animal: passport.spiritAnimal
                });
            }

            // Start retry timer: if no host broadcast in 15s, auto-resend
            this._startJoinRetryTimer();

        } catch(e) {
            this._isJoining = false;
            this.setStatus('pending', 'Connection failed', 'Check your internet');
            console.error('[PlayerMode] join request failed:', e);
        }
    },

    _startJoinRetryTimer() {
        this._clearJoinRetryTimer();
        
        let secondsLeft = 15; // Increased to 15s for better stability
        const updateText = (s) => {
            const el = document.getElementById('slRetryNote');
            if (el) {
                el.textContent = s > 0 ? `Auto-retrying in ${s}s...` : 'Auto-retrying now...';
                el.style.display = 'block';
            }
        };

        updateText(secondsLeft);

        this._retryInterval = setInterval(() => {
            secondsLeft--;
            updateText(secondsLeft);
            if (secondsLeft <= 0) {
                clearInterval(this._retryInterval);
                this._retryInterval = null;
            }
        }, 1000);

        this._joinRetryTimeout = setTimeout(() => {
            this._resendRequest();
        }, 15000);
    },

    _clearJoinRetryTimer() {
        if (this._joinRetryTimeout) {
            clearTimeout(this._joinRetryTimeout);
            this._joinRetryTimeout = null;
        }
        if (this._retryInterval) {
            clearInterval(this._retryInterval);
            this._retryInterval = null;
        }
        const el = document.getElementById('slRetryNote');
        if (el) el.style.display = 'none';
    },

    async _joinSession(passport, joinCode) {
        return this._submitJoinRequest(passport, joinCode);
    },

    _subscribeAndPoll(joinCode, passport) {
        if (joinCode) window.currentRoomCode = joinCode;
        if (typeof joinOnlineSession === 'function') {
            joinOnlineSession(joinCode).catch(() => {});
        }
        
        // Connectivity Resilience: State Polling Fallback
        // Fetches full game state every 10s to recover from WebSocket drops.
        if (this._statePollTimer) clearInterval(this._statePollTimer);
        const isSaver = localStorage.getItem('cs_battery_saver') === 'true';
        const stateInterval = isSaver ? 30000 : 10000;
        this._statePollTimer = setInterval(() => {
            if (document.visibilityState === 'visible') {
                SidelineView._performRefresh(true); // silent refresh
                
                // Self-Healing Logic: If we are meant to be approved (local flag set)
                // but the current broadcasted squad doesn't contain us, we may have 
                // been dropped from the Host's memory during a crash/refresh.
                const p = Passport.get();
                if (this._isApprovedInSession(this._joinCode) && p) {
                    const squad = window.squad || [];
                    // Only self-heal if we HAVE squad data and we aren't in it.
                    // If squad is empty, the session state is still loading.
                    if (squad.length > 0 && !squad.some(m => m.uuid === p.playerUUID)) {
                        console.warn('[PlayerMode] Self-healing: Approved but not in squad. Re-notifying host...');
                        this._resendRequest();
                    }
                }
            }
        }, 10000);
    },

    _isApprovedInSession(roomCode) {
        try { return !!JSON.parse(localStorage.getItem(LS_APPROVED) || '{}')[roomCode]; }
        catch { return false; }
    },

    _markApprovedInSession(roomCode) {
        try {
            const m = JSON.parse(localStorage.getItem(LS_APPROVED) || '{}');
            m[roomCode] = true;
            localStorage.setItem(LS_APPROVED, JSON.stringify(m));
        } catch { }
    },

    _clearApprovedInSession(roomCode) {
        try {
            const m = JSON.parse(localStorage.getItem(LS_APPROVED) || '{}');
            delete m[roomCode];
            localStorage.setItem(LS_APPROVED, JSON.stringify(m));
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
            if (passport.spiritAnimal) {
                avatarEl.textContent = passport.spiritAnimal;
                avatarEl.style.fontStyle = 'normal';
            }
            // Apply deterministic avatar color from polish.js if available
            if (passport.playerName && window.Avatar) {
                avatarEl.style.background = Avatar.color(passport.playerName);
            }
        }
        // Render play count badge (will be 0 until squad data arrives)
        _renderPlayCount(passport.playerName);
    },

    async pickSpiritAnimal() {
        const emojis = ['🏸', '👟', '🏸', '🔥', '🦁', '🐯', '🦅', '🦈', '🦍', '🐺', '🐉', '⚡', '🌟', '🎯', '👑', '🦾'];
        const content = `
            <div class="menu-card">
                <h2>Spirit Animal</h2>
                <p>Choose an emoji to represent you on court.</p>
                <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; margin-bottom:20px;">
                    ${emojis.map(e => `<button class="btn-icon" style="width:auto; font-size:1.5rem;" onclick="PlayerMode.updateSpiritAnimal('${e}')">${e}</button>`).join('')}
                </div>
                <button class="btn-main btn-danger" style="margin-bottom:10px;" onclick="PlayerMode.updateSpiritAnimal(null)">Remove Emoji</button>
                <button class="btn-cancel" onclick="UIManager.hide()">Cancel</button>
            </div>
        `;
        UIManager.show(content, 'card');
    },

    updateSpiritAnimal(emoji) {
        const passport = Passport.setSpiritAnimal(emoji);
        UIManager.hide();
        this._renderIdentity(passport);
        SidelineView.refresh();
        if (typeof broadcastSpiritAnimalUpdate === 'function') {
            broadcastSpiritAnimalUpdate(passport.playerUUID, emoji);
        }
        // Refresh standalone passport if open
        if (document.getElementById('passportStandalone')?.style.display === 'flex' && typeof window.renderPassportStandalone === 'function') {
            window.renderPassportStandalone(passport);
        }
        // Persist to database so the update is visible if host reloads while we are pending
        if (typeof memberRename === 'function') {
            memberRename(passport.playerUUID, null, emoji);
        }
        if (window.Haptic) Haptic.success();
    },

    _joinWithManualCode() {
        const input = document.getElementById('slManualCodeInput');
        const raw = input?.value?.trim();
        if (raw) {
            let code = raw.replace(/[^A-Z0-9]/gi, '').toUpperCase();
            if (code.length === 8) code = code.slice(0, 4) + '-' + code.slice(4);
            PlayerMode.boot(Passport.get(), code);
        }
    },
    _promptForCode() {
        this.setStatus('pending', 'Ready to Join', 'Enter room code to join');
        const el = document.getElementById('slCurrentMatches');
        if (el) {
            const newHTML = `
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
            if (el.innerHTML.trim() !== newHTML.trim()) {
                el.innerHTML = newHTML;
            }
        }

        // Attach listeners after rendering the HTML
        document.getElementById('slJoinManualCodeBtn')?.addEventListener('click', () => this._joinWithManualCode());
        document.getElementById('slManualCodeInput')?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') this._joinWithManualCode();
        });
        
        // Auto-format room code: ABCD-1234
        document.getElementById('slManualCodeInput')?.addEventListener('input', (e) => {
            let val = e.target.value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
            if (val.length > 4) {
                val = val.slice(0, 4) + '-' + val.slice(4, 8);
            }
            e.target.value = val;
            
            // Proactive Validation: Auto-check code when fully typed
            if (val.length === 9) {
                this._validateRoomProactively(val);
            }
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
                    if (typeof UIManager !== 'undefined') {
                        UIManager.prompt({
                            title: 'Join Session',
                            placeholder: 'Enter your name...',
                            confirmText: 'Join',
                            onConfirm: (n) => resolve(n ? n.trim() : null),
                            onCancel: () => resolve(null)
                        });
                    } else {
                        // Extreme fallback if UIManager fails
                        const n = window.prompt('Enter your name to join:');
                        resolve(n ? n.trim() : null);
                    }
                    return;
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

    async _validateRoomProactively(code) {
        const btn = document.getElementById('slJoinManualCodeBtn');
        if (!btn) return;
        
        const originalText = btn.textContent;
        btn.textContent = 'Checking...';
        
        try {
            const res = await fetch(`/api/session-get?code=${encodeURIComponent(code)}`);
            if (res.ok) {
                btn.textContent = 'ROOM FOUND • JOIN NOW';
                btn.style.background = 'var(--accent)';
            } else {
                if (res.status === 404) {
                    btn.textContent = 'ROOM NOT FOUND';
                } else if (res.status === 400) {
                    btn.textContent = 'Invalid Format';
                } else {
                    btn.textContent = 'CONNECTION ERROR';
                }
                btn.style.background = '#334155';
            }
        } catch (e) {
            btn.textContent = originalText;
        }
    },

    toggleStatus(currentActiveState) {
        const passport = Passport.get();
        if (!passport) return;
        
        const newState = !currentActiveState;
        // Optimistic UI update handled by re-render on next broadcast, 
        // but we can trigger a haptic feedback immediately.
        if (window.Haptic) Haptic.tap();
        
        if (typeof broadcastStatusUpdate === 'function') {
            broadcastStatusUpdate(passport.playerUUID, newState);
        }
    },

    openNavigation() {
        const isSaver = localStorage.getItem('cs_battery_saver') === 'true';
        const code = this._joinCode || window.currentRoomCode || '';
        const content = `
            <div class="menu-card">
                <h2>Navigation</h2>
                <div style="margin-bottom:20px; display:flex; flex-direction:column; gap:8px;">
                    <button class="btn-main" style="background:var(--accent); color:#000; height: 54px;" onclick="UIManager.hide(); SidelineView._performRefresh();">🔄 SYNC NOW</button>
                    
                    <button class="btn-main" style="background:var(--surface2); color:var(--text); height: 50px;" onclick="PlayerMode.toggleBatterySaver()">
                        🔋 BATTERY SAVER: ${isSaver ? 'ON' : 'OFF'}
                    </button>

                    ${("Notification" in window && Notification.permission !== 'granted') ? `
                    <button class="btn-main" style="background:var(--surface2); color:var(--text); height: 50px;" onclick="PlayerMode.requestNotifications()">
                        🔔 ENABLE NOTIFICATIONS
                    </button>
                    ` : ''}

                    <button class="btn-main" style="background:var(--surface2); color:var(--text); font-size:0.8rem; height: 50px;" onclick="PlayerMode.shareRoomCode()">🔗 SHARE</button>

                    <div style="height:1px; background:var(--border); margin:8px 0;"></div>
                    
                    <button class="btn-main btn-danger" style="height: 50px;" onclick="UIManager.hide(); PlayerMode.confirmEndSession();">🏃 END SESSION</button>
                </div>
                <button class="btn-cancel" onclick="UIManager.hide()">Close</button>
            </div>
        `;
        UIManager.show(content, 'card');
    },

    shareRoomCode() {
        const code = this._joinCode || window.currentRoomCode;
        if (!code) return;
        const url = window.location.origin + window.location.pathname + '?join=' + code + '&role=player';
        
        if (navigator.share) {
            navigator.share({
                title: 'Join my Match!',
                text: `I'm playing at CourtSide. Join the session with code: ${code}`,
                url: url
            }).catch(() => {
                navigator.clipboard.writeText(url).then(() => showSessionToast('Invite link copied!'));
            });
        } else {
            navigator.clipboard.writeText(url).then(() => showSessionToast('Invite link copied!'));
        }
        UIManager.hide();
    },

    toggleBatterySaver() {
        const current = localStorage.getItem('cs_battery_saver') === 'true';
        const newVal = !current;
        localStorage.setItem('cs_battery_saver', String(newVal));
        // Re-init poll timers with new interval
        this._subscribeAndPoll(this._joinCode, Passport.get());
        showSessionToast(`🔋 Battery Saver: ${newVal ? 'ON' : 'OFF'}`);
        UIManager.hide();
    },

    async requestNotifications() {
        if (!("Notification" in window)) {
            if (typeof showSessionToast === 'function') showSessionToast("Notifications not supported on this browser.");
            return;
        }
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
            if (typeof showSessionToast === 'function') showSessionToast("🔔 Notifications Enabled!");
            // Refresh the navigation menu to hide the button
            this.openNavigation();
        } else {
            if (typeof showSessionToast === 'function') showSessionToast("❌ Notifications Blocked");
        }
    },
    restorePassportPrompt() {
        UIManager.prompt({
            title: 'Restore Passport',
            placeholder: 'Paste your Recovery Key...',
            confirmText: 'Restore',
            onConfirm: async (key) => {
                if (!key || key.length < 30) return showSessionToast('Invalid Key');
                showSessionToast('🔍 Locating Profile...');
                try {
                    const res = await fetch('/api/member-upsert', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ room_code: 'RESTORE', player_uuid: key.trim(), player_name: 'Recovering...' })
                    });
                    if (res.ok) {
                        const data = await res.json();
                        if (data.global) {
                            // Verification Dialog
                            UIManager.confirm({
                                title: 'Profile Found!',
                                message: `
                                    <div style="text-align:center; margin-top:10px;">
                                        <div style="font-size:1.4rem; font-weight:900; color:var(--accent); text-transform:uppercase; font-style:italic;">${data.global.name}</div>
                                        <div style="font-size:0.8rem; color:var(--text-muted); margin-top:4px; font-weight:700;">
                                            ${data.global.total_wins || 0} Wins · ${data.global.total_games || 0} Games
                                        </div>
                                        <div style="margin-top:16px; font-weight:600; font-size:0.85rem; color:var(--text);">Is this you?</div>
                                    </div>
                                `,
                                confirmText: 'Yes, Restore it',
                                onConfirm: () => {
                                    // Reset local identity to this restored UUID
                                    const p = {
                                        playerUUID: data.global.uuid,
                                        playerName: data.global.name,
                                        stats: { wins: 0, games: 0 },
                                        achievements: []
                                    };
                                    localStorage.setItem('cs_player_passport', JSON.stringify(p));
                                    
                                    // Use hydrate logic to merge trophies and stats correctly
                                    if (typeof Passport !== 'undefined') Passport.hydrate(data.global);

                                    showSessionToast('✅ Passport Restored!');
                                    setTimeout(() => location.reload(), 1000);
                                }
                            });
                        } else {
                            showSessionToast('❌ Profile not found');
                        }
                    }
                } catch(e) { showSessionToast('❌ Restore failed'); }
            }
        });
    },
    
    openSkillLevelPicker() {
        const passport = Passport.get();
        if (!passport) return;

        const emojis = {
            'Novice': '👶',
            'Intermediate': '🧑',
            'Advanced': '🧙'
        };

        const content = `
            <div class="menu-card">
                <h2>Set Skill Level</h2>
                <p>How do you rate your current skill?</p>
                <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:20px;">
                    ${Object.entries(emojis).map(([level, emoji]) => `
                        <button class="btn-main" style="background:var(--bg2); color:var(--text); border:1px solid var(--border); ${passport.skillLevel === level ? 'border-color:var(--accent); box-shadow:0 0 10px var(--accent-dim);' : ''}" 
                                onclick="PlayerMode.updateSkillLevel('${level}')">
                            ${emoji} ${level}
                        </button>
                    `).join('')}
                </div>
                <button class="btn-cancel" onclick="UIManager.hide()">Cancel</button>
            </div>
        `;
        UIManager.show(content, 'card');
    },

    updateSkillLevel(level) {
        const passport = Passport.setSkillLevel(level);
        UIManager.hide();
        SidelineView.refresh(); // Re-render profile with new skill level
        if (window.Haptic) Haptic.success();
    },

    openTrophyRoom() {
        const passport = Passport.get();
        if (!passport) return;
        const me = (window.squad || []).find(p => p.uuid === passport.playerUUID);
        const sessionAch = me ? (me.achievements || []) : [];
        const allTimeAch = passport.achievements || [];
        const myAch = [...new Set([...sessionAch, ...allTimeAch])];
        
        if (!window.Achievements) return;

        const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&#39;'}[c]));

        const listHTML = Object.keys(window.Achievements).map(key => {
            const data = window.getAchievementDisplay(key, myAch);
            const unlocked = data.unlocked;
            return `
                <div class="sl-ach-item ${unlocked ? 'unlocked' : 'locked'}" style="margin-bottom:8px; text-align:left; border-color: ${unlocked ? data.color : 'var(--border)'}">
                    <div class="sl-ach-icon">${unlocked ? data.icon : '🔒'}</div>
                    <div class="sl-ach-text">
                        <div class="sl-ach-title">${esc(data.name)}</div>
                        <div class="sl-ach-desc">${esc(data.description)}</div>
                    </div>
                </div>
            `;
        }).join('');

        const content = `
            <div class="menu-card" style="max-width:400px; width:95%; max-height:80vh; overflow-y:auto; padding:24px 16px;">
                <h2 style="margin-bottom:4px;">Trophy Room</h2>
                <p style="margin-bottom:20px;">Detailed view of your session progress.</p>
                <div style="display:flex; flex-direction:column; gap:8px;">
                    ${listHTML}
                </div>
                <button class="btn-main" style="margin-top:20px; background:var(--surface2); color:var(--text);" onclick="UIManager.hide()">Close</button>
            </div>
        `;
        UIManager.show(content, 'card');
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
    
    const safePartner = partnerName ? SidelineView._esc(partnerName) : '';
    banner.innerHTML = `
        <div style="font-size:0.75rem; font-weight:900; letter-spacing:1px; opacity:0.8; margin-bottom:4px;">YOU'RE UP</div>
        <div style="font-size:1.8rem; font-weight:900; line-height:1; margin-bottom:8px; font-style:italic;">COURT ${courtNum || '?'}</div>
        ${safePartner ? `<div style="font-size:0.9rem; font-weight:600; margin-bottom:12px;">with ${safePartner}</div>` : ''}
        <button id="_csAckBtn" style="background:#fff; color:#000; border:none; padding:8px 16px; border-radius:8px; font-family:var(--font-display); font-weight:900; font-size:0.8rem; letter-spacing:1px;">👍 I'M COMING!</button>
    `;
    document.body.appendChild(banner);
    const ackBtn = banner.querySelector('#_csAckBtn');

    // Slide in
    requestAnimationFrame(() => {
        requestAnimationFrame(() => { banner.style.transform = 'translateY(0)'; });
    });

    ackBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = Passport.get();
        if (p && typeof broadcastAcknowledge === 'function') {
            broadcastAcknowledge(p.playerUUID);
        }
        ackBtn.textContent = 'SENT ✅';
        ackBtn.style.opacity = '0.5';
        ackBtn.disabled = true;
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
window.SidelineView = SidelineView;
window.PlayerMode = PlayerMode;