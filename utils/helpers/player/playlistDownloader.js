const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const yazl = require("yazl");
const { downloadViaStream, compressAudioFile } = require("@utils/helpers/player/downloader");
const {
    findStreamableMatch,
    isStreamableTrack,
    estimateFileSize,
    sanitizeFilename,
} = require("@utils/helpers/player/downloadHelpers");

/**
 * Playlist downloads: fetch every track, then pack them into zip file(s).
 * Lives under ./downloads so the daily cleanup also catches leftovers.
 */

const PLAYLIST_ROOT = path.resolve("./downloads/_playlists");
const UNKNOWN_DURATION_MS = 4 * 60 * 1000; // Used for size estimates when a track has no duration
// Zip bookkeeping (local header + central directory entry + file name, twice) and the m3u8, with margin
const ZIP_BASE_OVERHEAD_BYTES = 64 * 1024;
const ZIP_ENTRY_OVERHEAD_BYTES = 1024;
const MB = 1024 * 1024;

/**
 * @typedef {object} PlaylistEntry
 * @property {number} index Position in the playlist (0-based)
 * @property {import("discord-player").Track} track Original playlist track (used for names)
 * @property {string} path Local audio file path
 * @property {number} sizeBytes
 * @property {number | null} bitrateKbps Set when the file was compressed
 */

/**
 * @typedef {object} PlaylistFailure
 * @property {number} index
 * @property {import("discord-player").Track} track
 * @property {string} reason
 */

function estimateTrackMB(track, profile) {
    return estimateFileSize(track.durationMS > 0 ? track.durationMS : UNKNOWN_DURATION_MS, profile?.estimateKbps);
}

function trackLabel(track) {
    return track.author ? `${track.author} - ${track.title}` : track.title;
}

/**
 * Estimates how a playlist splits into Discord-sized zips.
 * Tracks bigger than the limit count as compressed down to it.
 * @param {import("@utils/helpers/player/audioFormats").AudioProfile} [profile] Output format, for size estimates
 * @returns {{ totalMB: number, trackCount: number, parts: number }} trackCount = how many tracks fit in maxParts zips
 */
function planDiscordParts(tracks, uploadLimitMB, maxParts, profile) {
    const budgetBytes = uploadLimitMB * MB * 0.95 - ZIP_BASE_OVERHEAD_BYTES;
    let parts = 0;
    let used = Infinity;
    let trackCount = 0;
    const totalMB = tracks.reduce((sum, track) => sum + estimateTrackMB(track, profile), 0);

    for (const track of tracks) {
        const estimatedMB = estimateTrackMB(track, profile);
        const bytes = Math.min(estimatedMB * MB, budgetBytes - ZIP_ENTRY_OVERHEAD_BYTES) + ZIP_ENTRY_OVERHEAD_BYTES;

        if (used + bytes > budgetBytes) {
            if (parts === maxParts)
                break;
            parts++;
            used = 0;
        }

        used += bytes;
        trackCount++;
    }

    return { totalMB, trackCount, parts };
}

/**
 * Downloads every track of a playlist. Tracks that can't be streamed directly are bridged
 * to the first streamable source that has a match.
 * @param {import("discord-player").Player} player
 * @param {import("discord-player").Track[]} tracks
 * @param {{ profile?: import("@utils/helpers/player/audioFormats").AudioProfile, concurrency?: number, signal?: AbortSignal, onProgress?: (p: { done: number, total: number, failed: number, current: string | null }) => void }} [options]
 * @returns {Promise<{ entries: PlaylistEntry[], failed: PlaylistFailure[] }>}
 */
async function downloadPlaylistTracks(player, tracks, { profile, concurrency = 2, signal, onProgress } = {}) {
    const entries = [];
    const failed = [];
    const inFlight = new Map(); // Same song twice in a playlist -> download once
    let next = 0;
    let done = 0;

    const downloadOne = async (track) => {
        const source = isStreamableTrack(track)
            ? track
            : await findStreamableMatch(player, `${track.title} ${track.author || ""}`.trim());

        if (!source)
            throw new Error("No streamable source found");

        const outputPath = await downloadViaStream(source, profile);
        if (!outputPath)
            throw new Error("Download failed");
        return outputPath;
    };

    const worker = async () => {
        while (next < tracks.length && !signal?.aborted) {
            const index = next++;
            const track = tracks[index];
            onProgress?.({ done, total: tracks.length, failed: failed.length, current: trackLabel(track) });

            const key = `${track.title}\u0000${track.author}`.toLowerCase();
            if (!inFlight.has(key))
                inFlight.set(key, downloadOne(track));

            try {
                const outputPath = await inFlight.get(key);
                entries.push({ index, track, path: outputPath, sizeBytes: fs.statSync(outputPath).size, bitrateKbps: null });
            } catch (error) {
                failed.push({ index, track, reason: error.message });
            }

            done++;
            onProgress?.({ done, total: tracks.length, failed: failed.length, current: null });
        }
    };

    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

    entries.sort((a, b) => a.index - b.index);
    failed.sort((a, b) => a.index - b.index);
    return { entries, failed };
}

