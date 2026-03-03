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
    'streak_3': {
        name: 'Triple Threat',
        description: 'Achieve a 3-game winning streak.',
        icon: '🔥'
    },
    'underdog': {
        name: 'Underdog',
        description: 'Win a match against a higher-rated team.',
        icon: '🐶'
    },
    'iron_man': {
        name: 'Iron Man',
        description: 'Play 5 games in a single session.',
        icon: '💪'
    }
};

/**
 * Main function called from logic.js after a match is decided.
 * It checks for any new achievements unlocked by the players involved.
 * @param {object} match - The completed match object from currentMatches.
 * @param {Array} squad - The global squad array.
 */
async function checkAndAwardAchievements(match, squad) {
    if (match.winnerTeamIndex === null) return;

    const winIdx = match.winnerTeamIndex;
    const loseIdx = winIdx === 0 ? 1 : 0;
    const winnerNames = match.teams[winIdx];
    
    const findP = (name) => squad.find(p => p.name === name);
    const winners = winnerNames.map(findP).filter(Boolean);
    const allPlayersInMatch = match.teams.flat().map(findP).filter(Boolean);

    await Promise.all(allPlayersInMatch.map(async (player) => {
           if (!player.uuid) return; // Cannot save achievements for players without a UUID (from passport)

        const existingAchievements = await fetchPlayerAchievements(player.uuid);
        const existingIds = new Set(existingAchievements.map(a => a.achievement_id));

        // --- CHECK WINNER-ONLY ACHIEVEMENTS ---
        if (winners.includes(player)) {
            // Check for 'first_win'
            if (!existingIds.has('first_win') && player.wins === 1) {
                unlockAchievement(player.uuid, 'first_win');
                showAchievementToast(player.name, Achievements.first_win);
            }
            // Check for 'streak_3'
            if (!existingIds.has('streak_3') && player.streak === 3) {
                unlockAchievement(player.uuid, 'streak_3');
                showAchievementToast(player.name, Achievements.streak_3);
            }
            // Check for 'underdog'
            const winnerTeamRating = match.teams[winIdx].map(findP).reduce((sum, p) => sum + p.rating, 0) / 2;
            const loserTeamRating = match.teams[loseIdx].map(findP).reduce((sum, p) => sum + p.rating, 0) / 2;
            if (!existingIds.has('underdog') && winnerTeamRating < loserTeamRating) {
                unlockAchievement(player.uuid, 'underdog');
                showAchievementToast(player.name, Achievements.underdog);
            }
        }
        
        // --- CHECK PARTICIPATION ACHIEVEMENTS ---
        // Check for 'iron_man'
        if (!existingIds.has('iron_man') && player.sessionPlayCount === 5) {
            unlockAchievement(player.uuid, 'iron_man');
            showAchievementToast(player.name, Achievements.iron_man);
        }
    }));
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
    if (typeof squad !== 'undefined') {
        const p = squad.find(p => p.uuid === player_uuid);
        if (p) {
            if (!p.achievements) p.achievements = [];
            if (!p.achievements.includes(achievement_id)) {
                p.achievements.push(achievement_id);
                if (typeof saveToDisk === 'function') saveToDisk();
            }
        }
    }

    try {
        await fetch('/api/match-history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'achievement_unlock',
                player_uuid: player_uuid,
                achievement_id: achievement_id
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

// Make these functions available to the other scripts.
window.checkAndAwardAchievements = checkAndAwardAchievements;
window.fetchPlayerAchievements = fetchPlayerAchievements;
window.Achievements = Achievements;
