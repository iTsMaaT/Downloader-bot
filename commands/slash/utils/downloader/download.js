const {
    ApplicationCommandType,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
} = require("discord.js");
const fs = require("node:fs");
const path = require("node:path");
const { useMainPlayer } = require("discord-player");
const { downloadViaStream, compressAudioFile } = require("@root/utils/helpers/player/downloader");
const {
    awareQueryResolver,
    searchAcrossExtractors,
    createSourceMessage,
    createDownloadingEmbed,
    createSuccessEmbed,
    estimateFileSize,
} = require("@root/utils/helpers/player/downloadHelpers");
const googleDrive = require("@utils/helpers/googleDrive");
const { handlePlaylistDownload } = require("@utils/helpers/player/playlistDownloadFlow");
const userSettings = require("@utils/helpers/userSettings");
const { FORMAT_CHOICES, QUALITY_CHOICES } = require("@utils/helpers/player/audioFormats");

const DEFAULT_UPLOAD_LIMIT_MB = 10;
const PROMPT_TIMEOUT_MS = 60_000;

module.exports = {
    name: "download",
    description: "Search and download a song, or a playlist as a zip.",
    type: ApplicationCommandType.ChatInput,
    cooldown: 10_000,
    options: [
        {
            name: "query",
            description: "Song name, or a song/playlist/album URL",
            type: 3,
            required: true,
        },
        {
            name: "format",
            description: "Audio format (default: your /drive settings, or MP3)",
            type: 3,
            choices: FORMAT_CHOICES,
        },
        {
            name: "quality",
            description: "Audio quality (default: your /drive settings, or medium)",
            type: 3,
            choices: QUALITY_CHOICES,
        },
    ],

    async execute(logger, interaction, client) {
        const query = interaction.options.getString("query");
        const player = useMainPlayer();
        const profile = userSettings.getAudioProfile(interaction.user.id, {
            format: interaction.options.getString("format"),
            quality: interaction.options.getString("quality"),
        });

        try {
            // Raw text queries: let the user pick from every streamable source
            if (!isUrlQuery(query))
                return await handleMultiSourceDownload(interaction, player, query, profile);

            // Resolve the query
            const resolved = await awareQueryResolver(query, player);

            // Check if extractor was found
            if (!resolved.extractor) {
                return await interaction.editReply({
                    content: "❌ Couldn't find a matching extractor for that query.",
                });
            }

            // Search for the track
            const searchResult = await player.search(query, {
                searchEngine: `ext:${resolved.extractor.identifier}`,
            });

            if (!searchResult.hasTracks()) {
                return await interaction.editReply({
                    content: "❌ No tracks found matching that query.",
                });
            }

            // Playlists/albums are zipped (bridged per track if the source can't stream)
            if (searchResult.hasPlaylist())
                return await handlePlaylistDownload(interaction, player, searchResult, getGuildUploadLimitMB(interaction), profile);

            const track = searchResult.tracks[0];

            // If can stream directly, download it
            if (resolved.canStream)
                return await handleDirectDownload(interaction, track, profile);
            

            // Otherwise, search across extractors and present options
            return await handleMultiSourceDownload(interaction, player, `${track.title} ${track.author}`, profile);

        } catch (error) {
            console.error("Download command error:", error);
            return await interaction.editReply({
                content: `❌ An error occurred: ${error.message}`,
            });
        }
    },
};

/**
 * Handle direct download when track can be streamed
 */
async function handleDirectDownload(interaction, track, profile) {
    return await performTrackDownload(interaction, track, profile);
}

/**
 * Handle multi-source download when track cannot be directly streamed
 */
