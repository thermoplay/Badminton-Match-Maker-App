// =============================================================================
// COURTSIDE PRO — stats.js  v2
// Features:
//   • ChemistryEngine  — computes best partner & toughest rival from tonight's
//                        session data (teammateHistory / opponentHistory + wins)
//   • MyStatsTab       — renders the "My Stats" tab in the player sideline panel
//   • SessionRecap     — player-triggered shareable 9:16 Instagram story card
//
// Dependencies: polish.js (Avatar), app.js (window.squad, window.roundHistory)
// No external libraries. No new API endpoints.
// =============================================================================

// =============================================================================
// CHEMISTRY ENGINE
// Computes, from tonight's session data, the best partner and toughest rival
// for any given player name.
//
// Data sources (all already in window.squad):
//   p.teammateHistory  — { [name]: countPlayedTogether }
//   p.opponentHistory  — { [name]: countFacedOff }
//   p.wins, p.games    — session running totals (reset per app session)
//
// Chemistry Score formula:
//   For each teammate: (wins together) / (games together + 1)
//   We weight wins-together because synergy matters more than raw count.
//   We estimate wins-together using a proxy: teammates both have a win rate;
//   if you played N games together, expected shared wins ≈ N * min(wrA, wrB).
//   But we keep it lightweight — use raw teammateHistory count + both win rates.
//
// Rivalry Score formula:
//   For each opponent: opponentHistory[name] * (1 - myWinRateVsThem)
//   We use a proxy win rate: opponent's overall session win rate as a stand-in.
//   Higher score = you face them a lot AND they tend to win.
// =============================================================================

const ChemistryEngine = (() => {

    function _winRate(p) {
        if (!p || !p.games) return 0.5;
        return p.games > 0 ? p.wins / p.games : 0.5;
    }

    /**
     * Returns the best partner for `myName` tonight.
     * @param {string} myName
     * @returns {{ name: string, score: number, gamesTogther: number } | null}
     */
    function bestPartner(myName) {
        const squad = window.squad || [];
        const me    = squad.find(p => p.name?.toLowerCase() === myName?.toLowerCase());
        if (!me || !me.teammateHistory) return null;

        const myWR = _winRate(me);
        let best = null, bestScore = -1;

        Object.entries(me.teammateHistory).forEach(([name, count]) => {
            if (count < 1) return;
            const partner = squad.find(p => p.name === name);
            const partnerWR = _winRate(partner);
            // Chemistry = how often we played × geometric mean of our win rates
            const score = count * Math.sqrt(myWR * partnerWR);
            if (score > bestScore) {
                bestScore = score;
                best = { name, score: Math.round(score * 100) / 100, gamesTogther: count };
            }
        });

        return best;
    }

    /**
     * Returns the toughest rival for `myName` tonight.
     * @param {string} myName
     * @returns {{ name: string, score: number, gamesFaced: number } | null}
     */
    function toughestRival(myName) {
        const squad = window.squad || [];
        const me    = squad.find(p => p.name?.toLowerCase() === myName?.toLowerCase());
        if (!me || !me.opponentHistory) return null;

        const myWR = _winRate(me);

        let worst = null, worstScore = -1;

        Object.entries(me.opponentHistory).forEach(([name, count]) => {
            if (count < 1) return;
            const rival = squad.find(p => p.name === name);
            const rivalWR = _winRate(rival);
            // Rivalry score = games faced × rival's dominance over me
            // Proxy: rival win rate weighted by face-off count
            const score = count * rivalWR * (1 - myWR + 0.1);
            if (score > worstScore) {
                worstScore = score;
                worst = { name, score: Math.round(score * 100) / 100, gamesFaced: count };
            }
        });

        return worst;
    }

    /**
     * Returns a human-readable chemistry percentage (0–100) for display.
     * Normalises the score across all possible partners tonight.
     */
    function chemistryPct(myName) {
        const squad = window.squad || [];
        const me    = squad.find(p => p.name?.toLowerCase() === myName?.toLowerCase());
        if (!me || !me.teammateHistory) return 0;

        const scores = Object.entries(me.teammateHistory).map(([name, count]) => {
            const partner = squad.find(p => p.name === name);
            return count * Math.sqrt(_winRate(me) * _winRate(partner));
        });

        if (!scores.length) return 0;
        const max = Math.max(...scores);
        if (!max) return 0;

        const top = Math.max(...scores);
        return Math.min(100, Math.round((top / (max + 1)) * 100));
    }

    return { bestPartner, toughestRival, chemistryPct, _winRate };
})();


