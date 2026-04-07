// =============================================================================
// COURTSIDE PRO — polish.js
// Responsibilities: Haptic feedback, confetti burst, avatar color generation.
// No dependencies — loaded first, used by app.js and logic.js.
// =============================================================================

/** Robust HTML Escaping for XSS prevention */
function escapeHTML(str) {
    if (typeof str !== 'string') return String(str || '');
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
window.escapeHTML = escapeHTML;

/**
 * Normalizes a room code to the standard ABCD-1234 format.
 * Shared logic for client and server consistency.
 */
function normalizeRoomCode(raw) {
    if (!raw) return '';
    let code = String(raw).toUpperCase().trim();
    const stripped = code.replace(/[^A-Z0-9]/g, '');
    if (stripped.length === 8 && !code.includes('-')) {
        return stripped.slice(0, 4) + '-' + stripped.slice(4);
    }
    return code;
}
window.normalizeRoomCode = normalizeRoomCode;

/** Standardized Logging Utility */
const Log = {
    _prefix: '[CourtSide]',
    info:  (...args) => console.log('[CourtSide]', ...args),
    warn:  (...args) => console.warn('[CourtSide]', ...args),
    error: (...args) => console.error('[CourtSide]', ...args),
    debug: (...args) => {
        if (typeof localStorage !== 'undefined' && localStorage.getItem('cs_debug') === 'true') {
            console.debug('[CourtSide]', ...args);
        }
    }
};
window.Log = Log;

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
// Lazy-loaded wrapper for canvas-confetti (loaded from CDN on first use).
// ---------------------------------------------------------------------------

const Confetti = {
    async burst(x, y, count = 70) {
        // Suppress confetti if battery saver is on (host uses StateStore, player uses localStorage)
        const isHostSaver = (typeof StateStore !== 'undefined' && StateStore.get('batterySaver'));
        const isPlayerSaver = (localStorage.getItem('cs_battery_saver') === 'true');
        if (isHostSaver || isPlayerSaver) return;

        if (!window.confetti) {
            try {
                await new Promise((resolve, reject) => {
                    const s = document.createElement('script');
                    s.src = 'https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js';
                    s.onload = resolve;
                    s.onerror = reject;
                    document.head.appendChild(s);
                });
            } catch (e) {
                console.warn('Confetti failed to load', e);
                return;
            }
        }

        if (!window.confetti) return;

        // Convert absolute screen coords to 0-1 for library
        const originX = x / window.innerWidth;
        const originY = y / window.innerHeight;

        window.confetti({
            particleCount: count,
            origin: { x: originX, y: originY },
            colors: ['#00ffa3', '#ffffff', '#00cc80', '#a0ffd6'],
            disableForReducedMotion: true,
            zIndex: 9999,
        });
    }
};

// ---------------------------------------------------------------------------
// AVATAR COLOR GENERATOR
// Deterministic — same name always gets same color. Based on name hash.
// Returns a hsl color string.
// ---------------------------------------------------------------------------

const Avatar = (() => {
    // A palette of distinct, vibrant hues that all look good on dark bg
    const HUES = [162, 195, 220, 270, 330, 15, 45, 90, 0, 180, 240, 300];

    function hashName(name) {
        const str = String(name || '');
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
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
        const parts = (name || '').trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) return '?';
        if (parts.length === 1) return parts[0][0].toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    /**
     * Returns full avatar HTML for use inside a chip or card.
     */
    function html(name, emoji = null) {
        const bg  = color(name);
        const ini = initials(name);
        const content = emoji || ini;
        return `<span class="avatar" style="background:${bg}; font-style: ${emoji ? 'normal' : 'italic'};">${content}</span>`;
    }

    return { color, initials, html };
})();