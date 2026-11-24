const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    EmbedBuilder,
    MessageFlags,
} = require("discord.js");
const config = require("@utils/config/configUtils");
const googleDrive = require("@utils/helpers/googleDrive");
const { formatDuration, getThumbnailURL } = require("@utils/helpers/player/downloadHelpers");
const {
    trackLabel,
    planDiscordParts,
    downloadPlaylistTracks,
    fitEntriesForDiscord,
    buildPlaylistZips,
    removePlaylistDir,
} = require("@utils/helpers/player/playlistDownloader");

const PROMPT_TIMEOUT_MS = 60_000;
const PROGRESS_EDIT_INTERVAL_MS = 3000;
// Interaction tokens last 15 minutes, past that we edit/send through the channel instead
const INTERACTION_TOKEN_TTL_MS = 14 * 60 * 1000;
const JOB_CANCEL_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_LISTED_FAILURES = 10;
const MB = 1024 * 1024;

const busyMessage = (max) => `⏳ ${max} playlists are already being downloaded, try again in a few minutes.`;

const activeJobs = new Set(); // userIds with a playlist download running (or being set up)
let runningJobCount = 0; // Playlists downloading right now, across all users

function getPlaylistConfig() {
    const conf = config.get("playlistDownload") || {};
    return {
        maxTracks: conf.maxTracks ?? 100,
        maxDiscordZipParts: conf.maxDiscordZipParts ?? 10,
        concurrency: conf.concurrency ?? 2,
        maxConcurrentJobs: conf.maxConcurrentJobs ?? 3,
    };
}

/**
 * Edits/sends through the interaction while its token is valid, then falls back to the channel.
 * Long playlists can easily take more than 15 minutes.
 */
function createResponder(interaction, message) {
    const tokenValid = () => Date.now() - interaction.createdTimestamp < INTERACTION_TOKEN_TTL_MS;

    return {
        edit: (payload) => (tokenValid() ? interaction.editReply(payload) : message.edit(payload)),
        send: (payload) => {
            if (tokenValid())
                return interaction.followUp(payload);

            // Ephemeral only exists for interaction responses
            const { flags, ...channelPayload } = payload;
            return message.channel.send({ ...channelPayload, reply: { messageReference: message.id, failIfNotExists: false } });
        },
    };
}

function progressBar(done, total, width = 16) {
    const filled = total ? Math.round((done / total) * width) : 0;
    return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function formatFailures(failed) {
    const lines = failed.slice(0, MAX_LISTED_FAILURES).map((f) => `• ${trackLabel(f.track)}: ${f.reason}`);
    if (failed.length > MAX_LISTED_FAILURES)
        lines.push(`…and ${failed.length - MAX_LISTED_FAILURES} more`);
    return lines.join("\n").slice(0, 1024);
}

/**
 * Shows the playlist overview and asks where it should go.
 * @returns {Promise<"drive" | "discord" | null>}
 */
async function promptPlaylistDestination(interaction, { title, tracks, truncatedCount, thumbnail, uploadLimitMB, discordPlan, maxParts, profile }) {
    const totalDurationMS = tracks.reduce((sum, t) => sum + (t.durationMS || 0), 0);
    const discordFitsAll = discordPlan.trackCount === tracks.length;

    const discordLine = discordFitsAll
        ? `${discordPlan.parts} zip file${discordPlan.parts === 1 ? "" : "s"} of up to ${uploadLimitMB}MB. Tracks too long for that are compressed.`
        : `Only the first **${discordPlan.trackCount}** tracks fit in ${maxParts} zips of ${uploadLimitMB}MB.`;

    const embed = new EmbedBuilder()
        .setColor("#2b2d31")
        .setTitle(`📀 ${title}`.slice(0, 256))
        .setDescription([
            `**${tracks.length}** tracks · ${totalDurationMS ? formatDuration(totalDurationMS) : "unknown length"} · ~${discordPlan.totalMB.toFixed(0)}MB · ${profile.label}`,
            truncatedCount ? `⚠️ Only the first ${tracks.length} tracks will be downloaded (${truncatedCount} more are over the limit).` : null,
        ].filter(Boolean).join("\n"))
        .addFields(
            { name: "☁️ Google Drive", value: "One zip with every track, in the format above." },
            { name: "💬 Discord", value: discordLine },
        );

    if (thumbnail)
        embed.setThumbnail(thumbnail);

    const buttons = [
        new ButtonBuilder()
            .setCustomId("playlist_drive")
            .setLabel("Save to Google Drive")
            .setEmoji("☁️")
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId("playlist_discord")
            .setLabel("Send in Discord")
            .setEmoji("📦")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(discordPlan.trackCount === 0),
        new ButtonBuilder()
            .setCustomId("playlist_cancel")
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Secondary),
    ];

    const message = await interaction.editReply({ content: null, embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons)] });

    let choice;
    try {
        choice = await message.awaitMessageComponent({
            filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith("playlist_"),
            componentType: ComponentType.Button,
            time: PROMPT_TIMEOUT_MS,
        });
    } catch {
        await interaction.editReply({ content: "⏱️ Download request timed out.", embeds: [], components: [] }).catch(() => { /**/ });
        return null;
    }

    if (choice.customId === "playlist_cancel") {
        await choice.update({ content: "❌ Download cancelled.", embeds: [], components: [] });
        return null;
    }

    await choice.deferUpdate();
    return choice.customId === "playlist_drive" ? "drive" : "discord";
}

