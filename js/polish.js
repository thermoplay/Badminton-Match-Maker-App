// =============================================================================
// COURTSIDE PRO — polish.js  v2
// =============================================================================
// FIXES:
//   #16 — Avatar.color now generates hue from a continuous 0–360 range using
//          a hash-to-float mapping instead of indexing into a fixed 12-element
//          palette. With 360° of possible hues and a well-distributed hash,
//          collisions are rare even with 20+ players. The saturation and
//          lightness are also slightly varied per player so two names that
//          happen to land near the same hue are still visually distinct.
// =============================================================================

// ---------------------------------------------------------------------------
// HAPTIC
// ---------------------------------------------------------------------------

const Haptic = {
    tap()     { this._vibe(10);  },
    bump()    { this._vibe(25);  },
    success() { this._vibe([40, 30, 40]); },
    error()   { this._vibe([80, 40, 80]); },

    _vibe(pattern) {
        try {
            if (navigator.vibrate) navigator.vibrate(pattern);
        } catch { /* not supported */ }
    },
};

// ---------------------------------------------------------------------------
// CONFETTI
// ---------------------------------------------------------------------------

const Confetti = {
    _pool: [],
    _active: [],
    _raf: null,
    _canvas: null,
    _ctx: null,

    _init() {
        if (this._canvas) return;
        this._canvas = document.createElement('canvas');
        this._canvas.id = 'confettiCanvas';
        Object.assign(this._canvas.style, {
            position:      'fixed',
            top:           '0',
            left:          '0',
            width:         '100%',
            height:        '100%',
            pointerEvents: 'none',
            zIndex:        '9999',
        });
        document.body.appendChild(this._canvas);
        this._ctx = this._canvas.getContext('2d');
        this._resize();
        window.addEventListener('resize', () => this._resize());
    },

    _resize() {
        if (!this._canvas) return;
        this._canvas.width  = window.innerWidth;
        this._canvas.height = window.innerHeight;
    },

    burst(cx, cy, count = 60) {
        this._init();
        const colors = ['#00e5a0','#00c3ff','#ff6b6b','#ffd166','#a29bfe','#fd79a8','#55efc4'];
        for (let i = 0; i < count; i++) {
            const angle  = (Math.random() * Math.PI * 2);
            const speed  = 3 + Math.random() * 8;
            const color  = colors[Math.floor(Math.random() * colors.length)];
            const size   = 4 + Math.random() * 6;
            const shape  = Math.random() < 0.5 ? 'rect' : 'circle';
            const spin   = (Math.random() - 0.5) * 0.3;

            let p;
            if (this._pool.length > 0) {
                p = this._pool.pop();
            } else {
                p = {};
            }
            Object.assign(p, {
                x:   cx, y:   cy,
                vx:  Math.cos(angle) * speed,
                vy:  Math.sin(angle) * speed - 4,
                color, size, shape, spin,
                rot:   Math.random() * Math.PI * 2,
                life:  1,
                decay: 0.012 + Math.random() * 0.008,
            });
            this._active.push(p);
        }
        if (!this._raf) this._loop();
    },

    _loop() {
        const ctx = this._ctx;
        ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

        const gravity = 0.25;
        const drag    = 0.98;
        const alive   = [];

        for (const p of this._active) {
            p.vy   += gravity;
            p.vx   *= drag;
            p.vy   *= drag;
            p.x    += p.vx;
            p.y    += p.vy;
            p.rot  += p.spin;
            p.life -= p.decay;

            if (p.life <= 0 || p.y > this._canvas.height + 20) {
                this._pool.push(p);
                continue;
            }
            alive.push(p);

            ctx.save();
            ctx.globalAlpha = p.life;
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.fillStyle = p.color;

            if (p.shape === 'rect') {
                ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
            } else {
                ctx.beginPath();
                ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }

        this._active = alive;

        if (this._active.length > 0) {
            this._raf = requestAnimationFrame(() => this._loop());
        } else {
            this._raf = null;
            ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
        }
    },
};

// ---------------------------------------------------------------------------
// AVATAR
// FIX #16: replaced fixed 12-hue palette with a continuous hue derived from
// a full 32-bit hash. Saturation and lightness are also slightly varied so
// near-collision hues still look distinct.
// ---------------------------------------------------------------------------

const Avatar = {

    // Maps a name string to a stable integer hash (FNV-1a 32-bit)
    _hash(name) {
        let h = 0x811c9dc5;
        for (let i = 0; i < name.length; i++) {
            h ^= name.charCodeAt(i);
            h = (h * 0x01000193) >>> 0; // keep 32-bit unsigned
        }
        return h;
    },

    // FIX #16: derive hue from the full 32-bit range (0–359) instead of
    // indexing into a 12-element array. Secondary hash for saturation/lightness
    // variation ensures near-hue names are still visually distinct.
    color(name) {
        if (!name) return 'hsl(162, 70%, 50%)';
        const h1  = this._hash(name);
        const h2  = this._hash(name + '\x01'); // secondary hash for S/L
        const hue = h1 % 360;
        const sat = 60 + (h2 % 20);           // 60–79%
        const lit = 45 + ((h2 >> 5) % 15);    // 45–59%
        return `hsl(${hue}, ${sat}%, ${lit}%)`;
    },

    initials(name) {
        if (!name) return '?';
        const parts = name.trim().split(/\s+/);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        }
        return name.slice(0, 2).toUpperCase();
    },

    render(name, size = 36) {
        const bg  = this.color(name);
        const ini = this.initials(name);
        return `
            <div class="avatar-circle"
                 style="width:${size}px;height:${size}px;background:${bg};font-size:${Math.round(size * 0.38)}px;">
                ${ini}
            </div>`;
    },
};

