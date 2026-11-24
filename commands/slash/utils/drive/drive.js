const {
    ApplicationCommandType,
    ApplicationCommandOptionType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
} = require("discord.js");
const embedGenerator = require("@utils/helpers/embedGenerator");
const googleDrive = require("@utils/helpers/googleDrive");
const userSettings = require("@utils/helpers/userSettings");
const { FORMAT_CHOICES, QUALITY_CHOICES, resolveProfile } = require("@utils/helpers/player/audioFormats");

// Interaction tokens expire after 15 minutes, stop polling before that so we can still edit the reply
const LOGIN_TIMEOUT_MS = 14 * 60 * 1000;
const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";

const pendingLogins = new Map(); // userId -> AbortController

const DESTINATION_LABELS = {
    ask: "Ask every time",
    drive: "Always save to Google Drive",
    discord: "Always send in Discord",
};

module.exports = {
    name: "drive",
    description: "Link your Google Drive so downloads are saved there.",
    type: ApplicationCommandType.ChatInput,
    ephemeral: true,
    requiredENVs: googleDrive.REQUIRED_ENVS,
    options: [
        {
            name: "login",
            description: "Link your Google Drive, downloads will be saved to it",
            type: ApplicationCommandOptionType.Subcommand,
        },
        {
            name: "logout",
            description: "Unlink your Google Drive, downloads will be sent in Discord again",
            type: ApplicationCommandOptionType.Subcommand,
        },
        {
            name: "status",
            description: "Show whether your Google Drive is linked, its storage and what was saved",
            type: ApplicationCommandOptionType.Subcommand,
        },
        {
            name: "settings",
            description: "Choose where downloads go and their default format/quality (no options = show them)",
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: "destination",
                    description: "Where single tracks go when your Drive is linked",
                    type: ApplicationCommandOptionType.String,
                    choices: Object.entries(DESTINATION_LABELS).map(([value, name]) => ({ name, value })),
                },
                {
                    name: "format",
                    description: "Default audio format for your downloads",
                    type: ApplicationCommandOptionType.String,
                    choices: FORMAT_CHOICES,
                },
                {
                    name: "quality",
                    description: "Default quality (ignored for FLAC)",
                    type: ApplicationCommandOptionType.String,
                    choices: QUALITY_CHOICES,
                },
                {
                    name: "reset",
                    description: "Go back to the defaults (ask every time, MP3 192 kbps)",
                    type: ApplicationCommandOptionType.Boolean,
                },
            ],
        },
    ],

    /**
     * @param {import("@utils/log")} logger The logger instance for logging errors and warnings
     * @param {import("discord.js").ChatInputCommandInteraction} interaction The interaction that triggered the command
     * @returns {Promise<void>}
     */
    async execute(logger, interaction) {
        switch (interaction.options.getSubcommand()) {
            case "login":
                return await login(logger, interaction);
            case "logout":
                return await logout(interaction);
            case "settings":
                return await settings(interaction);
            default:
                return await status(interaction);
        }
    },
};

function formatBytes(bytes) {
    if (!bytes)
        return "0 B";

    const units = ["B", "KB", "MB", "GB", "TB"];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** exponent;
    return `${value.toFixed(exponent === 0 ? 0 : value < 10 ? 2 : 1)} ${units[exponent]}`;
}

const toUnix = (ms) => Math.floor(ms / 1000);

