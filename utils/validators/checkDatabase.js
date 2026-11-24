const logger = require("@utils/log");
const { getDb, DB_PATH } = require("@utils/db/database");

/**
 * Opens the SQLite database at startup (creating the file and applying migrations if needed)
 * so problems show up at boot instead of on the first command that uses it.
 * @returns {void}
 */
const checkDatabase = function() {
    try {
        const version = getDb().pragma("user_version", { simple: true });
        logger.info(`Database ready at ${DB_PATH} (schema version ${version}).`);
    } catch (error) {
        logger.error(`Failed to open the database at ${DB_PATH}: ${error.message}`);
        logger.error("Exiting...");
        process.exit(0);
    }
};

module.exports = { execute: checkDatabase };