// ---------------------------------------------------------------------------
// TOAST helpers
// ---------------------------------------------------------------------------

function showToast(message, duration = 2500) {
    let toast = document.getElementById('globalToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'globalToast';
        toast.className = 'global-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
}

// ---------------------------------------------------------------------------
// SCROLL LOCK helpers (for modals)
// ---------------------------------------------------------------------------

let _scrollLockDepth = 0;

function lockScroll() {
    _scrollLockDepth++;
    if (_scrollLockDepth === 1) {
        document.body.style.overflow = 'hidden';
        document.body.style.touchAction = 'none';
    }
}

function unlockScroll() {
    _scrollLockDepth = Math.max(0, _scrollLockDepth - 1);
    if (_scrollLockDepth === 0) {
        document.body.style.overflow = '';
        document.body.style.touchAction = '';
    }
}

// ---------------------------------------------------------------------------
// PULL-TO-REFRESH guard (prevent native overscroll interfering with the app)
// ---------------------------------------------------------------------------

(function disablePullToRefresh() {
    let startY = 0;
    document.addEventListener('touchstart', e => {
        startY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchmove', e => {
        const dy = e.touches[0].clientY - startY;
        if (dy > 0 && window.scrollY === 0) {
            e.preventDefault();
        }
    }, { passive: false });
})();

// ---------------------------------------------------------------------------
// SKELETON LOADER helper
// ---------------------------------------------------------------------------

function showSkeleton(containerId, rows = 3) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = Array.from({ length: rows }, () => `
        <div class="skeleton-row">
            <div class="skeleton-avatar skeleton-pulse"></div>
            <div class="skeleton-lines">
                <div class="skeleton-line skeleton-pulse" style="width:60%"></div>
                <div class="skeleton-line skeleton-pulse" style="width:40%"></div>
            </div>
        </div>
    `).join('');
}

function hideSkeleton(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const skeletons = el.querySelectorAll('.skeleton-row');
    skeletons.forEach(s => s.remove());
}