/**
 * Compresses entries that wouldn't fit in a Discord zip on their own.
 * Entries that can't be compressed enough are moved to `failed`.
 * @param {PlaylistEntry[]} entries
 * @param {number} uploadLimitMB
 * @param {import("@utils/helpers/player/audioFormats").AudioProfile} [profile] Format of the entries
 * @returns {Promise<{ entries: PlaylistEntry[], failed: PlaylistFailure[], compressedCount: number }>}
 */
async function fitEntriesForDiscord(entries, uploadLimitMB, profile) {
    const maxEntryMB = (uploadLimitMB * MB * 0.95 - ZIP_BASE_OVERHEAD_BYTES - ZIP_ENTRY_OVERHEAD_BYTES) / MB;
    const kept = [];
    const failed = [];
    let compressedCount = 0;

    for (const entry of entries) {
        if (entry.sizeBytes / MB <= maxEntryMB) {
            kept.push(entry);
            continue;
        }

        const result = await compressAudioFile(entry.path, maxEntryMB, entry.track.durationMS, profile?.estimateKbps);
        if (!result) {
            failed.push({ index: entry.index, track: entry.track, reason: `Too long to fit under ${uploadLimitMB}MB` });
            continue;
        }

        compressedCount++;
        kept.push({ ...entry, path: result.path, sizeBytes: fs.statSync(result.path).size, bitrateKbps: result.bitrateKbps });
    }

    return { entries: kept, failed, compressedCount };
}

/**
 * Splits entries (in order) into groups that each fit in one zip of at most maxZipBytes.
 * @param {PlaylistEntry[]} entries
 * @param {number} [maxZipBytes] Infinity = a single zip
 * @returns {PlaylistEntry[][]}
 */
function splitIntoParts(entries, maxZipBytes = Infinity) {
    const budget = maxZipBytes - ZIP_BASE_OVERHEAD_BYTES;
    const parts = [];
    let current = [];
    let used = 0;

    for (const entry of entries) {
        const bytes = entry.sizeBytes + ZIP_ENTRY_OVERHEAD_BYTES;
        if (current.length && used + bytes > budget) {
            parts.push(current);
            current = [];
            used = 0;
        }

        current.push(entry);
        used += bytes;
    }

    if (current.length)
        parts.push(current);

    return parts;
}

function zipEntryName(entry, padLength) {
    const number = String(entry.index + 1).padStart(padLength, "0");
    const name = sanitizeFilename(trackLabel(entry.track)).slice(0, 150);
    return `${number} - ${name}${path.extname(entry.path) || ".mp3"}`;
}

function buildM3u(entries, padLength) {
    const lines = ["#EXTM3U"];
    for (const entry of entries) {
        const seconds = entry.track.durationMS > 0 ? Math.round(entry.track.durationMS / 1000) : -1;
        lines.push(`#EXTINF:${seconds},${trackLabel(entry.track)}`, zipEntryName(entry, padLength));
    }
    return Buffer.from(lines.join("\n") + "\n", "utf8");
}

/**
 * Writes a zip with the given entries (stored, audio files don't compress) plus a playlist.m3u8.
 * @returns {Promise<string>} The zip path
 */
function writeZip(entries, zipPath, padLength) {
    return new Promise((resolve, reject) => {
        const zip = new yazl.ZipFile();
        for (const entry of entries)
            zip.addFile(entry.path, zipEntryName(entry, padLength), { compress: false });
        zip.addBuffer(buildM3u(entries, padLength), "playlist.m3u8");
        zip.end();

        const output = fs.createWriteStream(zipPath);
        zip.outputStream.on("error", reject);
        output.on("error", reject);
        output.on("close", () => resolve(zipPath));
        zip.outputStream.pipe(output);
    });
}

/**
 * Builds the zip file(s) for a playlist.
 * @param {PlaylistEntry[]} entries
 * @param {{ playlistTitle: string, totalTracks: number, maxZipBytes?: number }} options
 * @returns {Promise<{ dir: string, zips: { path: string, name: string, entries: PlaylistEntry[] }[] }>}
 */
async function buildPlaylistZips(entries, { playlistTitle, totalTracks, maxZipBytes = Infinity }) {
    const dir = path.join(PLAYLIST_ROOT, crypto.randomUUID());
    fs.mkdirSync(dir, { recursive: true });

    const baseName = sanitizeFilename(playlistTitle).slice(0, 100) || "Playlist";
    const padLength = String(totalTracks).length;
    const parts = splitIntoParts(entries, maxZipBytes);
    const zips = [];

    for (let i = 0; i < parts.length; i++) {
        const name = parts.length > 1 ? `${baseName} (part ${i + 1} of ${parts.length}).zip` : `${baseName}.zip`;
        const zipPath = await writeZip(parts[i], path.join(dir, name), padLength);
        zips.push({ path: zipPath, name, entries: parts[i] });
    }

    return { dir, zips };
}

function removePlaylistDir(dir) {
    if (dir)
        fs.rm(dir, { recursive: true, force: true }, () => { /**/ });
}

module.exports = {
    trackLabel,
    planDiscordParts,
    downloadPlaylistTracks,
    fitEntriesForDiscord,
    buildPlaylistZips,
    removePlaylistDir,
};