/**
 * Full playlist flow: overview prompt -> download -> zip -> Google Drive or Discord.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {import("discord-player").Player} player
 * @param {import("discord-player").SearchResult} searchResult
 * @param {number} uploadLimitMB
 * @param {import("@utils/helpers/player/audioFormats").AudioProfile} profile Format of the tracks in the zip
 */
async function handlePlaylistDownload(interaction, player, searchResult, uploadLimitMB, profile) {
    const userId = interaction.user.id;
    const { maxTracks, maxDiscordZipParts, concurrency, maxConcurrentJobs } = getPlaylistConfig();

    // Playlists are a Google Drive feature, they'd take dozens of Discord-sized zips otherwise
    if (!googleDrive.isConfigured())
        return await interaction.editReply({ content: "❌ Playlist downloads aren't available on this bot (Google Drive isn't set up)." });

    if (!googleDrive.isLinked(userId)) {
        return await interaction.editReply({
            content: [
                "☁️ Playlist downloads are saved to Google Drive as a zip, so you need to link your Drive first.",
                "Use `/drive login`, then run this command again. Single tracks still work without it.",
            ].join("\n"),
        });
    }

    if (activeJobs.has(userId))
        return await interaction.editReply({ content: "⏳ You already have a playlist download running, wait for it to finish (or cancel it) first." });

    // Checked again once the user confirms, a slot could be taken while the prompt is open
    if (runningJobCount >= maxConcurrentJobs)
        return await interaction.editReply({ content: busyMessage(maxConcurrentJobs) });

    const allTracks = searchResult.tracks.filter((t) => !t.isPlaylist);
    if (!allTracks.length)
        return await interaction.editReply({ content: "❌ This playlist has no downloadable tracks." });

    const tracks = allTracks.slice(0, maxTracks);
    const title = searchResult.playlist?.title || "Playlist";
    const thumbnail = searchResult.playlist?.thumbnail || getThumbnailURL(tracks[0]);
    const discordPlan = planDiscordParts(tracks, uploadLimitMB, maxDiscordZipParts, profile);

    activeJobs.add(userId);
    let zipDir = null;
    let cancelCollector = null;
    let holdsSlot = false;

    try {
        const destination = await promptPlaylistDestination(interaction, {
            title, tracks, thumbnail, uploadLimitMB, discordPlan, profile,
            truncatedCount: allTracks.length - tracks.length,
            maxParts: maxDiscordZipParts,
        });
        if (!destination)
            return;

        if (runningJobCount >= maxConcurrentJobs)
            return await interaction.editReply({ content: busyMessage(maxConcurrentJobs), embeds: [], components: [] });
        runningJobCount++;
        holdsSlot = true;

        const selected = destination === "discord" ? tracks.slice(0, discordPlan.trackCount) : tracks;
        const skippedForDiscord = tracks.length - selected.length;

        // --- Download -------------------------------------------------------
        const controller = new AbortController();
        const cancelRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("playlist_job_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
        );

        const message = await interaction.editReply({ content: null, embeds: [progressEmbed(title, thumbnail, 0, selected.length, 0, null)], components: [cancelRow] });
        const responder = createResponder(interaction, message);

        cancelCollector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => i.customId === "playlist_job_cancel" && i.user.id === userId,
            time: JOB_CANCEL_WINDOW_MS,
        });
        cancelCollector.on("collect", async (i) => {
            controller.abort();
            await i.update({ content: "🛑 Cancelling after the current tracks finish...", components: [] }).catch(() => { /**/ });
        });

        let lastEdit = 0;
        const { entries, failed } = await downloadPlaylistTracks(player, selected, {
            profile,
            concurrency,
            signal: controller.signal,
            onProgress: ({ done, total, failed: failedCount, current }) => {
                if (controller.signal.aborted || Date.now() - lastEdit < PROGRESS_EDIT_INTERVAL_MS)
                    return;
                lastEdit = Date.now();
                responder.edit({ embeds: [progressEmbed(title, thumbnail, done, total, failedCount, current)] }).catch(() => { /**/ });
            },
        });

        cancelCollector.stop();
        if (controller.signal.aborted)
            return await responder.edit({ content: "❌ Playlist download cancelled.", embeds: [], components: [] });

        if (!entries.length) {
            return await responder.edit({
                content: "❌ None of the playlist's tracks could be downloaded.",
                embeds: failed.length ? [new EmbedBuilder().setColor("#FF0000").addFields({ name: "Failed", value: formatFailures(failed) })] : [],
                components: [],
            });
        }

        // --- Deliver --------------------------------------------------------
        const summary = { title, thumbnail, profile, requested: selected.length, failed, skippedForDiscord, compressedCount: 0 };

        if (destination === "drive") {
            await responder.edit({ content: `📦 Zipping ${entries.length} tracks...`, embeds: [], components: [] });
            const built = await buildPlaylistZips(entries, { playlistTitle: title, totalTracks: selected.length });
            zipDir = built.dir;
            const zip = built.zips[0];

            await responder.edit({ content: "☁️ Uploading to your Google Drive..." });
            try {
                const file = await googleDrive.uploadFile(userId, zip.path, {
                    name: zip.name,
                    kind: "playlist",
                    trackCount: entries.length,
                });
                return await sendDriveSummary(responder, summary, entries, file);
            } catch (error) {
                console.error(`Google Drive playlist upload failed: ${error.message}`);
                const relinkHint = error instanceof googleDrive.DriveAuthError
                    ? "\nYour Google Drive has been unlinked, use `/drive login` to link it again."
                    : "";
                await responder.send({
                    content: `⚠️ Couldn't save the playlist to your Google Drive: ${error.message}${relinkHint}\nSending it in Discord instead.`,
                    flags: MessageFlags.Ephemeral,
                }).catch(() => { /**/ });
                // Fall through to the Discord delivery below with what's already downloaded
            }
        }

        await deliverToDiscord(responder, summary, entries, uploadLimitMB, maxDiscordZipParts, (dir) => {
            if (zipDir)
                removePlaylistDir(zipDir);
            zipDir = dir;
        });
    } catch (error) {
        console.error("Playlist download error:", error);
        await interaction.editReply({ content: `❌ Playlist download failed: ${error.message}`, embeds: [], components: [] }).catch(() => { /**/ });
    } finally {
        cancelCollector?.stop();
        activeJobs.delete(userId);
        if (holdsSlot)
            runningJobCount--;
        removePlaylistDir(zipDir);
    }
}