// ---------------------------------------------------------------------------
// NEXT UP TICKER
// ---------------------------------------------------------------------------

function updateNextUpTicker(players) {
    const el = document.getElementById('nextUpNames');
    if (!el) return;

    if (!players || players.length === 0) {
        el.textContent           = '—';
        el.closest?.('.next-up-row')?.style && (el.closest('.next-up-row').style.display = 'none');
        return;
    }

    const names = players.map(p => p.name).join(' · ');
    el.textContent = names;
    const row = el.closest?.('.next-up-row');
    if (row) row.style.display = 'flex';

    window._lastNextUp = names;

    if (typeof broadcastGameState === 'function') broadcastGameState();
}

// ---------------------------------------------------------------------------
// SIDELINE (bench/spectator strip) renderer
// ---------------------------------------------------------------------------

function updateSideline() {
    const container = document.getElementById('sidelineStrip');
    if (!container) return;

    const playing = new Set(
        (window.currentMatches || []).flatMap(m => m.teams.flat())
    );
    const bench = (window.squad || []).filter(p => p.active && !playing.has(p.name));

    if (bench.length === 0) {
        container.innerHTML = '<span class="sideline-empty">Full court — everyone is playing!</span>';
        return;
    }

    container.innerHTML = bench.map(p => `
        <div class="sideline-chip">
            ${Avatar.render(p.name, 28)}
            <span class="sideline-name">${escapeHTML(p.name)}</span>
        </div>
    `).join('');
}

// ---------------------------------------------------------------------------
// AURA POSTER (share card)
// ---------------------------------------------------------------------------

async function shareAuraPoster(matchIdx) {
    const match = (window.currentMatches || [])[matchIdx];
    if (!match) return;

    const [tA, tB] = match.teams;
    const [oddsA, oddsB] = match.odds || [50, 50];

    const canvas  = document.createElement('canvas');
    canvas.width  = 800;
    canvas.height = 450;
    const ctx     = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Title
    ctx.fillStyle    = '#00e5a0';
    ctx.font         = 'bold 22px system-ui, sans-serif';
    ctx.textAlign    = 'center';
    ctx.fillText(`GAME ${matchIdx + 1}`, canvas.width / 2, 50);

    // Teams
    ctx.fillStyle = '#ffffff';
    ctx.font      = 'bold 36px system-ui, sans-serif';
    ctx.fillText(tA.join(' & '), canvas.width / 4, 160);
    ctx.fillText(tB.join(' & '), (canvas.width / 4) * 3, 160);

    // VS
    ctx.fillStyle = '#666';
    ctx.font      = 'bold 28px system-ui, sans-serif';
    ctx.fillText('VS', canvas.width / 2, 160);

    // Odds
    ctx.fillStyle = '#00e5a0';
    ctx.font      = 'bold 48px system-ui, sans-serif';
    ctx.fillText(`${oddsA}%`, canvas.width / 4, 280);
    ctx.fillStyle = '#00c3ff';
    ctx.fillText(`${oddsB}%`, (canvas.width / 4) * 3, 280);

    // Branding
    ctx.fillStyle = '#444';
    ctx.font      = '16px system-ui, sans-serif';
    ctx.fillText('CourtSide Pro', canvas.width / 2, 420);

    try {
        canvas.toBlob(async blob => {
            if (!blob) return;
            const file = new File([blob], 'aura-poster.png', { type: 'image/png' });
            if (navigator.share && navigator.canShare?.({ files: [file] })) {
                await navigator.share({ files: [file], title: 'CourtSide Match', text: `Game ${matchIdx + 1}: ${tA.join(' & ')} vs ${tB.join(' & ')}` });
            } else {
                const url = URL.createObjectURL(blob);
                const a   = document.createElement('a');
                a.href    = url;
                a.download = 'aura-poster.png';
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 5000);
            }
        }, 'image/png');
    } catch (e) {
        console.error('shareAuraPoster:', e);
    }
}