// =============================================================================
// COURTSIDE PRO — achievements.js
// Responsibilities: Defines achievements, checks for unlock conditions,
//                  and communicates with the backend to save them.
// =============================================================================

// Define all possible achievements in the app
const Achievements = {
    'first_win': {
        name: 'First Victory',
        description: 'Win your first game.',
        icon: '🏆'
    },
    'streak': {
        name: 'Win Streak',
        icon: '🔥',
        tiers: [
            { id: '3',  name: 'Triple Threat', count: 3,  color: '#cd7f32', description: 'Achieve a 3-game winning streak.' },
            { id: '5',  name: 'High Five',      count: 5,  color: '#c0c0c0', description: 'Achieve a 5-game winning streak.' },
            { id: '10', name: 'Legendary',     count: 10, color: '#ffd700', description: 'Achieve a 10-game winning streak.' }
        ]
    },
    'underdog': {
        name: 'Underdog',
        description: 'Win a match against a higher-rated team.',
        icon: '🐶'
    },
    'endurance': {
        name: 'Iron Man',
        icon: '💪',
        tiers: [
            { id: '5',  name: 'Iron Man',   count: 5,  color: '#cd7f32', description: 'Play 5 games in a single session.' },
            { id: '10', name: 'Veteran',    count: 10, color: '#c0c0c0', description: 'Play 10 games in a single session.' },
            { id: '15', name: 'Unstoppable',count: 15, color: '#ffd700', description: 'Play 15 games in a single session.' }
        ]
    },
    'socialite': {
        name: 'Social Butterfly',
        description: 'Play with 3 different partners.',
        icon: '🦋'
    },
};

/**
 * Main function called from logic.js after a match is decided.
 * It checks for any new achievements unlocked by the players involved.
 * @param {object} match - The completed match object from currentMatches.
 * @param {Array} squad - The global squad array.
 * @returns {Promise<Array>} - Resolves to a list of newly unlocked achievements { player_uuid, achievement_id }.
 */
async function checkAndAwardAchievements(match, squad) {
    if (match.winnerTeamIndex === null || !squad) return [];

    const winIdx = match.winnerTeamIndex;
    const loseIdx = winIdx === 0 ? 1 : 0;
    const winnerUUIDs = match.teams[winIdx];
    const newlyUnlocked = [];

    const findP = (id) => squad.find(p => p.uuid === id);
    const winners = winnerUUIDs.map(findP).filter(Boolean);
    const allPlayersInMatch = match.teams.flat().map(findP).filter(Boolean);

    // This loop can now be synchronous as we are not fetching from the DB on every check.
    // Historical achievements are loaded into the player object when they join the session.
    for (const player of allPlayersInMatch) {
        if (!player.uuid) continue; // Cannot save achievements for players without a UUID.

        if (!Array.isArray(player.achievements)) player.achievements = [];
        const unlocked = new Set(player.achievements);

        // --- CHECK WINNER-ONLY ACHIEVEMENTS ---
        if (winners.includes(player)) {
            // Check for 'first_win'
            if (!unlocked.has('first_win') && player.wins === 1) {
                player.achievements.push('first_win');
                unlocked.add('first_win');
                newlyUnlocked.push({ player_uuid: player.uuid, achievement_id: 'first_win' });
                showAchievementToast(player.name, Achievements.first_win);
            }
            // Check for 'streak' tiers
            Achievements.streak.tiers.forEach(tier => {
                const tid = `streak_${tier.id}`;
                if (!unlocked.has(tid) && player.streak >= tier.count) {
                    player.achievements.push(tid);
                    unlocked.add(tid);
                    newlyUnlocked.push({ player_uuid: player.uuid, achievement_id: tid });
                    showAchievementToast(player.name, { ...tier, icon: Achievements.streak.icon });
                }
            });
            // Check for 'underdog'
            const getAvgRating = (uuids) => {
                const team = uuids.map(findP).filter(Boolean);
                if (team.length === 0) return 1200;
                return team.reduce((sum, p) => sum + (p.rating || 1200), 0) / team.length;
            };
            const winnerTeamRating = getAvgRating(match.teams[winIdx]);
            const loserTeamRating = getAvgRating(match.teams[loseIdx]);
            if (!unlocked.has('underdog') && winnerTeamRating < loserTeamRating) {
                player.achievements.push('underdog');
                unlocked.add('underdog');
                newlyUnlocked.push({ player_uuid: player.uuid, achievement_id: 'underdog' });
                showAchievementToast(player.name, Achievements.underdog);
            }
        }

        // --- CHECK PARTICIPATION ACHIEVEMENTS ---
        Achievements.endurance.tiers.forEach(tier => {
            const tid = `endurance_${tier.id}`;
            if (!unlocked.has(tid) && player.sessionPlayCount >= tier.count) {
                player.achievements.push(tid);
                unlocked.add(tid);
                newlyUnlocked.push({ player_uuid: player.uuid, achievement_id: tid });
                showAchievementToast(player.name, { ...tier, icon: Achievements.endurance.icon });
            }
        });
        // Check for 'socialite'
        const uniquePartners = Object.keys(player.partnerStats || {}).length;
        if (!unlocked.has('socialite') && uniquePartners >= 3) {
            player.achievements.push('socialite');
            unlocked.add('socialite');
            newlyUnlocked.push({ player_uuid: player.uuid, achievement_id: 'socialite' });
            showAchievementToast(player.name, Achievements.socialite);
        }
    }

    if (newlyUnlocked.length > 0 && typeof saveToDisk === 'function') saveToDisk();
    return newlyUnlocked;
}