// =============================================================================
// MY STATS TAB
// Renders a "My Stats" section inside the player sideline panel.
// Injected as a tab alongside the existing "Live" content.
// =============================================================================

const MyStatsTab = (() => {

    let _tabBarInjected = false;

    /** Called once after the sideline panel is visible */
    function init() {
        if (_tabBarInjected) return;
        _injectTabBar();
        _tabBarInjected = true;
    }

    function _injectTabBar() {
        const panel = document.getElementById('sidelinePanel');
        if (!panel) return;
        const inner = panel.querySelector('.sl-inner');
        if (!inner) return;

        // Inject tab bar after the identity block
        const identity = inner.querySelector('.sl-identity');
        if (!identity) return;

        const tabBar = document.createElement('div');
        tabBar.className = 'sl-tab-bar';
        tabBar.id = 'slTabBar';
        tabBar.innerHTML = `
            <button class="sl-tab sl-tab-active" data-tab="live" onclick="MyStatsTab.switchTab('live')">
                <span class="sl-tab-dot sl-dot-live"></span>LIVE
            </button>
            <button class="sl-tab" data-tab="stats" onclick="MyStatsTab.switchTab('stats')">
                ✦ MY STATS
            </button>
        `;
        identity.insertAdjacentElement('afterend', tabBar);

        // Create the stats panel (hidden by default)
        const statsPanel = document.createElement('div');
        statsPanel.id = 'slStatsPanel';
        statsPanel.className = 'sl-stats-panel';
        statsPanel.style.display = 'none';
        statsPanel.innerHTML = `<div class="sl-stats-loading">Loading tonight's data…</div>`;
        tabBar.insertAdjacentElement('afterend', statsPanel);
    }

    function switchTab(tab) {
        const tabs     = document.querySelectorAll('.sl-tab');
        const liveArea = document.getElementById('slLiveArea');
        const statsPanel = document.getElementById('slStatsPanel');

        tabs.forEach(t => t.classList.toggle('sl-tab-active', t.dataset.tab === tab));

        // Wrap all live content in a grouping div if not already done
        _ensureLiveAreaWrapper();

        const liveWrapper = document.getElementById('slLiveWrapper');
        if (tab === 'live') {
            if (liveWrapper)  liveWrapper.style.display = 'block';
            if (statsPanel)   statsPanel.style.display  = 'none';
        } else {
            if (liveWrapper)  liveWrapper.style.display = 'none';
            if (statsPanel)   statsPanel.style.display  = 'block';
            render();
        }

        if (window.Haptic) Haptic.tap();
    }

    function _ensureLiveAreaWrapper() {
        if (document.getElementById('slLiveWrapper')) return;

        const panel = document.getElementById('sidelinePanel');
        if (!panel) return;
        const inner = panel.querySelector('.sl-inner');
        if (!inner) return;

        const wrapper = document.createElement('div');
        wrapper.id = 'slLiveWrapper';

        // Move all live elements into the wrapper
        const liveEls = inner.querySelectorAll(
            '.sl-section-label, #slCurrentMatches, #slNextUpRow, #slLastWinnerRow, .sl-invite-btn'
        );

        // Insert wrapper before first live element
        if (liveEls[0]) {
            inner.insertBefore(wrapper, liveEls[0]);
            liveEls.forEach(el => wrapper.appendChild(el));
        }
    }

    function render() {
        const panel = document.getElementById('slStatsPanel');
        if (!panel) return;

        const passport = (typeof Passport !== 'undefined') ? Passport.get() : null;
        const myName   = passport?.playerName;
        const squad    = window.squad || [];
        const me       = squad.find(p => p.name?.toLowerCase() === myName?.toLowerCase());

        if (!myName || !me) {
            panel.innerHTML = `
                <div class="sl-stats-empty">
                    <div class="sl-stats-empty-icon">🏸</div>
                    <div>Play a few games to see your stats!</div>
                </div>`;
            return;
        }

        const wins   = me.wins   || 0;
        const games  = me.games  || 0;
        const losses = games - wins;
        const wr     = games > 0 ? Math.round((wins / games) * 100) : 0;
        const streak = me.streak || 0;

        const partner = ChemistryEngine.bestPartner(myName);
        const rival   = ChemistryEngine.toughestRival(myName);

        // Win rate ring colour
        const ringColor = wr >= 60 ? '#00ffa3' : wr >= 40 ? '#ffd700' : '#ff6b6b';

        panel.innerHTML = `
            <div class="sl-stats-content">

                <!-- ── Tonight's Record ── -->
                <div class="sl-stats-block sl-stats-record">
                    <div class="sl-stats-record-ring" style="--ring-color:${ringColor}; --ring-pct:${wr};">
                        <svg class="sl-ring-svg" viewBox="0 0 80 80">
                            <circle class="sl-ring-bg"    cx="40" cy="40" r="34" />
                            <circle class="sl-ring-fill"  cx="40" cy="40" r="34"
                                style="stroke:${ringColor}; stroke-dasharray:${Math.round(2*Math.PI*34*wr/100)} ${Math.round(2*Math.PI*34)};" />
                        </svg>
                        <div class="sl-ring-inner">
                            <div class="sl-ring-pct">${wr}%</div>
                            <div class="sl-ring-label">WIN RATE</div>
                        </div>
                    </div>
                    <div class="sl-stats-record-nums">
                        <div class="sl-stat-pill sl-stat-win">
                            <span class="sl-stat-num">${wins}</span>
                            <span class="sl-stat-lbl">WINS</span>
                        </div>
                        <div class="sl-stat-pill sl-stat-loss">
                            <span class="sl-stat-num">${losses}</span>
                            <span class="sl-stat-lbl">LOSSES</span>
                        </div>
                        <div class="sl-stat-pill sl-stat-streak">
                            <span class="sl-stat-num">${streak > 0 ? '🔥' : ''}${streak}</span>
                            <span class="sl-stat-lbl">STREAK</span>
                        </div>
                    </div>
                </div>

                <!-- ── Chemistry ── -->
                <div class="sl-stats-divider">TONIGHT'S CHEMISTRY</div>

                ${partner ? `
                <div class="sl-stats-block sl-chemistry-card">
                    <div class="sl-chem-icon">🤝</div>
                    <div class="sl-chem-body">
                        <div class="sl-chem-label">BEST PARTNER</div>
                        <div class="sl-chem-name">
                            ${window.Avatar ? Avatar.html(partner.name) : ''}
                            <span>${partner.name}</span>
                        </div>
                        <div class="sl-chem-bar-wrap">
                            <div class="sl-chem-bar">
                                <div class="sl-chem-bar-fill sl-chem-bar-green"
                                    style="width:${Math.min(100, partner.gamesTogther * 20)}%"></div>
                            </div>
                            <span class="sl-chem-bar-label">${partner.gamesTogther} game${partner.gamesTogther !== 1 ? 's' : ''} together</span>
                        </div>
                    </div>
                </div>
                ` : `<div class="sl-stats-empty-inline">Play more games to find your best partner!</div>`}

                ${rival ? `
                <div class="sl-stats-block sl-rivalry-card">
                    <div class="sl-chem-icon">⚔️</div>
                    <div class="sl-chem-body">
                        <div class="sl-chem-label">TOUGHEST RIVAL</div>
                        <div class="sl-chem-name">
                            ${window.Avatar ? Avatar.html(rival.name) : ''}
                            <span>${rival.name}</span>
                        </div>
                        <div class="sl-chem-bar-wrap">
                            <div class="sl-chem-bar">
                                <div class="sl-chem-bar-fill sl-chem-bar-red"
                                    style="width:${Math.min(100, rival.gamesFaced * 20)}%"></div>
                            </div>
                            <span class="sl-chem-bar-label">${rival.gamesFaced} face-off${rival.gamesFaced !== 1 ? 's' : ''}</span>
                        </div>
                    </div>
                </div>
                ` : `<div class="sl-stats-empty-inline">No rivals yet tonight.</div>`}

                <!-- ── Share My Night ── -->
                ${games > 0 ? `
                <div style="margin-top:4px;">
                    <button class="sl-recap-btn" onclick="SessionRecap.shareMyRecap()">
                        📸 Share My Night
                    </button>
                </div>` : ''}

            </div>
        `;
    }

    return { init, render, switchTab };
})();


