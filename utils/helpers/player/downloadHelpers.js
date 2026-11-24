/* eslint-disable no-empty-function */
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require("discord.js");

const DOWNLOAD_ROOT = path.join(process.cwd(), "downloads");

/**
 * Extractor identifier -> key under discordPlayer.extractors in config.jsonc.
 * Used to order the download picker by the priorities set in the config.
 */
const EXTRACTOR_CONFIG_KEYS = {
    "com.retrouser955.discord-player.discord-player-youtubei": "Youtubei",
    "com.itsmaat.discord-player.youtube-sabr": "Youtubei",
    "com.discord-player.soundcloudextractor": "Soundcloud",
    "com.retrouser955.discord-player.deezr-ext": "Deezer",
    "com.itsmaat.discord-player.soundgasm-extractor": "Soundgasm",
    "com.discord-player.attachmentextractor": "Attachment",
    "com.discord-player.itsmaat.spotifyextractor": "Spotify",
    "com.discord-player.applemusicextractor": "AppleMusic",
};

/**
 * Priority of an extractor as written in config.jsonc (falls back to its runtime priority).
 * @returns {{ priority: number, order: number }} order = position in the config, for tie-breaking
 */
function getConfiguredPriority(extractor) {
    const configured = require("@utils/config/configUtils").get("discordPlayer")?.extractors || {};
    const keys = Object.keys(configured);
    const key = EXTRACTOR_CONFIG_KEYS[extractor.identifier];
    const priority = configured[key]?.priority;

    return {
        priority: typeof priority === "number" ? priority : (extractor.priority ?? 0),
        order: key && keys.includes(key) ? keys.indexOf(key) : keys.length,
    };
}

/**
 * Map of extractor identifiers to their capabilities
 * canStream: true = can be directly downloaded, false = needs multi-source bridging
 */
const EXTRACTOR_CAPABILITIES = {
    "com.retrouser955.discord-player.discord-player-youtubei": { canStream: true },  // YouTube (discord-player-youtubei v3)
    "com.itsmaat.discord-player.youtube-sabr": { canStream: true },                  // YouTube (legacy SABR extractor)
    "com.discord-player.soundcloudextractor": { canStream: true },                   // Soundcloud
    "com.retrouser955.discord-player.deezr-ext": { canStream: true },                // Deezer
    "com.itsmaat.discord-player.soundgasm-extractor": { canStream: true },           // Soundgasm
    "com.discord-player.attachmentextractor": { canStream: true },                   // Attachment
    "com.discord-player.itsmaat.spotifyextractor": { canStream: false },             // Spotify (bridge)
    "com.discord-player.applemusicextractor": { canStream: false },                  // AppleMusic (bridge)
};

function ensureDownloadDir() {
    if (!fs.existsSync(DOWNLOAD_ROOT))
        fs.mkdirSync(DOWNLOAD_ROOT, { recursive: true });

    return DOWNLOAD_ROOT;
}