/**
 * Fetches a player's unlocked achievements from the server.
 * @param {string} player_uuid - The UUID of the player.
 * @returns {Promise<Array>} - A promise that resolves to an array of achievement objects.
 */
async function fetchPlayerAchievements(player_uuid) {
    if (!player_uuid) return [];

    try {
        const res = await fetch(`/api/match-history?player_uuid=${encodeURIComponent(player_uuid)}`);
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data.achievements) ? data.achievements : [];
    } catch (e) {
        console.warn('Failed to fetch achievements (network or API error):', e);
        return [];
    }
}

/**
 * Calls the backend to save a newly unlocked achievement.
 * @param {string} player_uuid - The UUID of the player.
 * @param {string} achievement_id - The key of the achievement from the Achievements object.
 */
async function unlockAchievement(player_uuid, achievement_id) {
    if (!player_uuid) return;

    // 1. Update local state
    if (typeof StateStore !== 'undefined') {
        const p = StateStore.squad.find(p => p.uuid === player_uuid);
        if (p) {
            if (!Array.isArray(p.achievements)) p.achievements = [];
            if (!p.achievements.includes(achievement_id)) {
                p.achievements.push(achievement_id);
                if (typeof saveToDisk === 'function') saveToDisk();
            }
        }
    }

    try {
        // Use the new, secure endpoint
        await fetch('/api/match-history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'achievement_unlock',
                player_uuid: player_uuid,
                achievement_id: achievement_id,
                room_code: window.currentRoomCode,
                operator_key: window.operatorKey, // operatorKey exposed by sync.js
            })
        });
    } catch (e) {
        console.error('Failed to unlock achievement:', e);
    }
}

/**
 * Shows a temporary notification that an achievement was unlocked.
 * @param {string} playerName - The name of the player who unlocked the achievement.
 * @param {object} achievement - The achievement object from the Achievements definition.
 */
function showAchievementToast(playerName, achievement) {
    // This relies on a function in app.js. We'll add it later.
    if (typeof showSessionToast === 'function') {
        showSessionToast(`${achievement.icon} ${playerName} unlocked: ${achievement.name}`);
    } else {
        console.log(`[Achievement Unlocked!] ${playerName} earned: ${achievement.name}`);
    }
}

/**
 * Shows a toast with the achievement's full details.
 */
function showAchievementDescription(key, unlockedIds = []) {
    const display = getAchievementDisplay(key, unlockedIds);
    if (!display) return;
    if (typeof showSessionToast === 'function') {
        showSessionToast(`${display.icon} ${display.name}: ${display.description}`);
    }
}

function getAchievementDisplay(key, unlockedIds) {
    const def = Achievements[key];
    const ids = Array.isArray(unlockedIds) ? unlockedIds : [];
    if (!def) return null;
    if (!def.tiers) {
        return { unlocked: ids.includes(key), icon: def.icon, name: def.name, description: def.description, color: 'inherit' };
    }
    let highest = null;
    def.tiers.forEach(tier => { if (ids.includes(`${key}_${tier.id}`)) highest = tier; });
    if (!highest) {
        return { unlocked: false, icon: def.icon, name: def.name, description: def.tiers[0].description, color: 'inherit' };
    }
    return {
        unlocked: true,
        icon: def.icon,
        name: highest.name,
        description: highest.description,
        color: highest.color
    };
}

// Make these functions available to the other scripts.
window.checkAndAwardAchievements = checkAndAwardAchievements;
window.fetchPlayerAchievements = fetchPlayerAchievements;
window.Achievements = Achievements;
window.showAchievementDescription = showAchievementDescription;
window.getAchievementDisplay = getAchievementDisplay;