async function status(interaction) {
    const folderName = googleDrive.getFolderName();
    const info = await googleDrive.getStatus(interaction.user.id);

    if (!info) {
        return await interaction.editReply({
            embeds: [embedGenerator.info({
                title: "☁️ Google Drive: not linked",
                description: [
                    "Downloads are sent as files in Discord, limited by the server's upload size.",
                    `Use \`/drive login\` to save them to a **${folderName}** folder in your Google Drive instead, at full quality and with no size limit.`,
                    "Linking is also required to download playlists and albums (saved as a zip).",
                ].join("\n"),
            })],
        });
    }

    if (info.connection === "revoked") {
        return await interaction.editReply({
            embeds: [embedGenerator.error({
                title: "☁️ Google Drive: link lost",
                description: `${info.error}\nYour Drive has been unlinked, use \`/drive login\` to link it again.`,
            })],
        });
    }

    const fields = [
        { name: "Account", value: info.email ?? "Unknown", inline: true },
        { name: "Linked", value: `<t:${toUnix(info.linkedAt)}:R>`, inline: true },
        {
            name: "Connection",
            value: info.connection === "ok" ? "✅ Working" : `⚠️ Couldn't reach Google: ${info.error}`,
            inline: true,
        },
    ];

    if (info.quota) {
        const { usage, limit } = info.quota;
        fields.push({
            name: "Drive storage",
            value: limit
                ? `${formatBytes(usage)} / ${formatBytes(limit)} (${((usage / limit) * 100).toFixed(1)}% used, ${formatBytes(Math.max(0, limit - usage))} free)`
                : `${formatBytes(usage)} used (no limit)`,
        });
    }

    fields.push({
        name: "Save folder",
        value: info.folderLink
            ? `[${folderName}](${info.folderLink})`
            : `**${folderName}** (created on your next download)`,
        inline: true,
    });

    const { stats } = info;
    const savedParts = [`${stats.tracks} track${stats.tracks === 1 ? "" : "s"}`];
    if (stats.playlists)
        savedParts.push(`${stats.playlists} playlist${stats.playlists === 1 ? "" : "s"} (${stats.playlistTracks} tracks)`);
    fields.push({ name: "Saved by the bot", value: `${savedParts.join(", ")} · ${formatBytes(stats.totalBytes)}`, inline: true });

    if (stats.last)
        fields.push({ name: "Last saved", value: `${stats.last.name} (<t:${toUnix(stats.last.createdAt)}:R>)` });

    await interaction.editReply({
        embeds: [embedGenerator.success({
            title: "☁️ Google Drive: linked",
            description: destinationSummary(userSettings.getSettings(interaction.user.id).destination),
            fields,
            footer: { text: "Saved counts only include uploads since you linked. Use /drive logout to unlink." },
        })],
    });
}

async function login(logger, interaction) {
    const userId = interaction.user.id;
    const folderName = googleDrive.getFolderName();
    const existingLink = googleDrive.getLink(userId);

    if (existingLink) {
        return await interaction.editReply({
            embeds: [embedGenerator.info({
                title: "Google Drive already linked",
                description: [
                    `Linked to **${existingLink.email ?? "your Google account"}** since <t:${Math.floor(existingLink.linkedAt / 1000)}:R>.`,
                    `Downloads are saved to the **${folderName}** folder.`,
                    "Use `/drive logout` to unlink it.",
                ].join("\n"),
            })],
        });
    }

    // Only one login at a time per user, a new one replaces the old one
    pendingLogins.get(userId)?.abort();
    const controller = new AbortController();
    pendingLogins.set(userId, controller);

    let collector;
    try {
        const device = await googleDrive.startDeviceLogin();
        const expiresAt = Math.floor((Date.now() + Math.min(device.expiresIn * 1000, LOGIN_TIMEOUT_MS)) / 1000);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel("Open Google")
                .setStyle(ButtonStyle.Link)
                .setURL(device.verificationUrl),
            new ButtonBuilder()
                .setCustomId("drive_login_cancel")
                .setLabel("Cancel")
                .setStyle(ButtonStyle.Secondary),
        );

        const message = await interaction.editReply({
            embeds: [embedGenerator.info({
                title: "🔗 Link your Google Drive",
                description: [
                    `**1.** Open ${device.verificationUrl}`,
                    `**2.** Enter the code: \`${device.userCode}\``,
                    "**3.** Pick your Google account and allow access",
                    "",
                    `The bot only gets access to files it creates (saved in a **${folderName}** folder), not the rest of your Drive.`,
                    `This code expires <t:${expiresAt}:R>.`,
                ].join("\n"),
            })],
            components: [row],
        });

        collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => i.customId === "drive_login_cancel" && i.user.id === userId,
            time: LOGIN_TIMEOUT_MS,
        });
        collector.on("collect", async (i) => {
            controller.abort();
            await i.deferUpdate().catch(() => { /**/ });
        });

        const { email } = await googleDrive.pollDeviceLogin(userId, device, {
            signal: controller.signal,
            timeoutMs: LOGIN_TIMEOUT_MS,
        });

        await interaction.editReply({
            embeds: [embedGenerator.success({
                title: "✅ Google Drive linked",
                description: [
                    `Linked to **${email ?? "your Google account"}**.`,
                    `\`/download\` now lets you save files to the **${folderName}** folder in your Drive, and playlists are saved there as a zip.`,
                    "Use `/drive settings` to always save to Drive (or always send in Discord) without being asked.",
                ].join("\n"),
            })],
            components: [],
        });
    } catch (error) {
        const messages = {
            cancelled: "Login cancelled.",
            denied: "Access was denied on Google's side. Run `/drive login` again if that was a mistake.",
            expired: "The login code expired. Run `/drive login` to get a new one.",
            missing_scope: "The Google Drive permission wasn't granted. Run `/drive login` again and make sure the Drive box is ticked.",
        };

        if (!messages[error.code])
            logger.error(`Google Drive login failed for ${userId}: ${error.message}`);

        await interaction.editReply({
            embeds: [embedGenerator.error({
                title: "Google Drive not linked",
                description: messages[error.code] ?? `Something went wrong: ${error.message}`,
            })],
            components: [],
        }).catch(() => { /**/ });
    } finally {
        collector?.stop();
        if (pendingLogins.get(userId) === controller)
            pendingLogins.delete(userId);
    }
}

