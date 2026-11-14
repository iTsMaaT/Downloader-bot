const withoutDbManager = require("./withoutDatabase/withoutDbGuildManager");

/**
 * The guildManager module exports a cache-only manager for guild-related operations.
 * This version uses in-memory caching without database persistence.
 * 
 * @module guildManager
 */
const guildManager = withoutDbManager;

module.exports = guildManager;