function sanitizeFilename(name = "Unknown") {
    return String(name).replace(/[<>:"|?*\\/]/g, "_").trim() || "Unknown";
}

function buildDownloadPath(track) {
    const downloadDir = ensureDownloadDir();
    const filename = `${sanitizeFilename(track.title)}.mp3`;

    return {
        downloadDir,
        filename,
        outputPath: path.join(downloadDir, filename),
    };
}

function removeFileSafe(filePath) {
    if (!filePath)
        return;

    fs.unlink(filePath, (err) => {
        if (err && err.code !== "ENOENT")
            console.error("Failed to delete temp file:", err);
    });
}

function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0)
        return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

    return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function estimateFileSize(durationMs, bitrate = 192) {
    bitrate ||= 192;
    const bytes = (bitrate * 1000 / 8) * (durationMs / 1000);
    return bytes / (1024 * 1024);
}

function estimateDownloadTime(fileSizeMB, avgSpeedKBps = 500) {
    const fileSizeBytes = fileSizeMB * 1024 * 1024;
    const fileSizeKB = fileSizeBytes / 1024;
    const seconds = fileSizeKB / avgSpeedKBps;
    return Math.ceil(seconds);
}

function formatTimeEstimate(seconds) {
    if (seconds < 60)
        return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;

    if (minutes < 60)
        return `${minutes}m ${secs}s`;

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;

    return `${hours}h ${mins}m`;
}

function getThumbnailURL(track) {
    if (track.thumbnail && typeof track.thumbnail === "string" && track.thumbnail.trim().length > 0)
        return track.thumbnail;

    if (track.raw?.thumbnails && Array.isArray(track.raw.thumbnails) && track.raw.thumbnails.length > 0) {
        const thumbnail = track.raw.thumbnails[0]?.url;

        if (thumbnail && typeof thumbnail === "string" && thumbnail.trim().length > 0)
            return thumbnail;
    }

    if (track.metadata?.thumbnail && typeof track.metadata.thumbnail === "string" && track.metadata.thumbnail.trim().length > 0)
        return track.metadata.thumbnail;

    return null;
}

/**
 * @param {import("discord-player").Track} track
 * @param {import("@utils/helpers/player/audioFormats").AudioProfile} [profile] Output format, MP3 192 kbps if missing
 */
function createDownloadingEmbed(track, profile) {
    const duration = track.durationMS ? formatDuration(track.durationMS) : "Unknown";
    const estimatedSize = track.durationMS ? estimateFileSize(track.durationMS, profile?.estimateKbps) : null;
    const estimatedSizeStr = estimatedSize ? estimatedSize.toFixed(2) : "Unknown";
    const downloadTimeSeconds = estimatedSize ? estimateDownloadTime(estimatedSize) : null;
    const downloadTimeStr = downloadTimeSeconds ? formatTimeEstimate(downloadTimeSeconds) : "Unknown";

    const embed = new EmbedBuilder()
        .setColor("#FFA500")
        .setTitle("⏳ Downloading...")
        .setDescription(`**${track.title}**`)
        .addFields(
            { name: "Artist", value: track.author || "Unknown", inline: true },
            { name: "Duration", value: duration, inline: true },
            { name: "Source", value: track.source || "Unknown", inline: true },
            { name: "Est. File Size", value: `${estimatedSizeStr}MB`, inline: true },
            { name: "Quality", value: profile?.label ?? "MP3 · 192 kbps", inline: true },
            { name: "Est. Time", value: downloadTimeStr, inline: true },
        );

    const thumbnail = getThumbnailURL(track);
    if (thumbnail)
        embed.setThumbnail(thumbnail);

    return embed;
}

/**
 * @param {import("discord-player").Track} track
 * @param {{ sizeMB?: number, bitrateKbps?: number, compressed?: boolean, profile?: import("@utils/helpers/player/audioFormats").AudioProfile }} [fileInfo]
 *   Actual file info, when known. Compressed files are always MP3 at bitrateKbps.
 */
function createSuccessEmbed(track, fileInfo = {}) {
    const duration = track.durationMS ? formatDuration(track.durationMS) : "Unknown";
    const sizeStr = typeof fileInfo.sizeMB === "number"
        ? `${fileInfo.sizeMB.toFixed(2)}MB`
        : `~${track.durationMS ? estimateFileSize(track.durationMS, fileInfo.profile?.estimateKbps).toFixed(2) : "Unknown"}MB`;
    const qualityStr = fileInfo.compressed
        ? `MP3 · ${fileInfo.bitrateKbps} kbps (compressed)`
        : fileInfo.profile?.label ?? `MP3 · ${fileInfo.bitrateKbps ?? 192} kbps`;

    const embed = new EmbedBuilder()
        .setColor("#00AA00")
        .setTitle("✅ Download Complete")
        .setDescription(`**${track.title}**`)
        .addFields(
            { name: "Artist", value: track.author || "Unknown", inline: true },
            { name: "Duration", value: duration, inline: true },
            { name: "Source", value: track.source || "Unknown", inline: true },
            { name: "File Size", value: sizeStr, inline: true },
            { name: "Quality", value: qualityStr, inline: true },
            { name: "Format", value: "MP3", inline: true },
        );

    const thumbnail = getThumbnailURL(track);
    if (thumbnail)
        embed.setThumbnail(thumbnail);

    return embed;
}

function createSourceMessage(sources, sourcePageIndex, trackPageIndex) {
    const [extractorId, tracks] = sources[sourcePageIndex];
    const tracksPerPage = 10;
    const maxTrackPages = Math.ceil(tracks.length / tracksPerPage);
    const trackStart = trackPageIndex * tracksPerPage;
    const tracksOnPage = tracks.slice(trackStart, trackStart + tracksPerPage);

    const embed = new EmbedBuilder()
        .setColor("#2b2d31")
        .setTitle(`📚 ${extractorId}`)
        .setDescription(`Source ${sourcePageIndex + 1}/${sources.length} • Page ${trackPageIndex + 1}/${maxTrackPages}`)
        .setFields(
            tracksOnPage.map((track, i) => ({
                name: `${trackStart + i + 1}. ${track.title}`,
                value: `By ${track.author || "Unknown"}`,
                inline: false,
            })),
        );

    const sourceRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("source_prev")
            .setLabel("◀ Prev Source")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(sourcePageIndex === 0),
        new ButtonBuilder()
            .setCustomId("source_next")
            .setLabel("Next Source ▶")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(sourcePageIndex === sources.length - 1),
    );

    const trackRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId("select_track")
            .setPlaceholder("Select a track...")
            .addOptions(
                tracksOnPage.map((track, i) => ({
                    label: track.title.substring(0, 100),
                    value: `${trackStart + i}`,
                    description: track.author?.substring(0, 100) || "Unknown",
                })),
            ),
    );

    const components = [sourceRow, trackRow];

    if (maxTrackPages > 1) {
        const trackNavRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("track_prev")
                .setLabel("◀ Prev Page")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(trackPageIndex === 0),
            new ButtonBuilder()
                .setCustomId("track_next")
                .setLabel("Next Page ▶")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(trackPageIndex === maxTrackPages - 1),
        );

        components.push(trackNavRow);
    }

    return { embeds: [embed], components };
}