async function handleMultiSourceDownload(interaction, player, searchQuery, profile) {
    try {
        // Search across all streamable extractors
        const searchResults = await searchAcrossExtractors(player, searchQuery);

        if (searchResults.size === 0) {
            return await interaction.editReply({
                content: "❌ No sources available to download this track.",
            });
        }

        // Convert map to array for easier pagination
        const sources = Array.from(searchResults.entries());
        let currentSourcePage = 0;
        let currentTrackPage = 0;

        const updateSourceView = (i) => i.update({
            ...createSourceMessage(sources, currentSourcePage, currentTrackPage),
        });

        // Send initial message with first source
        const message = await interaction.editReply({
            ...createSourceMessage(sources, currentSourcePage, currentTrackPage),
        });

        // Collect button interactions
        const collector = message.createMessageComponentCollector({
            filter: (i) => i.user.id === interaction.user.id,
            time: 60000, // 1 minute timeout
        });

        collector.on("collect", async (i) => {
            try {
                const customId = i.customId;

                if (customId === "source_prev" && currentSourcePage > 0) {
                    currentSourcePage--;
                    currentTrackPage = 0;
                    await updateSourceView(i);
                } else if (customId === "source_next" && currentSourcePage < sources.length - 1) {
                    currentSourcePage++;
                    currentTrackPage = 0;
                    await updateSourceView(i);
                } else if (customId === "track_prev" && currentTrackPage > 0) {
                    currentTrackPage--;
                    await updateSourceView(i);
                } else if (customId === "track_next") {
                    const maxPages = Math.ceil(sources[currentSourcePage][1].length / 10);
                    if (currentTrackPage < maxPages - 1) {
                        currentTrackPage++;
                        await updateSourceView(i);
                    }
                } else if (customId === "select_track") {
                    const trackIndex = Number.parseInt(i.values[0], 10);
                    const selectedTrack = sources[currentSourcePage][1][trackIndex];

                    if (!selectedTrack) 
                        return await i.reply({ content: "❌ Track not found.", flags: MessageFlags.Ephemeral });
                    

                    // Check for playlist
                    if (selectedTrack.isPlaylist) {
                        return await i.reply({
                            content: "❌ This is a playlist. Only individual tracks can be downloaded.",
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    collector.stop();
                    await i.deferUpdate();

                    // Download the selected track (handles the size prompt + downloading view)
                    await performTrackDownload(i, selectedTrack, profile);
                }
            } catch (error) {
                console.error("Collector interaction error:", error);
                const payload = {
                    content: `❌ An error occurred: ${error.message}`,
                    flags: MessageFlags.Ephemeral,
                };
                await (i.deferred || i.replied ? i.followUp(payload) : i.reply(payload)).catch(() => { /**/ });
            }
        });

        collector.on("end", (collected) => {
            if (collected.size === 0) {
                interaction.editReply({
                    content: "⏱️ Download request timed out.",
                    components: [],
                }).catch(() => { /**/ });
            }
        });

    } catch (error) {
        console.error("Multi-source download error:", error);
        await interaction.editReply({
            content: `❌ An error occurred: ${error.message}`,
        });
    }
}

/**
 * Performs the actual track download
 * @param {import("@utils/helpers/player/audioFormats").AudioProfile} profile Output format
 */
async function performTrackDownload(interaction, track, profile) {
    try {
        const sizeCheck = getEstimatedSizeCheck(interaction, track, profile);
        const uploadLimitMB = getGuildUploadLimitMB(interaction);
        const driveLinked = googleDrive.isLinked(interaction.user.id);
        const { destination: preferredDestination } = userSettings.getSettings(interaction.user.id);

        // "discord": attach as-is, "compress": attach a compressed copy, "drive": save to the user's Google Drive
        let destination = "discord";

        if (sizeCheck.tooBig) {
            const choice = await promptDestinationChoice(
                interaction,
                `⚠️ This track is estimated at ~${sizeCheck.sizeMB.toFixed(2)}MB, which is above this server's upload limit (${uploadLimitMB}MB).`,
                { oversize: true, allowDrive: driveLinked },
            );

            if (!choice)
                return;
            destination = choice;
        } else if (driveLinked && preferredDestination !== "ask") {
            destination = preferredDestination;
        } else if (driveLinked) {
            const choice = await promptDestinationChoice(
                interaction,
                `🎵 **${track.title}** · ${profile.label}${sizeCheck.sizeMB ? ` · ~${sizeCheck.sizeMB.toFixed(2)}MB` : ""}`,
                { oversize: false, allowDrive: true },
            );

            if (!choice)
                return;
            destination = choice;
        }

        // Show downloading message
        let content = null;
        if (destination === "drive")
            content = "☁️ The file will be saved to your Google Drive once downloaded.";
        else if (destination === "compress")
            content = `🗜️ The file will be compressed to fit under ${uploadLimitMB}MB once downloaded.`;
        else if (sizeCheck.shouldWarn)
            content = `⚠️ Estimated size is ~${sizeCheck.sizeMB.toFixed(2)}MB. Discord may fail to send this file.`;

        await interaction.editReply({
            content,
            embeds: [createDownloadingEmbed(track, profile)],
            components: [],
        });

        // Download the track
        const outputPath = await downloadViaStream(track, profile);

        if (!outputPath) {
            return await interaction.editReply({
                content: "❌ Download failed: Download file not created",
                embeds: [],
                components: [],
            });
        }

        if (destination === "drive")
            return await saveToDrive(interaction, track, outputPath, profile);

        // Send the downloaded file
        await sendDownloadedFile(interaction, track, outputPath, {
            profile,
            compressApproved: destination === "compress",
            allowDrive: driveLinked,
        });

    } catch (error) {
        console.error("Track download error:", error.message);
        await interaction.editReply({
            content: `❌ Download failed: ${error.message}`,
            embeds: [],
            components: [],
        });
    }
}

/**
 * Asks the user where the file should go.
 * - oversize: Save to Google Drive (if allowed), Get compressed version, Cancel
 * - otherwise: Send here, Save to Google Drive (if allowed), Cancel
 * @param {string} reason First line of the prompt
 * @param {{ oversize?: boolean, allowDrive?: boolean }} [options]
 * @returns {Promise<"discord" | "compress" | "drive" | null>} The chosen destination, null on cancel/timeout
 */
async function promptDestinationChoice(interaction, reason, { oversize = true, allowDrive = false } = {}) {
    const choices = [];
    if (!oversize)
        choices.push({ id: "dest_discord", value: "discord", label: "Send here", emoji: "📎" });
    if (allowDrive)
        choices.push({ id: "dest_drive", value: "drive", label: "Save to Google Drive", emoji: "☁️" });
    if (oversize)
        choices.push({ id: "dest_compress", value: "compress", label: "Get compressed version", emoji: "🗜️" });

    const buttons = choices.map((choice, index) => new ButtonBuilder()
        .setCustomId(choice.id)
        .setLabel(choice.label)
        .setEmoji(choice.emoji)
        .setStyle(index === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary));
    buttons.push(new ButtonBuilder()
        .setCustomId("dest_cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary));

    let question;
    if (!oversize)
        question = "Do you want the file sent here, or saved to your Google Drive?";
    else if (allowDrive)
        question = "Do you want to save it to your Google Drive (full quality), get a compressed (lower quality) version here, or cancel?";
    else
        question = "Do you want a compressed (lower quality) version that fits, or cancel?";

    const message = await interaction.editReply({
        content: `${reason}\n${question}`,
        embeds: [],
        files: [],
        components: [new ActionRowBuilder().addComponents(buttons)],
    });

    const customIds = buttons.map((button) => button.data.custom_id);
    let choice;
    try {
        choice = await message.awaitMessageComponent({
            filter: (i) => i.user.id === interaction.user.id && customIds.includes(i.customId),
            componentType: ComponentType.Button,
            time: PROMPT_TIMEOUT_MS,
        });
    } catch {
        await interaction.editReply({ content: "⏱️ Download request timed out.", components: [] }).catch(() => { /**/ });
        return null;
    }

    if (choice.customId === "dest_cancel") {
        await choice.update({ content: "❌ Download cancelled.", components: [] });
        return null;
    }

    await choice.deferUpdate();
    return choices.find((c) => c.id === choice.customId).value;
}

/**
 * Uploads the downloaded file to the user's Google Drive.
 * Falls back to sending it in Discord if the upload fails.
 */
async function saveToDrive(interaction, track, outputPath, profile) {
    await interaction.editReply({
        content: "☁️ Uploading to your Google Drive...",
        embeds: [createDownloadingEmbed(track, profile)],
        files: [],
        components: [],
    });

    let file;
    try {
        const extension = path.extname(outputPath);
        const name = track.author ? `${track.author} - ${track.title}${extension}` : path.basename(outputPath);
        file = await googleDrive.uploadFile(interaction.user.id, outputPath, { name });
    } catch (error) {
        console.error(`Google Drive upload failed: ${error.message}`);

        const relinkHint = error instanceof googleDrive.DriveAuthError
            ? "\nYour Google Drive has been unlinked, use `/drive login` to link it again."
            : "";
        await interaction.followUp({
            content: `⚠️ Couldn't save to your Google Drive: ${error.message}${relinkHint}\nSending the file in Discord instead.`,
            flags: MessageFlags.Ephemeral,
        }).catch(() => { /**/ });

        // Drive is what just failed, so don't offer it again
        return await sendDownloadedFile(interaction, track, outputPath, { profile, allowDrive: false });
    }

    const sizeMB = Number(file.size) / (1024 * 1024) || getOutputFileSizeCheck(outputPath, Infinity).sizeMB || undefined;
    const embed = createSuccessEmbed(track, { sizeMB, profile }).setTitle("✅ Saved to Google Drive");

    const links = [];
    if (file.webViewLink)
        links.push(new ButtonBuilder().setLabel("Open file").setStyle(ButtonStyle.Link).setURL(file.webViewLink));
    if (file.folderLink)
        links.push(new ButtonBuilder().setLabel(`Open ${googleDrive.getFolderName()}`).setStyle(ButtonStyle.Link).setURL(file.folderLink));

    await interaction.editReply({
        content: null,
        embeds: [embed],
        components: links.length ? [new ActionRowBuilder().addComponents(links)] : [],
    });
}

/**
 * Compresses the downloaded file to fit the upload limit and sends it.
 */
async function sendCompressedFile(interaction, track, outputPath, uploadLimitMB, profile) {
    await interaction.editReply({
        content: `🗜️ Compressing to fit under ${uploadLimitMB}MB...`,
        embeds: [createDownloadingEmbed(track, profile)],
        files: [],
        components: [],
    });

    const result = await compressAudioFile(outputPath, uploadLimitMB, track.durationMS, profile.estimateKbps);

    if (!result) {
        return await interaction.editReply({
            content: `❌ Couldn't compress this track under ${uploadLimitMB}MB (it's too long for this server's upload limit).`,
            embeds: [],
            components: [],
        });
    }

    try {
        await interaction.editReply({
            content: null,
            embeds: [createSuccessEmbed(track, { sizeMB: result.sizeMB, bitrateKbps: result.bitrateKbps, compressed: true })],
            // Compressed copies are always MP3, whatever the original format
            files: [{ attachment: result.path, name: `${path.parse(outputPath).name}.mp3` }],
            components: [],
        });
    } catch (error) {
        if (!isRequestEntityTooLargeError(error))
            throw error;

        await interaction.editReply({
            content: "❌ Discord still rejected the compressed file as too large.",
            embeds: [],
            components: [],
        });
    }
}

function isUrlQuery(query) {
    try {
        const url = new URL(query.trim());
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

function getEstimatedSizeCheck(interaction, track, profile) {
    if (!track?.durationMS || Number.isNaN(track.durationMS))
        return { sizeMB: null, shouldWarn: false, tooBig: false };

    const sizeMB = estimateFileSize(track.durationMS, profile.estimateKbps);
    const uploadLimitMB = getGuildUploadLimitMB(interaction);
    const warningThresholdMB = Math.max(1, uploadLimitMB - 0.5);

    return {
        sizeMB,
        shouldWarn: sizeMB > warningThresholdMB,
        tooBig: sizeMB >= uploadLimitMB,
    };
}

function getOutputFileSizeCheck(filePath, uploadLimitMB) {
    try {
        const stats = fs.statSync(filePath);
        const sizeMB = stats.size / (1024 * 1024);

        return {
            sizeMB,
            tooBig: sizeMB >= uploadLimitMB,
        };
    } catch {
        return {
            sizeMB: 0,
            tooBig: false,
        };
    }
}

/**
 * Sends the downloaded file. If it turns out too big, asks again (compressed version, or Google Drive if allowed).
 * @param {{ profile: import("@utils/helpers/player/audioFormats").AudioProfile, compressApproved?: boolean, allowDrive?: boolean }} options
 *   profile: format of the file
 *   compressApproved: the user already chose to compress (skip asking again)
 *   allowDrive: offer Google Drive if the file is too big (user has it linked)
 */
async function sendDownloadedFile(interaction, track, outputPath, { profile, compressApproved = false, allowDrive = false }) {
    const uploadLimitMB = getGuildUploadLimitMB(interaction);
    const outputSizeCheck = getOutputFileSizeCheck(outputPath, uploadLimitMB);

    if (outputSizeCheck.tooBig) {
        const choice = compressApproved ? "compress" : await promptDestinationChoice(
            interaction,
            `⚠️ Downloaded file is ${outputSizeCheck.sizeMB.toFixed(2)}MB, which is above this server's upload limit (${uploadLimitMB}MB).`,
            { oversize: true, allowDrive },
        );

        if (choice === "drive")
            await saveToDrive(interaction, track, outputPath, profile);
        else if (choice === "compress")
            await sendCompressedFile(interaction, track, outputPath, uploadLimitMB, profile);
        return;
    }

    try {
        await interaction.editReply({
            content: null,
            embeds: [createSuccessEmbed(track, { sizeMB: outputSizeCheck.sizeMB || undefined, profile })],
            files: [outputPath],
            components: [],
        });
    } catch (error) {
        if (!isRequestEntityTooLargeError(error))
            throw error;

        // Real limit can be lower than what we computed (e.g. DMs / user-installed app context)
        const choice = compressApproved ? "compress" : await promptDestinationChoice(
            interaction,
            "⚠️ Discord rejected this upload because the file is too large for this server/context.",
            { oversize: true, allowDrive },
        );

        if (choice === "drive") {
            await saveToDrive(interaction, track, outputPath, profile);
        } else if (choice === "compress") {
            // The actual limit is unknown here, so aim for Discord's base limit (and below the current size)
            const fallbackLimitMB = Math.min(DEFAULT_UPLOAD_LIMIT_MB, outputSizeCheck.sizeMB * 0.9 || DEFAULT_UPLOAD_LIMIT_MB);
            await sendCompressedFile(interaction, track, outputPath, fallbackLimitMB, profile);
        }
    }
}

function isRequestEntityTooLargeError(error) {
    if (!error)
        return false;

    return error.status === 413
        || error.code === 40005
        || String(error.message || "").toLowerCase().includes("request entity too large");
}

function getGuildUploadLimitMB(interaction) {
    const premiumTier = interaction?.guild?.premiumTier ?? 0;

    if (premiumTier >= 3)
        return 100;

    if (premiumTier >= 2)
        return 50;

    return DEFAULT_UPLOAD_LIMIT_MB;
}