async function logout(interaction) {
    const userId = interaction.user.id;
    pendingLogins.get(userId)?.abort();

    const result = await googleDrive.unlink(userId);

    if (!result.wasLinked) {
        return await interaction.editReply({
            embeds: [embedGenerator.warning({
                title: "Google Drive not linked",
                description: "Your Google Drive isn't linked. Use `/drive login` to link it.",
            })],
        });
    }

    const lines = [
        `Unlinked **${result.email ?? "your Google account"}**.`,
        "Files already saved stay in your Drive, the bot's record of them was deleted. Downloads will be sent in Discord again.",
    ];
    if (!result.revoked)
        lines.push(`Couldn't revoke access on Google's side, you can remove it manually at ${GOOGLE_PERMISSIONS_URL}.`);

    await interaction.editReply({
        embeds: [embedGenerator.success({ title: "Google Drive unlinked", description: lines.join("\n") })],
    });
}

function destinationSummary(destination) {
    const oversize = "Files too big for Discord ask whether to save them to Drive or get a compressed version.";
    if (destination === "drive")
        return `\`/download\` saves tracks to your Drive. ${oversize}`;
    if (destination === "discord")
        return `\`/download\` sends tracks in Discord. ${oversize}`;
    return "`/download` asks whether to send each track here or save it to your Drive.";
}

function describeSettings(current, linked) {
    const profile = resolveProfile(current.format, current.quality);
    return [
        {
            name: "Destination",
            value: linked
                ? DESTINATION_LABELS[current.destination]
                : `${DESTINATION_LABELS[current.destination]} (only applies once your Drive is linked)`,
        },
        { name: "Format", value: `${profile.label}${current.format || current.quality ? "" : " (default)"}`, inline: true },
        { name: "Playlists", value: "Zipped in this format too", inline: true },
    ];
}

async function settings(interaction) {
    const userId = interaction.user.id;
    const linked = googleDrive.isLinked(userId);

    if (interaction.options.getBoolean("reset")) {
        userSettings.resetSettings(userId);
        return await interaction.editReply({
            embeds: [embedGenerator.success({
                title: "⚙️ Settings reset",
                fields: describeSettings(userSettings.getSettings(userId), linked),
            })],
        });
    }

    const changes = {};
    for (const key of ["destination", "format", "quality"]) {
        const value = interaction.options.getString(key);
        if (value !== null)
            changes[key] = value;
    }

    if (!Object.keys(changes).length) {
        return await interaction.editReply({
            embeds: [embedGenerator.info({
                title: "⚙️ Your download settings",
                description: "Change them with the options of `/drive settings`. `/download` also has `format` and `quality` options for a single download.",
                fields: describeSettings(userSettings.getSettings(userId), linked),
            })],
        });
    }

    const updated = userSettings.updateSettings(userId, changes);
    const notes = [];
    if (changes.quality && (changes.format ?? updated.format) === "flac")
        notes.push("FLAC is lossless, so quality doesn't apply to it.");
    if (changes.format === "flac" || changes.quality === "high")
        notes.push("Most sources are already compressed (YouTube is ~128-160 kbps), so higher settings mostly make bigger files.");
    if (changes.destination && changes.destination !== "ask" && !linked)
        notes.push("Your Google Drive isn't linked, use `/drive login` for the destination to apply.");

    await interaction.editReply({
        embeds: [embedGenerator.success({
            title: "⚙️ Settings saved",
            description: notes.join("\n") || undefined,
            fields: describeSettings(updated, linked),
        })],
    });
}