function isNodeStream(value) {
    return Boolean(value && typeof value.pipe === "function" && typeof value.on === "function");
}

function toNodeStream(value) {
    if (!value)
        return null;

    if (isNodeStream(value))
        return value;

    if (typeof value?.getReader === "function" && typeof Readable.fromWeb === "function") {
        try {
            return Readable.fromWeb(value);
        } catch {
            return null;
        }
    }

    return null;
}

function normalizeSourceCandidate(candidate) {
    if (!candidate)
        return null;

    if (typeof candidate === "string") {
        if (isValidDownloadUrl(candidate))
            return { type: "url", value: candidate };

        return null;
    }

    const asStream = toNodeStream(candidate);
    if (asStream)
        return { type: "stream", value: asStream };

    if (typeof candidate.url === "string" && isValidDownloadUrl(candidate.url))
        return { type: "url", value: candidate.url };

    if (typeof candidate.stream === "string" && isValidDownloadUrl(candidate.stream))
        return { type: "url", value: candidate.stream };

    const nestedStream = toNodeStream(candidate.stream);
    if (nestedStream)
        return { type: "stream", value: nestedStream };

    if (Array.isArray(candidate) && candidate.length > 0)
        return normalizeSourceCandidate(candidate[0]);

    return null;
}

async function resolveTrackSource(track) {
    if (!track)
        return null;

    if (track.extractor && typeof track.extractor.stream === "function") {
        try {
            const extractorResult = await Promise.race([
                track.extractor.stream(track),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("Stream timeout after 10s")), 10000),
                ),
            ]);

            const normalized = normalizeSourceCandidate(extractorResult);
            if (normalized)
                return normalized;
        } catch (err) {
            console.error("[Download] Extractor stream failed:", err.message);
        }
    }

    if (typeof track.source?.createStream === "function") {
        try {
            const sourceResult = await track.source.createStream();
            const normalized = normalizeSourceCandidate(sourceResult);

            if (normalized)
                return normalized;
        } catch (err) {
            console.error("[Download] track.source.createStream failed:", err.message);
        }
    }

    const rawSource = normalizeSourceCandidate(track.raw?.source);
    if (rawSource)
        return rawSource;

    if (isValidDownloadUrl(track.url))
        return { type: "url", value: track.url };

    if (isValidDownloadUrl(track.raw?.url))
        return { type: "url", value: track.raw.url };

    return null;
}