function progressEmbed(title, thumbnail, done, total, failedCount, current) {
    const embed = new EmbedBuilder()
        .setColor("#FFA500")
        .setTitle("⏳ Downloading playlist...")
        .setDescription([
            `**${title}**`,
            `\`${progressBar(done, total)}\` ${done}/${total}`,
            failedCount ? `⚠️ ${failedCount} failed` : null,
            current ? `Now: ${current}` : null,
        ].filter(Boolean).join("\n").slice(0, 4096));

    if (thumbnail)
        embed.setThumbnail(thumbnail);
    return embed;
}

function summaryEmbed({ title, thumbnail, profile, requested, failed, skippedForDiscord, compressedCount }, entries, heading, extraFields = []) {
    const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
    const embed = new EmbedBuilder()
        .setColor(failed.length ? "#FFAA00" : "#00AA00")
        .setTitle(heading)
        .setDescription(`**${title}**`)
        .addFields(
            { name: "Tracks", value: `${entries.length}/${requested}`, inline: true },
            { name: "Size", value: `${(totalBytes / MB).toFixed(1)}MB`, inline: true },
            { name: "Format", value: `ZIP · ${profile.label}`, inline: true },
            ...extraFields,
        );

    if (compressedCount)
        embed.addFields({ name: "Compressed", value: `${compressedCount} track${compressedCount === 1 ? " was" : "s were"} too big for Discord and got compressed (to MP3).` });
    if (skippedForDiscord)
        embed.addFields({ name: "Not included", value: `${skippedForDiscord} track${skippedForDiscord === 1 ? "" : "s"} past the Discord limit. Choose Google Drive to get the full playlist.` });
    if (failed.length)
        embed.addFields({ name: `Failed (${failed.length})`, value: formatFailures(failed) });
    if (thumbnail)
        embed.setThumbnail(thumbnail);

    return embed;
}

