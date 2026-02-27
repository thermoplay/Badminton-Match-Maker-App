// =============================================================================
// COURTSIDE PRO — polish.js
// Responsibilities: Haptic feedback, confetti burst, avatar color generation.
// No dependencies — loaded first, used by app.js and logic.js.
// =============================================================================

// ---------------------------------------------------------------------------
// HAPTIC FEEDBACK
// Wraps navigator.vibrate with graceful fallback for unsupported devices.
// ---------------------------------------------------------------------------

const Haptic = {
    /** Short tap — winner select, chip press */
    tap()    { navigator.vibrate?.([10]); },
    /** Medium bump — round generated */
    bump()   { navigator.vibrate?.([20, 30, 20]); },
    /** Success pattern — confirm team builder */
    success(){ navigator.vibrate?.([10, 40, 10]); },
    /** Error pattern — validation fail */
    error()  { navigator.vibrate?.([40, 30, 40]); },
};

// ---------------------------------------------------------------------------
// CONFETTI BURST
// Pure canvas-based — no libraries. Fires from the winning team-box position.
// ---------------------------------------------------------------------------

const Confetti = (() => {
    let canvas, ctx, particles = [], raf;

    const COLORS = ['#00ffa3', '#ffffff', '#00cc80', '#a0ffd6', '#00ffa344'];

    function init() {
        if (canvas) return;
        canvas = document.createElement('canvas');
        canvas.id = 'confettiCanvas';
        Object.assign(canvas.style, {
            position:       'fixed',
            inset:          '0',
            width:          '100%',
            height:         '100%',
            pointerEvents:  'none',
            zIndex:         '9999',
        });
        document.body.appendChild(canvas);
        ctx = canvas.getContext('2d');
        resize();
        window.addEventListener('resize', resize);
    }

    function resize() {
        if (!canvas) return;
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
    }

    /**
     * Spawns a burst of confetti from a given origin point.
     * @param {number} originX - X coordinate (pixels from left)
     * @param {number} originY - Y coordinate (pixels from top)
     * @param {number} count   - Number of particles (default 60)
     */
    function burst(originX, originY, count = 70) {
        init();
        for (let i = 0; i < count; i++) {
            const angle  = (Math.random() * Math.PI * 2);
            const speed  = 1.5 + Math.random() * 4.5;   // slower launch speed
            const size   = 5 + Math.random() * 7;
            // Mix rectangles and squares for variety
            const isSquare = Math.random() > 0.6;
            particles.push({
                x:      originX,
                y:      originY,
                vx:     Math.cos(angle) * speed,
                vy:     Math.sin(angle) * speed - 3.5, // gentler upward bias
                rot:    Math.random() * 360,
                rotV:   (Math.random() - 0.5) * 5,     // slower spin
                w:      size,
                h:      isSquare ? size : size * 0.38,
                color:  COLORS[Math.floor(Math.random() * COLORS.length)],
                life:   1,
                decay:  0.006 + Math.random() * 0.006, // much slower decay = longer life
            });
        }
        if (!raf) loop();
    }

    function loop() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles = particles.filter(p => p.life > 0);

        particles.forEach(p => {
            p.x   += p.vx;
            p.y   += p.vy;
            p.vy  += 0.12;   // gentler gravity — floats longer
            p.vx  *= 0.99;   // very light air resistance
            p.rot += p.rotV;
            p.life -= p.decay;

            ctx.save();
            ctx.globalAlpha = Math.max(0, p.life);
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rot * Math.PI) / 180);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        });

        if (particles.length > 0) {
            raf = requestAnimationFrame(loop);
        } else {
            raf = null;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }

    return { burst };
})();

// ---------------------------------------------------------------------------
// AVATAR COLOR GENERATOR
// Deterministic — same name always gets same color. Based on name hash.
// Returns a hsl color string.
// ---------------------------------------------------------------------------

const Avatar = (() => {
    // A palette of distinct, vibrant hues that all look good on dark bg
    const HUES = [162, 195, 220, 270, 330, 15, 45, 90, 0, 180, 240, 300];

    function hashName(name) {
        let h = 0;
        for (let i = 0; i < name.length; i++) {
            h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
        }
        return Math.abs(h);
    }

    /**
     * Returns a CSS background color for a given player name.
     * Always the same color for the same name.
     */
    function color(name) {
        const hue = HUES[hashName(name) % HUES.length];
        return `hsl(${hue}, 70%, 38%)`;
    }

    /**
     * Returns the initials for a player name (up to 2 chars).
     * "John Doe" → "JD", "Mawi" → "M"
     */
    function initials(name) {
        const parts = name.trim().split(/\s+/);
        if (parts.length === 1) return parts[0][0].toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    /**
     * Returns full avatar HTML for use inside a chip or card.
     */
    function html(name) {
        const bg  = color(name);
        const ini = initials(name);
        return `<span class="avatar" style="background:${bg};">${ini}</span>`;
    }

    return { color, initials, html };
})();