function isValidDownloadUrl(value) {
    if (typeof value !== "string" || value.trim().length === 0)
        return false;

    try {
        const url = new URL(value);
        return ["http:", "https:", "file:"].includes(url.protocol);
    } catch {
        return false;
    }
}

async function downloadTrackWithFfmpeg(track, outputPath) {
    try {
        const source = await resolveTrackSource(track);

        if (!source)
            return { success: false, path: null, error: "Could not resolve a valid stream source for this track" };

        const ffmpegArgs = [
            "-y",
            "-loglevel", "error",
            "-i", source.type === "stream" ? "pipe:0" : source.value,
            "-ar", "44100",
            "-ac", "2",
            "-b:a", "192k",
            "-metadata", `title=${track.title}`,
            "-metadata", `artist=${track.author || "Unknown"}`,
            "-f", "mp3",
            outputPath,
        ];

        const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
            stdio: [source.type === "stream" ? "pipe" : "ignore", "ignore", "inherit"],
        });

        if (source.type === "stream") {
            source.value.on("error", (err) => {
                console.error("[Download] Stream error:", err.message);
                if (ffmpeg.stdin && !ffmpeg.stdin.destroyed)
                    ffmpeg.stdin.destroy();
            });

            source.value.on("end", () => {
                if (ffmpeg.stdin && !ffmpeg.stdin.destroyed)
                    ffmpeg.stdin.end();
            });

            if (ffmpeg.stdin) {
                ffmpeg.stdin.on("error", (err) => {
                    console.log("[Download] FFmpeg stdin closed:", err.message);
                });

                source.value.pipe(ffmpeg.stdin);
            }
        }

        const code = await new Promise((resolve) => {
            ffmpeg.on("close", resolve);
            ffmpeg.on("error", () => resolve(1));
        });

        if (code !== 0) {
            removeFileSafe(outputPath);
            return { success: false, path: null, error: `FFmpeg encoding failed (code ${code})` };
        }

        if (!fs.existsSync(outputPath))
            return { success: false, path: null, error: "Download file not created" };

        const stats = fs.statSync(outputPath);
        if (stats.size === 0) {
            removeFileSafe(outputPath);
            return { success: false, path: null, error: "Download file is empty" };
        }

        return { success: true, path: outputPath, error: null };
    } catch (error) {
        removeFileSafe(outputPath);
        return { success: false, path: null, error: error.message };
    }
}

/**
 * Simple resolver that finds the first matching extractor and returns its capabilities
 * Uses protocol hints to avoid false matches (e.g., YouTube accepting Spotify URLs)
 * 
 * @param {string} query 
 * @param {Player} player 
 * @returns {Promise<{ extractor: Extractor | null, canStream: boolean }>}
 */