async function sendDriveSummary(responder, summary, entries, file) {
    const links = [];
    if (file.webViewLink)
        links.push(new ButtonBuilder().setLabel("Open zip").setStyle(ButtonStyle.Link).setURL(file.webViewLink));
    if (file.folderLink)
        links.push(new ButtonBuilder().setLabel(`Open ${googleDrive.getFolderName()}`).setStyle(ButtonStyle.Link).setURL(file.folderLink));

    await responder.edit({
        content: null,
        embeds: [summaryEmbed(summary, entries, "✅ Playlist saved to Google Drive")],
        components: links.length ? [new ActionRowBuilder().addComponents(links)] : [],
    });
}

async function deliverToDiscord(responder, summary, downloadedEntries, uploadLimitMB, maxParts, setZipDir) {
    await responder.edit({ content: "📦 Preparing zip files...", embeds: [], components: [] });

    const fitted = await fitEntriesForDiscord(downloadedEntries, uploadLimitMB, summary.profile);
    summary.compressedCount = fitted.compressedCount;
    summary.failed = [...summary.failed, ...fitted.failed].sort((a, b) => a.index - b.index);

    if (!fitted.entries.length) {
        return await responder.edit({
            content: "❌ None of the downloaded tracks could be made small enough for Discord.",
            embeds: [summaryEmbed(summary, [], "❌ Playlist not sent")],
        });
    }

    const built = await buildPlaylistZips(fitted.entries, {
        playlistTitle: summary.title,
        totalTracks: summary.requested,
        maxZipBytes: uploadLimitMB * MB * 0.95,
    });
    setZipDir(built.dir);

    // Estimates can be off, never send more parts than allowed
    const zips = built.zips.slice(0, maxParts);
    const sentEntries = zips.flatMap((z) => z.entries);
    summary.skippedForDiscord += fitted.entries.length - sentEntries.length;

    await responder.edit({
        content: null,
        embeds: [summaryEmbed(summary, sentEntries, "✅ Playlist downloaded", [
            { name: "Files", value: `${zips.length} zip${zips.length === 1 ? "" : "s"} below`, inline: true },
        ])],
        components: [],
    });

    for (let i = 0; i < zips.length; i++) {
        try {
            await responder.send({
                content: zips.length > 1 ? `📦 Part ${i + 1}/${zips.length}` : null,
                files: [{ attachment: zips[i].path, name: zips[i].name }],
            });
        } catch (error) {
            console.error(`Failed to send playlist zip ${i + 1}: ${error.message}`);
            await responder.send({ content: `❌ Couldn't send part ${i + 1}/${zips.length}: ${error.message}` }).catch(() => { /**/ });
            return;
        }
    }
}

module.exports = { handlePlaylistDownload };
