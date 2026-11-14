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

const DEFAULT_UPLOAD_LIMIT_MB = 10;
const PROMPT_TIMEOUT_MS = 60_000;

module.exports = {
    name: "download",
    description: "Search and download a song.",
    type: ApplicationCommandType.ChatInput,
    options: [
        {
            name: "query",
            description: "Song name or URL",
            type: 3,
            required: true,
        },
    ],

    async execute(logger, interaction, client) {
        const query = interaction.options.getString("query");
        const player = useMainPlayer();

        try {
            // Raw text queries: let the user pick from every streamable source
            if (!isUrlQuery(query))
                return await handleMultiSourceDownload(interaction, player, query);

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

            const track = searchResult.tracks[0];

            // Reject playlists
            if (searchResult.hasPlaylist()) {
                return await interaction.editReply({
                    content: "❌ Playlists are not supported for download. Please provide a direct song link or search query.",
                });
            }

            // If can stream directly, download it
            if (resolved.canStream)
                return await handleDirectDownload(interaction, track);
            

            // Otherwise, search across extractors and present options
            return await handleMultiSourceDownload(interaction, player, `${track.title} ${track.author}`);

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
async function handleDirectDownload(interaction, track) {
    return await performTrackDownload(interaction, track);
}

/**
 * Handle multi-source download when track cannot be directly streamed
 */
async function handleMultiSourceDownload(interaction, player, searchQuery) {
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
                    await performTrackDownload(i, selectedTrack);
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
 */
async function performTrackDownload(interaction, track) {
    try {
        const sizeCheck = getEstimatedSizeCheck(interaction, track);
        const uploadLimitMB = getGuildUploadLimitMB(interaction);
        let compressApproved = false;

        if (sizeCheck.tooBig) {
            compressApproved = await promptCompressOrCancel(
                interaction,
                `This track is estimated at ~${sizeCheck.sizeMB.toFixed(2)}MB, which is above this server's upload limit (${uploadLimitMB}MB).`,
            );

            if (!compressApproved)
                return;
        }

        // Show downloading message
        let content = null;
        if (compressApproved)
            content = `🗜️ The file will be compressed to fit under ${uploadLimitMB}MB once downloaded.`;
        else if (sizeCheck.shouldWarn)
            content = `⚠️ Estimated size is ~${sizeCheck.sizeMB.toFixed(2)}MB. Discord may fail to send this file.`;

        await interaction.editReply({
            content,
            embeds: [createDownloadingEmbed(track)],
            components: [],
        });

        // Download the track
        const outputPath = await downloadViaStream(track);

        if (!outputPath) {
            return await interaction.editReply({
                content: "❌ Download failed: Download file not created",
                embeds: [],
                components: [],
            });
        }

        // Send the downloaded file
        await sendDownloadedFile(interaction, track, outputPath, compressApproved);

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
 * Asks the user whether they want a compressed version of a file that's too big for Discord.
 * @returns {Promise<boolean>} true if the user chose to compress, false on cancel/timeout
 */
async function promptCompressOrCancel(interaction, reason) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("size_compress")
            .setLabel("Get compressed version")
            .setEmoji("🗜️")
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId("size_cancel")
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Secondary),
    );

    const message = await interaction.editReply({
        content: `⚠️ ${reason}\nDo you want a compressed (lower quality) version that fits, or cancel?`,
        embeds: [],
        files: [],
        components: [row],
    });

    let choice;
    try {
        choice = await message.awaitMessageComponent({
            filter: (i) => i.user.id === interaction.user.id && ["size_compress", "size_cancel"].includes(i.customId),
            componentType: ComponentType.Button,
            time: PROMPT_TIMEOUT_MS,
        });
    } catch {
        await interaction.editReply({ content: "⏱️ Download request timed out.", components: [] }).catch(() => { /**/ });
        return false;
    }

    if (choice.customId === "size_cancel") {
        await choice.update({ content: "❌ Download cancelled.", components: [] });
        return false;
    }

    await choice.deferUpdate();
    return true;
}

/**
 * Compresses the downloaded file to fit the upload limit and sends it.
 */
async function sendCompressedFile(interaction, track, outputPath, uploadLimitMB) {
    await interaction.editReply({
        content: `🗜️ Compressing to fit under ${uploadLimitMB}MB...`,
        embeds: [createDownloadingEmbed(track)],
        files: [],
        components: [],
    });

    const result = await compressAudioFile(outputPath, uploadLimitMB, track.durationMS);

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
            files: [{ attachment: result.path, name: path.basename(outputPath) }],
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

function getEstimatedSizeCheck(interaction, track) {
    if (!track?.durationMS || Number.isNaN(track.durationMS))
        return { sizeMB: null, shouldWarn: false, tooBig: false };

    const sizeMB = estimateFileSize(track.durationMS);
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
 * Sends the downloaded file, offering a compressed version if it's too big.
 * @param {boolean} compressApproved The user already chose to compress (skip asking again)
 */
async function sendDownloadedFile(interaction, track, outputPath, compressApproved = false) {
    const uploadLimitMB = getGuildUploadLimitMB(interaction);
    const outputSizeCheck = getOutputFileSizeCheck(outputPath, uploadLimitMB);

    if (outputSizeCheck.tooBig) {
        const approved = compressApproved || await promptCompressOrCancel(
            interaction,
            `Downloaded file is ${outputSizeCheck.sizeMB.toFixed(2)}MB, which is above this server's upload limit (${uploadLimitMB}MB).`,
        );

        if (approved)
            await sendCompressedFile(interaction, track, outputPath, uploadLimitMB);
        return;
    }

    try {
        await interaction.editReply({
            content: null,
            embeds: [createSuccessEmbed(track, { sizeMB: outputSizeCheck.sizeMB || undefined })],
            files: [outputPath],
            components: [],
        });
    } catch (error) {
        if (!isRequestEntityTooLargeError(error))
            throw error;

        // Real limit can be lower than what we computed (e.g. DMs / user-installed app context)
        const approved = compressApproved || await promptCompressOrCancel(
            interaction,
            "Discord rejected this upload because the file is too large for this server/context.",
        );

        if (approved) {
            // The actual limit is unknown here, so aim for Discord's base limit (and below the current size)
            const fallbackLimitMB = Math.min(DEFAULT_UPLOAD_LIMIT_MB, outputSizeCheck.sizeMB * 0.9 || DEFAULT_UPLOAD_LIMIT_MB);
            await sendCompressedFile(interaction, track, outputPath, fallbackLimitMB);
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