async function awareQueryResolver(query, player) {
    const extractors = player.extractors.store;
    const result = { extractor: null, canStream: false };

    if (!query || !extractors || !extractors.size) return result;

    // Map URL patterns to allowed extractors to prevent false matches
    const protocolRules = {
        spotify: ["com.discord-player.itsmaat.spotifyextractor"],
        "open.spotify.com": ["com.discord-player.itsmaat.spotifyextractor"],
        "music.apple.com": ["com.discord-player.applemusicextractor"],
        "youtu": ["com.retrouser955.discord-player.discord-player-youtubei"],
        "yt:": ["com.retrouser955.discord-player.discord-player-youtubei"],
        "youtube": ["com.retrouser955.discord-player.discord-player-youtubei"],
        "soundcloud": ["com.discord-player.soundcloudextractor"],
        "sc.com": ["com.discord-player.soundcloudextractor"],
        "deezer": ["com.retrouser955.discord-player.deezr-ext"],
    };

    // Check if query matches any protocol rule
    const queryLower = query.toLowerCase();
    let allowedExtractors = null;

    for (const [protocol, extractorIds] of Object.entries(protocolRules)) {
        if (queryLower.includes(protocol)) {
            allowedExtractors = extractorIds;
            console.log(`[awareQueryResolver] Protocol "${protocol}" detected, limiting to:`, extractorIds);
            break;
        }
    }

    const sortedExtractors = Array.from(extractors.values()).sort((a, b) => b.priority - a.priority);

    for (const extractor of sortedExtractors) {
        try {
            // Skip unsupported extractors
            if (!EXTRACTOR_CAPABILITIES[extractor.identifier]) 
                continue;
            

            // If we detected a protocol, only allow matching extractors
            if (allowedExtractors && !allowedExtractors.includes(extractor.identifier)) 
                continue;
            

            // Validate the query against the extractor
            if (await extractor.validate(query)) {
                result.extractor = extractor;
                result.canStream = EXTRACTOR_CAPABILITIES[extractor.identifier].canStream;
                console.log(`[awareQueryResolver] Found ${extractor.identifier} with canStream=${result.canStream}`);
                break;
            }
        } catch (error) {
            console.error(`Error validating extractor ${extractor.identifier}:`, error.message);
        }
    }

    return result;
}

async function downloadTrackDirectly(track, outputPath, onProgress) {
    try {
        const source = await resolveTrackSource(track);

        if (source?.type === "stream")
            return pipeStreamToFile(source.value, outputPath, onProgress);

        if (source?.type === "url")
            return downloadFromURL(source.value, outputPath, onProgress);

        return { success: false, path: null, error: "Could not find a valid download source for this track" };
    } catch (error) {
        return { success: false, path: null, error: error.message };
    }
}

/**
 * Helper function to pipe a stream to a file with progress tracking
 */
function pipeStreamToFile(stream, outputPath, onProgress) {
    return new Promise((resolve) => {
        const writeStream = fs.createWriteStream(outputPath);
        let bytesDownloaded = 0;
        
        stream.on("data", (chunk) => {
            bytesDownloaded += chunk.length;
            if (onProgress) 
                onProgress({ bytesDownloaded, totalBytes: undefined, progress: undefined });
            
        });
        
        stream.pipe(writeStream);

        writeStream.on("finish", () => {
            resolve({ success: true, path: outputPath, error: null });
        });

        writeStream.on("error", (err) => {
            fs.unlink(outputPath, () => {}); // Clean up on error
            resolve({ success: false, path: null, error: err.message });
        });

        stream.on("error", (err) => {
            writeStream.destroy();
            fs.unlink(outputPath, () => {}); // Clean up on error
            resolve({ success: false, path: null, error: err.message });
        });
    });
}

/**
 * Helper function to download from a URL with progress tracking
 */
function downloadFromURL(url, outputPath, onProgress) {
    return new Promise((resolve) => {
        const file = fs.createWriteStream(outputPath);
        let bytesDownloaded = 0;
        
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === "https:";
        const httpModule = isHttps ? https : http;

        const request = httpModule.get(url, (response) => {
            // Handle redirects
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                file.close();
                fs.unlink(outputPath, () => {});
                return downloadFromURL(response.headers.location, outputPath, onProgress).then(resolve);
            }

            const totalBytes = parseInt(response.headers["content-length"], 10) || undefined;

            response.on("data", (chunk) => {
                bytesDownloaded += chunk.length;
                if (onProgress) {
                    const progress = totalBytes ? Math.round((bytesDownloaded / totalBytes) * 100) : undefined;
                    onProgress({ bytesDownloaded, totalBytes, progress });
                }
            });

            response.pipe(file);

            file.on("finish", () => {
                file.close();
                resolve({ success: true, path: outputPath, error: null });
            });

            file.on("error", (err) => {
                file.close();
                fs.unlink(outputPath, () => {});
                resolve({ success: false, path: null, error: err.message });
            });
        }).on("error", (err) => {
            fs.unlink(outputPath, () => {});
            resolve({ success: false, path: null, error: err.message });
        });
    });
}

