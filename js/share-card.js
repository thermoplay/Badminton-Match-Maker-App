// =============================================================================
// SHARE-CARD.JS — Procedural Canvas Image Generation
// =============================================================================
// Responsibilities:
//   - Generate a 9:16 Instagram-ready image using pure Canvas.
//   - No html2canvas, no DOM dependencies.
//   - Provides share functionality for both player and host views.
// =============================================================================

// This file contains canvas helper functions that are used by both:
//  - slShareMatch() (for sharing a player's own match)
//  - shareAuraPoster() in app.js (for the host sharing any match)
// They are consolidated here to avoid code duplication.

// =============================================================================
// PLAYER MATCH SHARE — Canvas Story Card
// Generates a 9:16 Instagram-ready image using pure Canvas.
// No html2canvas, no DOM dependencies.
// =============================================================================

/**
 * Generic canvas renderer for 9:16 shareable images.
 * @param {object} options - The content to render on the card.
 * @param {string|string[]} options.teamA - Name(s) for Team A.
 * @param {string|string[]} options.teamB - Name(s) for Team B.
 * @param {string} options.title - The main title (e.g., "LIVE NOW").
 */
async function generateShareableImage({ teamA, teamB, title = 'LIVE NOW' }) {
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
    ctx.fillText(title, liveTextX, liveY);
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
    _drawTeamBlock(ctx, W/2, midY - 260, teamA, '#ffffff', W);
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
    _drawTeamBlock(ctx, W/2, midY + 170, teamB, '#ffffff', W);
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
        if (!blob) return;
        try {
            const file = new File([blob], 'courtside-matchup.png', { type: 'image/png' });
            
            const tAStr = Array.isArray(teamA) ? teamA.join(' & ') : teamA;
            const tBStr = Array.isArray(teamB) ? teamB.join(' & ') : teamB;
            const shareText = `🏸 ${tAStr} vs ${tBStr} — who you got? #CourtSide`;

            // Check if navigator.canShare is a function before calling it to prevent TypeErrors
            if (navigator.share && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
                await navigator.share({ title: 'CourtSide Live', text: shareText, files: [file] })
                    .catch(() => _downloadShareImage(blob));
            } else {
                _downloadShareImage(blob);
            }
        } catch (e) {
            Log.error('Share failed:', e);
            _downloadShareImage(blob);
        }
    }, 'image/png');
}

/**
 * Generates a special MVP poster for the end of a session.
 */
async function generateMVPPoster(name, wins, totalSessionGames) {
    const W = 1080, H = 1920;
    const canvas = document.createElement('canvas');
    canvas.width  = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Background: Deep gradient
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a0a1a');
    bg.addColorStop(0.5, '#0a0a0f');
    bg.addColorStop(1, '#1a0a0a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    _drawGrain(ctx, W, H, 0.02);
    _drawCourtLines(ctx, W, H);

    // Trophy Icon Shadow
    ctx.fillStyle = 'rgba(0,255,163,0.05)';
    ctx.font = '400px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('🏆', W/2, H/2 + 100);

    // Top Branding
    ctx.fillStyle = '#00ffa3';
    ctx.font = 'bold 44px "Arial Narrow", Arial, sans-serif';
    ctx.letterSpacing = '12px';
    ctx.fillText('SESSION RECAP', W/2, 180);

    // Main Title
    ctx.save();
    ctx.shadowColor = 'rgba(0,255,163,0.5)';
    ctx.shadowBlur = 30;
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 120px "Arial Narrow", Arial, sans-serif';
    ctx.letterSpacing = '4px';
    ctx.fillText('SESSION MVP', W/2, H*0.35);
    ctx.restore();

    // Player Name
    ctx.fillStyle = '#00ffa3';
    ctx.font = 'italic 900 180px "Arial Narrow", Arial, sans-serif';
    ctx.fillText(name.toUpperCase(), W/2, H*0.48);

    // Stats Box
    const boxY = H * 0.6;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    _roundRect(ctx, 150, boxY, W - 300, 300, 30);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,255,163,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Stat 1: Wins
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 100px Arial';
    ctx.fillText(wins, W/2 - 180, boxY + 140);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = 'bold 30px Arial';
    ctx.letterSpacing = '4px';
    ctx.fillText('WINS', W/2 - 180, boxY + 200);

    // Divider
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath(); ctx.moveTo(W/2, boxY + 60); ctx.lineTo(W/2, boxY + 240); ctx.stroke();

    // Stat 2: Total Session Games
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 100px Arial';
    ctx.fillText(totalSessionGames, W/2 + 180, boxY + 140);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = 'bold 30px Arial';
    ctx.letterSpacing = '4px';
    ctx.fillText('GAMES', W/2 + 180, boxY + 200);

    // Footer
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = 'bold 32px Arial';
    ctx.letterSpacing = '6px';
    ctx.fillText('THECOURTSIDEPRO.VERCEL.APP', W/2, H - 120);

    canvas.toBlob(async (blob) => {
        if (!blob) return;
        const file = new File([blob], 'session-mvp.png', { type: 'image/png' });
        if (navigator.share && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
            await navigator.share({ title: 'Session MVP', text: `${name} is the MVP! 🏆`, files: [file] }).catch(() => _downloadShareImage(blob));
        } else {
            _downloadShareImage(blob);
        }
    }, 'image/png');
}

async function slShareMatch(matchIdx) {
    const m = (window.currentMatches || [])[matchIdx];
    if (!m) return;
    const teams = m.teams || [];

    await generateShareableImage({
        teamA: teams[0] || [],
        teamB: teams[1] || [],
        title: 'LIVE NOW'
    });
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
    const parts = Array.isArray(names) ? names : String(names).split(/\s*&\s*/);

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
        const text = parts[0] || String(names);
        ctx.fillText(text.toUpperCase(), cx, y + 54);
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

// Expose the main function to the window for inline `onclick` handlers
window.slShareMatch = slShareMatch;
window.generateMVPPoster = generateMVPPoster;
window.generateShareableImage = generateShareableImage; // Expose generic function
