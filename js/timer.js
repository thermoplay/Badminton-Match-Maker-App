// =============================================================================
// COURTSIDE PRO — timer.js
// Responsibilities: Manages and updates all visible timers on the screen.
// =============================================================================

const TimerManager = (() => {
    let timerInterval = null;

    function formatTime(ms) {
        if (ms < 0) ms = 0;
        const totalSecs = Math.floor(ms / 1000);
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function tick() {
        const now = Date.now();

        // Host match card timers
        document.querySelectorAll('.match-card[data-started]').forEach(card => {
            const started = parseInt(card.dataset.started, 10);
            if (!started) return;
            const elapsed = now - started;
            const timerEl = card.querySelector('.court-timer');
            if (!timerEl) return;

            timerEl.textContent = formatTime(elapsed);
            timerEl.classList.toggle('timer-warn',  elapsed > 10 * 60 * 1000);
            timerEl.classList.toggle('timer-alert', elapsed > 15 * 60 * 1000);
        });

        // Player sideline view timers
        document.querySelectorAll('.sl-match-card[data-started]').forEach(card => {
            const started = parseInt(card.dataset.started, 10);
            if (!started) return;
            const elapsed = now - started;
            const timerEl = card.querySelector('.sl-court-timer');
            if (timerEl) {
                timerEl.textContent = `⏱ ${formatTime(elapsed)}`;
                timerEl.classList.toggle('sl-timer-warn',  elapsed > 10 * 60 * 1000);
                timerEl.classList.toggle('sl-timer-alert', elapsed > 15 * 60 * 1000);
            }
        });
    }

    function start() {
        if (timerInterval) return; // Already running
        tick(); // Tick immediately
        timerInterval = setInterval(tick, 1000);
    }

    return { start };
})();

// Start the timer manager automatically when the script loads.
TimerManager.start();