/**
 * Supported extractors that can stream, in config.jsonc priority order
 * (highest first; ties keep the order they're listed in the config)
 */
function getStreamableExtractors(player) {
    const extractors = player.extractors.store;
    if (!extractors || !extractors.size) return [];

    return Array.from(extractors.values())
        .filter((extractor) => EXTRACTOR_CAPABILITIES[extractor.identifier]?.canStream)
        .map((extractor) => ({ extractor, ...getConfiguredPriority(extractor) }))
        .sort((a, b) => b.priority - a.priority || a.order - b.order)
        .map(({ extractor }) => extractor);
}

/**
 * Whether a track can be downloaded directly from its own extractor (no bridging needed).
 */
function isStreamableTrack(track) {
    return Boolean(EXTRACTOR_CAPABILITIES[track?.extractor?.identifier]?.canStream);
}

/**
 * Finds the first streamable match for a query, trying sources one by one in priority order.
 * Used to bridge tracks automatically (e.g. Spotify playlist tracks) where there's no user to pick.
 * @returns {Promise<import("discord-player").Track | null>}
 */
async function findStreamableMatch(player, query) {
    for (const extractor of getStreamableExtractors(player)) {
        try {
            const searchResult = await player.search(query, {
                searchEngine: `ext:${extractor.identifier}`,
            });

            const match = searchResult.tracks.find((t) => !t.isPlaylist);
            if (match)
                return match;
        } catch (error) {
            console.error(`Error searching with extractor ${extractor.identifier}:`, error.message);
        }
    }

    return null;
}

async function searchAcrossExtractors(player, query) {
    const results = new Map();
    const streamable = getStreamableExtractors(player);

    if (!streamable.length) return results;

    // Search all sources in parallel, keeping the priority order in the result map
    const searches = await Promise.all(streamable.map(async (extractor) => {
        try {
            const searchResult = await player.search(query, {
                searchEngine: `ext:${extractor.identifier}`,
            });

            return searchResult.hasTracks()
                ? [extractor.identifier, searchResult.tracks.filter((t) => !t.isPlaylist).slice(0, 10)]
                : null;
        } catch (error) {
            console.error(`Error searching with extractor ${extractor.identifier}:`, error);
            return null;
        }
    }));

    for (const entry of searches) {
        if (entry && entry[1].length > 0)
            results.set(entry[0], entry[1]);
    }

    return results;
}

function createSourcePageEmbed(searchResults, pageIndex) {
    const sources = Array.from(searchResults.entries());
    const [extractorId, tracks] = sources[pageIndex];

    const embed = {
        color: 0x2b2d31,
        title: `Search Results from ${extractorId}`,
        description: `Page ${pageIndex + 1} of ${sources.length}`,
        fields: [],
        footer: { text: "Use the dropdown menu to select a track" },
    };

    tracks.forEach((track, index) => {
        embed.fields.push({
            name: `${index + 1}. ${track.title}`,
            value: `By ${track.author || "Unknown"}`,
        });
    });

    return embed;
}

module.exports = {
    awareQueryResolver,
    downloadTrackDirectly,
    downloadTrackWithFfmpeg,
    searchAcrossExtractors,
    findStreamableMatch,
    isStreamableTrack,
    createSourcePageEmbed,
    ensureDownloadDir,
    sanitizeFilename,
    buildDownloadPath,
    removeFileSafe,
    formatDuration,
    estimateFileSize,
    estimateDownloadTime,
    formatTimeEstimate,
    getThumbnailURL,
    createDownloadingEmbed,
    createSuccessEmbed,
    createSourceMessage,
};