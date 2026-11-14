const { Events } = require("discord.js");
const GuildManager = require("@guildManager");

module.exports = {
    name: Events.GuildDelete,
    once: false,
    log: true,
    /**
     * Announces when the bot leaves an available guild.
     * @param {import("discord.js").Client} client The Discord client.
     * @param {object} logger The application logger.
     * @param {import("discord.js").Guild} guild The guild the bot left or lost access to.
     */
    async execute(client, logger, guild) {
        if (!guild.available || !guild.name) return;
        logger.info(`The bot has been removed from \`${guild.name}\``);
        client.channels.cache.get(process.env.GUILD_UPDATE_ID)?.send(`The bot has been removed from \`${guild.name}\``);
    },
};