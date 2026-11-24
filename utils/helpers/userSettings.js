const { getDb } = require("@utils/db/database");
const { FORMATS, QUALITIES, resolveProfile } = require("@utils/helpers/player/audioFormats");

/**
 * Per-user download preferences, set with /drive settings.
 *
 * destination: where single tracks go when Google Drive is linked
 *   "ask"     - ask every time (default)
 *   "drive"   - save to Google Drive
 *   "discord" - send the file in Discord
 * Files too big for Discord always ask, and nothing here applies while Drive isn't linked.
 */

const DESTINATIONS = ["ask", "drive", "discord"];
const DEFAULT_SETTINGS = Object.freeze({ destination: "ask", format: null, quality: null });

/**
 * @param {string} userId
 * @returns {{ destination: "ask" | "drive" | "discord", format: string | null, quality: string | null }}
 */
function getSettings(userId) {
    const row = getDb()
        .prepare("SELECT destination, format, quality FROM user_settings WHERE user_id = ?")
        .get(userId);
    return row ? { ...DEFAULT_SETTINGS, ...row } : { ...DEFAULT_SETTINGS };
}

/**
 * Updates some settings, leaving the others as they are.
 * @param {string} userId
 * @param {{ destination?: string, format?: string | null, quality?: string | null }} changes
 * @returns {ReturnType<typeof getSettings>} The new settings
 */
function updateSettings(userId, changes) {
    if (changes.destination !== undefined && !DESTINATIONS.includes(changes.destination))
        throw new Error(`Unknown destination: ${changes.destination}`);
    if (changes.format != null && !FORMATS[changes.format])
        throw new Error(`Unknown format: ${changes.format}`);
    if (changes.quality != null && !QUALITIES.includes(changes.quality))
        throw new Error(`Unknown quality: ${changes.quality}`);

    const next = { ...getSettings(userId), ...changes };
    getDb().prepare(`
        INSERT INTO user_settings (user_id, destination, format, quality, updated_at)
        VALUES (@userId, @destination, @format, @quality, @now)
        ON CONFLICT (user_id) DO UPDATE SET
            destination = excluded.destination,
            format      = excluded.format,
            quality     = excluded.quality,
            updated_at  = excluded.updated_at
    `).run({ userId, ...next, now: Date.now() });

    return next;
}

function resetSettings(userId) {
    getDb().prepare("DELETE FROM user_settings WHERE user_id = ?").run(userId);
}

/**
 * The audio profile for a download: explicit command options win over the saved preferences.
 * @param {string} userId
 * @param {{ format?: string | null, quality?: string | null }} [overrides]
 */
function getAudioProfile(userId, overrides = {}) {
    const settings = getSettings(userId);
    return resolveProfile(overrides.format ?? settings.format, overrides.quality ?? settings.quality);
}

module.exports = {
    DESTINATIONS,
    getSettings,
    updateSettings,
    resetSettings,
    getAudioProfile,
};
