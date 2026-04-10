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
        try {
            localStorage.setItem(PASSPORT_KEY, JSON.stringify(data));
        } catch (e) { console.error('[Passport] Failed to save to localStorage:', e); }
    },

    init(name = null) {
        let p = this.get();
        if (!p || !p.playerUUID) {
            p = {
                playerUUID: this._uuid(),
                playerName: name || '',
                spiritAnimal: null,
                lastProcessedTS: 0,
                createdAt:  Date.now(),
            };
            this.save(p);
        }
        
        // Migration: Ensure stats object exists for returning users
        if (!p.stats) {
            p.stats = { wins: 0, games: 0 };
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

    setSpiritAnimal(emoji) {
        const p = this.get();
        if (!p) return null;
        p.spiritAnimal = emoji;
        this.save(p);
        return p;
    },

    recordGame(isWin) {
        const p = this.get();
        if (!p) return;
        if (!p.stats) p.stats = { wins: 0, games: 0 };
        p.stats.games++;
        if (isWin) p.stats.wins++;
        this.save(p);
    },

    _uuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    },
};

// Expose globals for inline event handlers
window.Passport = Passport;