// =============================================================================
// SESSION RECAP — Canvas Story Card
// Player-triggered. Generates a 9:16 Instagram-ready personal recap card.
// Call SessionRecap.shareMyRecap() from the My Stats tab.
// =============================================================================

const SessionRecap = (() => {

    const W = 1080, H = 1920;

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC — PLAYER personal recap
    // ─────────────────────────────────────────────────────────────────────────

    async function shareMyRecap() {
        const passport = (typeof Passport !== 'undefined') ? Passport.get() : null;
        const myName   = passport?.playerName;
        const squad    = window.squad || [];
        const me       = squad.find(p => p.name?.toLowerCase() === myName?.toLowerCase());

        const stories  = _buildStories(squad, window.roundHistory || []);
        const canvas   = await _drawRecapCanvas(stories, me);
        await _shareCanvas(canvas, `courtside-${(myName || 'player').replace(/\s+/g, '-')}.png`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STORY BUILDING — derive the 3 narrative slots
    // ─────────────────────────────────────────────────────────────────────────

    function _buildStories(squad, history) {
        // 1. TOP PERFORMER — most wins tonight
        const sorted = [...squad].filter(p => p.games > 0)
            .sort((a, b) => (b.wins - a.wins) || (b.games - a.games));
        const topPerformer = sorted[0] || null;

        // 2. HOTTEST STREAK — longest current streak
        const hottest = [...squad].filter(p => p.streak > 1)
            .sort((a, b) => b.streak - a.streak)[0] || null;

        // 3. BIGGEST UPSET — a player with overall lower rating beat someone higher
        //    We scan roundHistory for matches where the "underdog" (lower avg rating) won.
        let biggestUpset = null, biggestDiff = 0;
        history.forEach(snapshot => {
            (snapshot.matches || []).forEach(m => {
                if (m.winnerTeamIndex === null) return;
                const [odds0, odds1] = m.odds || [50, 50];
                const winnerOdds = m.winnerTeamIndex === 0 ? odds0 : odds1;
                const upset = 50 - winnerOdds; // positive = underdog won
                if (upset > biggestDiff) {
                    biggestDiff = upset;
                    biggestUpset = {
                        winners: m.teams[m.winnerTeamIndex].join(' & '),
                        odds:    winnerOdds,
                        diff:    upset,
                    };
                }
            });
        });

        // Total games played tonight
        const totalGames = history.reduce((n, s) =>
            n + (s.matches || []).filter(m => m.winnerTeamIndex !== null).length, 0);

        return { topPerformer, hottest, biggestUpset, totalGames, squad };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CANVAS RENDERING
    // ─────────────────────────────────────────────────────────────────────────

    async function _drawRecapCanvas(stories, focusPlayer) {
        const canvas  = document.createElement('canvas');
        canvas.width  = W;
        canvas.height = H;
        const ctx     = canvas.getContext('2d');

        // ── Background ──────────────────────────────────────────────────────
        ctx.fillStyle = '#07070c';
        ctx.fillRect(0, 0, W, H);

        // Green top radial glow
        const g1 = ctx.createRadialGradient(W/2, 0, 0, W/2, 0, 900);
        g1.addColorStop(0,   'rgba(0,255,163,0.18)');
        g1.addColorStop(0.6, 'rgba(0,255,163,0.04)');
        g1.addColorStop(1,   'rgba(0,255,163,0)');
        ctx.fillStyle = g1;
        ctx.fillRect(0, 0, W, H);

        // Bottom warm glow
        const g2 = ctx.createRadialGradient(W/2, H, 0, W/2, H, 800);
        g2.addColorStop(0,   'rgba(255,200,60,0.07)');
        g2.addColorStop(1,   'rgba(0,0,0,0)');
        ctx.fillStyle = g2;
        ctx.fillRect(0, 0, W, H);

        // Grain
        _grain(ctx, W, H, 0.014);

        // ── Branding ─────────────────────────────────────────────────────────
        ctx.save();
        ctx.shadowColor = 'rgba(0,255,163,0.7)';
        ctx.shadowBlur  = 40;
        ctx.fillStyle   = '#00ffa3';
        ctx.font        = 'bold 58px "Arial Narrow", Arial, sans-serif';
        ctx.letterSpacing = '12px';
        ctx.textAlign   = 'center';
        ctx.fillText('THE COURTSIDE', W/2, 140);
        ctx.restore();

        // Session ended pill
        _pill(ctx, W/2, 200, 'SESSION RECAP', '#00ffa3', 32);

        // Horizontal rule
        _hRule(ctx, 80, 260, W - 80, 0.3);

        // ── Total games count ─────────────────────────────────────────────────
        ctx.textAlign   = 'center';
        ctx.fillStyle   = 'rgba(255,255,255,0.35)';
        ctx.font        = '500 30px Arial, sans-serif';
        ctx.letterSpacing = '6px';
        ctx.fillText(`${stories.totalGames} GAME${stories.totalGames !== 1 ? 'S' : ''} PLAYED TONIGHT`, W/2, 318);

        let yOffset = 380;

        // ── STORY 1 — TOP PERFORMER ───────────────────────────────────────────
        if (stories.topPerformer) {
            const p  = stories.topPerformer;
            const wr = p.games > 0 ? Math.round(p.wins / p.games * 100) : 0;
            yOffset = _drawStoryBlock(ctx, yOffset, {
                icon:  '🏆',
                label: 'TONIGHT\'S MVP',
                title: p.name.toUpperCase(),
                sub:   `${p.wins}W – ${p.games - p.wins}L · ${wr}% win rate`,
                color: '#ffd700',
                highlight: focusPlayer?.name === p.name,
            });
        }

        // ── STORY 2 — HOTTEST STREAK ──────────────────────────────────────────
        if (stories.hottest) {
            const p = stories.hottest;
            yOffset = _drawStoryBlock(ctx, yOffset, {
                icon:  '🔥',
                label: 'HOTTEST STREAK',
                title: p.name.toUpperCase(),
                sub:   `${p.streak} wins in a row`,
                color: '#ff7043',
                highlight: focusPlayer?.name === p.name,
            });
        }

        // ── STORY 3 — BIGGEST UPSET ──────────────────────────────────────────
        if (stories.biggestUpset) {
            const u = stories.biggestUpset;
            yOffset = _drawStoryBlock(ctx, yOffset, {
                icon:  '💥',
                label: 'BIGGEST UPSET',
                title: u.winners.toUpperCase(),
                sub:   `Won at ${u.odds}% odds`,
                color: '#a855f7',
                highlight: focusPlayer && u.winners.toLowerCase().includes(focusPlayer.name?.toLowerCase()),
            });
        }

        // ── PERSONAL FOCUS BLOCK (player recap only) ─────────────────────────
        if (focusPlayer && focusPlayer.games > 0) {
            yOffset += 40;
            _hRule(ctx, 80, yOffset, W - 80, 0.2);
            yOffset += 50;

            const wr     = Math.round((focusPlayer.wins / focusPlayer.games) * 100);
            const partner = ChemistryEngine.bestPartner(focusPlayer.name);
            const rival   = ChemistryEngine.toughestRival(focusPlayer.name);

            ctx.textAlign = 'center';
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.font      = '500 26px Arial, sans-serif';
            ctx.letterSpacing = '8px';
            ctx.fillText('YOUR NIGHT', W/2, yOffset);
            yOffset += 70;

            // Big name
            ctx.save();
            ctx.shadowColor = 'rgba(0,255,163,0.5)';
            ctx.shadowBlur  = 20;
            ctx.fillStyle   = '#00ffa3';
            ctx.font        = 'bold 88px "Arial Narrow", Arial, sans-serif';
            ctx.letterSpacing = '4px';
            ctx.textAlign   = 'center';
            ctx.fillText(focusPlayer.name.toUpperCase(), W/2, yOffset);
            ctx.restore();
            yOffset += 60;

            // W/L/STREAK row
            const cols = [
                { val: focusPlayer.wins,                           lbl: 'WINS'   },
                { val: focusPlayer.games - focusPlayer.wins,       lbl: 'LOSSES' },
                { val: focusPlayer.streak > 0 ? `🔥${focusPlayer.streak}` : focusPlayer.streak, lbl: 'STREAK' },
                { val: `${wr}%`,                                    lbl: 'WIN RATE'},
            ];
            const colW = (W - 160) / cols.length;
            cols.forEach((c, i) => {
                const cx = 80 + colW * i + colW / 2;
                ctx.textAlign = 'center';
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 64px "Arial Narrow", Arial, sans-serif';
                ctx.letterSpacing = '2px';
                ctx.fillText(String(c.val), cx, yOffset + 54);
                ctx.fillStyle = 'rgba(255,255,255,0.4)';
                ctx.font = '500 22px Arial, sans-serif';
                ctx.letterSpacing = '5px';
                ctx.fillText(c.lbl, cx, yOffset + 86);
            });
            yOffset += 130;

            // Chemistry / Rival inline
            if (partner) {
                _inlineStat(ctx, W/2 - 220, yOffset, '🤝', 'BEST PARTNER', partner.name, '#00ffa3');
            }
            if (rival) {
                _inlineStat(ctx, W/2 + 220, yOffset, '⚔️', 'RIVAL', rival.name, '#ff6b6b');
            }
            yOffset += 120;
        }

        // ── Footer ────────────────────────────────────────────────────────────
        const footerY = H - 100;
        _hRule(ctx, 80, footerY - 30, W - 80, 0.15);
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,255,163,0.45)';
        ctx.font      = '500 26px Arial, sans-serif';
        ctx.letterSpacing = '6px';
        ctx.fillText('@thecourtsidepro', W/2, footerY + 20);

        // Badminton silhouette watermarks
        _drawBgSilhouettes(ctx, W, H);

        return canvas;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DRAWING HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    function _drawStoryBlock(ctx, y, { icon, label, title, sub, color, highlight }) {
        const PAD = 80, BH = 230;
        const BW  = W - PAD * 2;

        // Card background
        ctx.save();
        ctx.beginPath();
        _roundRect(ctx, PAD, y, BW, BH, 28);
        ctx.fillStyle = highlight
            ? `rgba(${_hexToRgb(color)}, 0.12)`
            : 'rgba(255,255,255,0.04)';
        ctx.fill();

        if (highlight) {
            ctx.strokeStyle = `rgba(${_hexToRgb(color)}, 0.6)`;
            ctx.lineWidth   = 2.5;
            ctx.stroke();
        }
        ctx.restore();

        // Left accent bar
        ctx.fillStyle = color;
        ctx.fillRect(PAD, y + 24, 5, BH - 48);

        // Icon
        ctx.font      = '56px Arial';
        ctx.textAlign = 'left';
        ctx.fillText(icon, PAD + 34, y + 84);

        // Label
        ctx.fillStyle = `rgba(${_hexToRgb(color)}, 0.8)`;
        ctx.font      = '600 22px Arial, sans-serif';
        ctx.letterSpacing = '5px';
        ctx.fillText(label, PAD + 110, y + 64);

        // Title
        ctx.fillStyle = '#ffffff';
        ctx.font      = 'bold 64px "Arial Narrow", Arial, sans-serif';
        ctx.letterSpacing = '2px';
        const maxTitleW = BW - 130;
        _fitText(ctx, title, PAD + 110, y + 128, maxTitleW, 64, 40);

        // Sub
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font      = '500 26px Arial, sans-serif';
        ctx.letterSpacing = '2px';
        ctx.fillText(sub, PAD + 110, y + 170);

        return y + BH + 28;
    }

    function _inlineStat(ctx, cx, y, icon, label, name, color) {
        ctx.textAlign = 'center';
        ctx.font      = '36px Arial';
        ctx.fillText(icon, cx, y);
        ctx.fillStyle = `rgba(${_hexToRgb(color)}, 0.7)`;
        ctx.font      = '500 22px Arial, sans-serif';
        ctx.letterSpacing = '4px';
        ctx.fillText(label, cx, y + 34);
        ctx.fillStyle = '#ffffff';
        ctx.font      = 'bold 36px "Arial Narrow", Arial, sans-serif';
        ctx.letterSpacing = '1px';
        ctx.fillText(name.toUpperCase(), cx, y + 72);
    }

    function _pill(ctx, cx, y, text, color, fontSize = 28) {
        ctx.save();
        const metrics  = ctx.measureText ? ctx.measureText(text) : { width: 300 };
        ctx.font       = `600 ${fontSize}px Arial, sans-serif`;
        ctx.letterSpacing = '5px';
        const tw       = ctx.measureText(text).width;
        const ph = fontSize + 20, pw = tw + 60;
        ctx.beginPath();
        _roundRect(ctx, cx - pw/2, y - ph + 8, pw, ph, ph/2);
        ctx.fillStyle = `rgba(${_hexToRgb(color)}, 0.15)`;
        ctx.fill();
        ctx.strokeStyle = `rgba(${_hexToRgb(color)}, 0.4)`;
        ctx.lineWidth   = 1.5;
        ctx.stroke();
        ctx.fillStyle   = color;
        ctx.textAlign   = 'center';
        ctx.fillText(text, cx, y);
        ctx.restore();
    }

    function _hRule(ctx, x1, y, x2, alpha) {
        const grad = ctx.createLinearGradient(x1, 0, x2, 0);
        grad.addColorStop(0,   `rgba(255,255,255,0)`);
        grad.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
        grad.addColorStop(1,   `rgba(255,255,255,0)`);
        ctx.strokeStyle = grad;
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(x1, y); ctx.lineTo(x2, y);
        ctx.stroke();
    }

    function _fitText(ctx, text, x, y, maxW, maxSize, minSize) {
        let size = maxSize;
        ctx.font = `bold ${size}px "Arial Narrow", Arial, sans-serif`;
        while (ctx.measureText(text).width > maxW && size > minSize) {
            size -= 4;
            ctx.font = `bold ${size}px "Arial Narrow", Arial, sans-serif`;
        }
        ctx.fillText(text, x, y);
    }

    function _grain(ctx, w, h, density) {
        const count = Math.floor(w * h * density);
        ctx.save();
        for (let i = 0; i < count; i++) {
            const alpha = Math.random() * 0.06 + 0.01;
            ctx.fillStyle = `rgba(255,255,255,${alpha})`;
            ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
        }
        ctx.restore();
    }

    function _roundRect(ctx, x, y, w, h, r) {
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

    function _drawBgSilhouettes(ctx, W, H) {
        ctx.save();
        ctx.globalAlpha = 0.028;
        ctx.fillStyle   = '#00ffa3';

        // Two large ghost rackets in corners
        _ghostRacket(ctx, 100, H - 300, 260, -0.6);
        _ghostRacket(ctx, W - 100, 320, 200, 2.5);

        ctx.restore();
    }

    function _ghostRacket(ctx, cx, cy, size, angle) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        const r = size * 0.38;
        ctx.beginPath();
        ctx.ellipse(0, -size * 0.18, r * 0.72, r, 0, 0, Math.PI * 2);
        ctx.fill();
        const throatTop = -size * 0.18 + r;
        const hw = size * 0.06;
        ctx.fillRect(-hw, throatTop, hw * 2, size * 0.55);
        ctx.restore();
    }

    function _hexToRgb(hex) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `${r},${g},${b}`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SHARE UTILITY
    // ─────────────────────────────────────────────────────────────────────────

    async function _shareCanvas(canvas, filename) {
        try {
            canvas.toBlob(async blob => {
                if (!blob) { _fallbackDownload(canvas, filename); return; }
                const file = new File([blob], filename, { type: 'image/png' });

                // Try native share (mobile)
                if (navigator.share && navigator.canShare?.({ files: [file] })) {
                    try {
                        await navigator.share({
                            files: [file],
                            title: 'CourtSide Session Recap',
                            text:  'Badminton session recap 🏸',
                        });
                        return;
                    } catch (e) {
                        if (e.name !== 'AbortError') console.warn('Share failed:', e);
                    }
                }

                // Fallback: show preview modal with download option
                _showSharePreview(canvas, blob, filename);
            }, 'image/png');
        } catch (e) {
            console.error('SessionRecap share error:', e);
        }
    }

    function _showSharePreview(canvas, blob, filename) {
        // Remove any existing preview
        document.getElementById('_csRecapPreview')?.remove();

        const url     = URL.createObjectURL(blob);
        const overlay = document.createElement('div');
        overlay.id    = '_csRecapPreview';
        Object.assign(overlay.style, {
            position:   'fixed', inset: '0', zIndex: '20000',
            background: 'rgba(0,0,0,0.88)',
            display:    'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            padding:    '24px',
        });
        overlay.innerHTML = `
            <div style="font-family:'Arial Narrow',Arial,sans-serif; color:#00ffa3;
                        font-size:1rem; letter-spacing:6px; margin-bottom:16px; font-weight:600;">
                YOUR RECAP IS READY
            </div>
            <img src="${url}" style="max-width:min(320px,80vw); max-height:60vh;
                border-radius:16px; box-shadow:0 8px 48px rgba(0,255,163,0.25);">
            <div style="display:flex; gap:12px; margin-top:20px; width:100%; max-width:320px;">
                <a href="${url}" download="${filename}"
                   style="flex:1; padding:14px; background:#00ffa3; color:#07070c;
                          border-radius:12px; text-align:center; font-weight:700;
                          font-size:0.9rem; letter-spacing:2px; text-decoration:none;">
                    ↓ SAVE IMAGE
                </a>
                <button onclick="document.getElementById('_csRecapPreview').remove()"
                        style="flex:1; padding:14px; background:rgba(255,255,255,0.08);
                               color:#fff; border:none; border-radius:12px; cursor:pointer;
                               font-size:0.9rem; letter-spacing:2px;">
                    CLOSE
                </button>
            </div>
        `;
        overlay.addEventListener('click', e => {
            if (e.target === overlay) overlay.remove();
        });
        document.body.appendChild(overlay);
    }

    function _fallbackDownload(canvas, filename) {
        const a    = document.createElement('a');
        a.href     = canvas.toDataURL('image/png');
        a.download = filename;
        a.click();
    }

    return { shareMyRecap };
})();


// =============================================================================
// HOOK INTO EXISTING APP LIFECYCLE
// Initialise the tab bar once the sideline panel becomes visible.
// We patch SidelineView.show() non-destructively.
// =============================================================================

(function _hookStats() {
    const _origShow = typeof SidelineView !== 'undefined' && SidelineView.show;
    if (_origShow) {
        SidelineView.show = function (...args) {
            _origShow.apply(SidelineView, args);
            MyStatsTab.init();
        };
    }

    // Also init on DOMContentLoaded if panel is already visible
    document.addEventListener('DOMContentLoaded', () => {
        const panel = document.getElementById('sidelinePanel');
        if (panel && panel.style.display !== 'none') {
            MyStatsTab.init();
        }
    });
})();