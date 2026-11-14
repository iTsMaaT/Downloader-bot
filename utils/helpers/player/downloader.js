/* eslint-disable no-useless-catch */
/* eslint-disable no-empty */
/* eslint-disable no-empty-function */
/* eslint-disable no-control-regex */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const https = require("node:https");
const { PassThrough } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { StreamType } = require("discord-player");

const DOWNLOAD_ROOT = path.resolve("./downloads");
const MAX_CONCURRENT = 2;
const metadataCache = new Map();
let activeDownloadOperations = 0;

/** @type {Set<Promise<void>>} */
const activeJobs = new Set();

/** @type {Array<() => Promise<void>>} */
const queue = [];

/** @type {Set<string>} */
const knownHashes = new Set();

/**
 * Ensures a directory exists (recursive).
 * @param {string} dir
 */
function ensureDir(dir) {
    if (!fs.existsSync(dir)) 
        fs.mkdirSync(dir, { recursive: true });
    
}

/**
 * Waits for an ffmpeg process to exit.
 * @param {import("node:child_process").ChildProcessWithoutNullStreams} ffmpeg
 * @returns {Promise<number>}
 */
function waitForFfmpegClose(ffmpeg) {
    return new Promise((resolve) => ffmpeg.on("close", resolve));
}

/**
 * Builds ffmpeg metadata args for audio output.
 * @param {{ title: string, artist: string, album: string, year: string | null }} params
 * @returns {string[]}
 */
function buildAudioMetadataArgs({ title, artist, album, year }) {
    const args = [
        "-ar", "44100",
        "-ac", "2",
        "-b:a", "192k",
        "-metadata", `title=${title}`,
        "-metadata", `artist=${artist}`,
        "-metadata", `album=${album}`,
    ];

    if (year)
        args.push("-metadata", `date=${year}`);

    return args;
}

/**
 * Builds optional cover art args.
 * @param {Buffer | null} thumbBuffer
 * @returns {string[]}
 */
function buildCoverArgs(thumbBuffer) {
    if (!thumbBuffer)
        return ["-vn"];

    return [
        "-f", "image2pipe",
        "-i", "pipe:3",
        "-map", "0:a",
        "-map", "1:v",
        "-c:v", "mjpeg",
        "-id3v2_version", "3",
        "-metadata:s:v", "title=Album cover",
        "-metadata:s:v", "comment=Cover (front)",
    ];
}

/**
 * Performs a single ffmpeg stdin transcoding attempt from a live stream.
 * @param {NodeJS.ReadableStream} stream
 * @param {string[]} inputArgs
 * @param {{ title: string, artist: string, album: string, year: string | null }} tags
 * @param {Buffer | null} thumbBuffer
 * @param {string} outputPath
 * @returns {Promise<number>}
 */
async function transcodeStreamAttempt(stream, inputArgs, tags, thumbBuffer, outputPath) {
    const args = [
        "-loglevel", "error",
        "-fflags", "+discardcorrupt",
        "-err_detect", "ignore_err",
        "-probesize", "10M",
        "-analyzeduration", "10M",
        ...inputArgs,
        "-i", "pipe:0",
        ...buildCoverArgs(thumbBuffer),
        ...buildAudioMetadataArgs(tags),
        "-f", "mp3",
        outputPath,
    ];

    const ffmpeg = spawn("ffmpeg", args, {
        stdio: ["pipe", "ignore", "pipe", "pipe"],
    });

    ffmpeg.stdin.on("error", () => {});
    // pipe() doesn't close the destination on source error, which would leave ffmpeg waiting forever
    stream.on("error", (err) => {
        console.error("[Download] Source stream error:", err.message);
        if (!ffmpeg.stdin.destroyed) ffmpeg.stdin.end();
    });
    stream.pipe(ffmpeg.stdin);

    if (thumbBuffer && ffmpeg.stdio[3] && !ffmpeg.stdio[3].destroyed) {
        ffmpeg.stdio[3].write(thumbBuffer);
        ffmpeg.stdio[3].end();
    }

    return await waitForFfmpegClose(ffmpeg);
}

/**
 * Fallback: dump raw input stream to temp file, then transcode from file.
 * This avoids stdin decoding edge-cases on some extractor streams.
 * @param {NodeJS.ReadableStream} stream
 * @param {{ title: string, artist: string, album: string, year: string | null }} tags
 * @param {Buffer | null} thumbBuffer
 * @param {string} outputPath
 * @returns {Promise<number>}
 */
async function transcodeViaBufferedInput(stream, tags, thumbBuffer, outputPath) {
    const tempInputPath = `${outputPath}.input.tmp`;

    try {
        const tempWriteStream = fs.createWriteStream(tempInputPath);
        await pipeline(stream, tempWriteStream);

        const args = [
            "-loglevel", "error",
            "-fflags", "+discardcorrupt",
            "-err_detect", "ignore_err",
            "-probesize", "10M",
            "-analyzeduration", "10M",
            "-i", tempInputPath,
            ...buildCoverArgs(thumbBuffer),
            ...buildAudioMetadataArgs(tags),
            "-f", "mp3",
            outputPath,
        ];

        const ffmpeg = spawn("ffmpeg", args, {
            stdio: ["ignore", "ignore", "pipe", "pipe"],
        });

        if (thumbBuffer && ffmpeg.stdio[3] && !ffmpeg.stdio[3].destroyed) {
            ffmpeg.stdio[3].write(thumbBuffer);
            ffmpeg.stdio[3].end();
        }

        return await waitForFfmpegClose(ffmpeg);
    } finally {
        fs.rmSync(tempInputPath, { force: true });
    }
}

/**
 * Sanitizes a string for safe filesystem usage.
 * @param {string} [str]
 * @returns {string}
 */
function sanitize(str = "Unknown") {
    const cleaned = str.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").trim().replace(/^\.+|[. ]+$/g, "");
    return cleaned || "Unknown";
}

/**
 * Adds a job to the queue.
 * @param {() => Promise<void>} job
 */
function enqueue(job) {
    queue.push(job);
    processQueue();
}

/**
 * Processes queued jobs with concurrency limit.
 */
function processQueue() {
    if (activeJobs.size >= MAX_CONCURRENT) return;

    const job = queue.shift();
    if (!job) return;

    const promise = job();
    activeJobs.add(promise);

    promise.finally(() => {
        activeJobs.delete(promise);
        processQueue();
    });
}

/**
 * Fetches a thumbnail from a URL.
 * @param {string | undefined} url
 * @returns {Promise<Buffer|null>}
 */
function fetchThumbnail(url) {
    return new Promise((resolve) => {
        if (!url) return resolve(null);

        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return resolve(null);
            }

            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
        }).on("error", () => resolve(null));
    });
}

/**
 * Fetch metadata from MusicBrainz
 * @param {string} title
 * @param {string} artist
 * @returns {Promise<{ album?: string, year?: string } | null>}
 */
function fetchMetadata(title, artist) {
    const query = encodeURIComponent(`recording:${title} AND artist:${artist}`);
    const url = `https://musicbrainz.org/ws/2/recording?query=${query}&fmt=json&limit=1`;

    return new Promise((resolve) => {
        https.get(url, {
            headers: {
                "User-Agent": "YourBot/1.0 (your@email.com)",
            },
        }, (res) => {
            let data = "";

            res.on("data", (c) => (data += c));
            res.on("end", () => {
                try {
                    const json = JSON.parse(data);
                    const rec = json.recordings?.[0];

                    if (!rec) return resolve(null);

                    const release = rec.releases?.[0];

                    resolve({
                        album: release?.title,
                        year: release?.date?.split("-")[0],
                    });
                } catch {
                    resolve(null);
                }
            });
        }).on("error", () => resolve(null));
    });
}

async function fetchMetadataCached(title, artist) {
    const key = `${title}|${artist}`;

    if (metadataCache.has(key)) 
        return metadataCache.get(key);
    

    const data = await fetchMetadata(title, artist);
    metadataCache.set(key, data);

    return data;
}

/**
 * Converts an image buffer (webp/png/etc) to JPEG using FFmpeg
 * @param {Buffer} input
 * @returns {Promise<Buffer|null>}
 */
function convertToJpeg(input) {
    return new Promise((resolve) => {
        const ffmpeg = spawn("ffmpeg", [
            "-loglevel", "error",
            "-i", "pipe:0",
            "-f", "image2",
            "-vcodec", "mjpeg",
            "pipe:1",
        ], {
            stdio: ["pipe", "pipe", "ignore"],
        });

        const chunks = [];

        ffmpeg.stdout.on("data", (c) => chunks.push(c));
        ffmpeg.stdout.on("end", () => {
            resolve(Buffer.concat(chunks));
        });

        ffmpeg.on("error", () => resolve(null));
        ffmpeg.on("close", () => resolve(Buffer.concat(chunks)));

        ffmpeg.stdin.write(input);
        ffmpeg.stdin.end();
    });
}

/**
 * Main entry point for downloading a track.
 * Attempts stream-based download first, falls back to interceptor stream.
 *
 * @param {import("discord-player").Track} track
 * @param {{ queueCtx: any, format: number, stream: any } | undefined} fallbackData
 */
function downloadTrack(track, fallbackData) {
    enqueue(async () => {
        try {
            await downloadViaStream(track);
        } catch (err) {
            console.log("[FALLBACK] stream() failed → raw stream\n", err);

            if (!fallbackData) {
                console.log("[NO FALLBACK AVAILABLE]");
                return;
            }

            await downloadViaRaw(
                fallbackData.queueCtx,
                track,
                fallbackData.format,
                fallbackData.stream,
            );
        }
    });
}

/**
 * Downloads a track using track.stream().
 * @param {import("discord-player").Track} track
 */
async function downloadViaStream(track) {
    activeDownloadOperations++;
    try {
        const isDeezerTrack = track?.extractor?.identifier === "com.retrouser955.discord-player.deezr-ext";
        const title = sanitize(track.title);
        const artist = sanitize(track.author || "Unknown Artist");
        let album = track.metadata?.album;
        let year = null;

        if (!album) {
            const meta = await fetchMetadataCached(track.title, track.author);
            album = meta?.album;
            year = meta?.year || null;
        }

        album = sanitize(album || "Unknown Album");

        const outputDir = path.join(DOWNLOAD_ROOT, artist, album);
        ensureDir(outputDir);

        const outputPath = path.join(outputDir, `${title}.mp3`);

        if (fs.existsSync(outputPath)) {
            console.log(`[SKIP EXISTS] ${outputPath}`);
            return outputPath;
        }

        console.log(`[STREAM DOWNLOAD] ${artist} - ${title}`);

        const hash = crypto.createHash("sha1");
        let hashing = true;

        let thumbBuffer = await fetchThumbnail(
            track.thumbnail || track.raw?.thumbnails?.[0]?.url,
        );

        // ---- Detect WebP ----
        const isWebp =
        thumbBuffer &&
        thumbBuffer.subarray(0, 4).toString() === "RIFF" &&
        thumbBuffer.subarray(8, 12).toString() === "WEBP";

        if (isWebp) {
            console.log("[THUMBNAIL] WebP detected → converting to JPEG");

            const converted = await convertToJpeg(thumbBuffer);

            if (converted && converted.length > 0) {
                thumbBuffer = converted;
            } else {
                console.log("[THUMBNAIL] Conversion failed → skipping");
                thumbBuffer = null;
            }
        }
        const tags = { title, artist, album, year };
        const inputCandidates = [
            [],
            ...(isDeezerTrack ? [["-f", "mp3"]] : []),
            ["-f", "opus"],
            ["-f", "s16le", "-ar", "48000", "-ac", "2"],
        ];

        let success = false;

        for (const inputArgs of inputCandidates) {
            let stream;
            try {
                stream = await Promise.race([
                    track.extractor.stream(track),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Stream timeout")), 10000)),
                ]);
            } catch (e) {
                throw e;
            }

            if (!stream || typeof stream.pipe !== "function")
                throw new Error("Extractor did not return a pipeable stream");

            stream.on("data", (c) => {
                if (hashing) hash.update(c);
            });

            const code = await transcodeStreamAttempt(stream, inputArgs, tags, thumbBuffer, outputPath);

            if (code === 0) {
                success = true;
                break;
            }

            fs.rmSync(outputPath, { force: true });

            if (!inputArgs.length) {
                let retryStream;
                try {
                    retryStream = await Promise.race([
                        track.extractor.stream(track),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Stream timeout")), 10000)),
                    ]);
                } catch {
                    continue;
                }

                const bufferedCode = await transcodeViaBufferedInput(retryStream, tags, thumbBuffer, outputPath);

                if (bufferedCode === 0) {
                    success = true;
                    break;
                }

                fs.rmSync(outputPath, { force: true });
            }
        }

        if (!success) {
            console.log(`[FFMPEG ERROR] ${title} (all input modes failed)`);
            fs.rmSync(outputPath, { force: true });
            return null;
        }
        hashing = false;

        const digest = hash.digest("hex");

        if (!fs.existsSync(outputPath)) return null;

        const stats = fs.statSync(outputPath);

        if (stats.size < 100_000) {
            fs.rmSync(outputPath, { force: true });
            return null;
        }

        if (knownHashes.has(digest)) {
            console.log(`[DUPLICATE] ${title}`);
            fs.rmSync(outputPath, { force: true });
            return null;
        }

        knownHashes.add(digest);

        console.log(`[DONE] ${outputPath}`);
        return outputPath;
    } finally {
        activeDownloadOperations = Math.max(0, activeDownloadOperations - 1);
    }
}

/**
 * Fallback downloader using intercepted raw stream.
 * @param {*} queueCtx
 * @param {import("discord-player").Track} track
 * @param {number} format
 * @param {*} stream
 */
async function downloadViaRaw(queueCtx, track, format, stream) {
    activeDownloadOperations++;
    try {
        const title = sanitize(track.title);
        const artist = sanitize(track.author || "Unknown Artist");
        let album = track.metadata?.album;
        let year = null;

        if (!album) {
            const meta = await fetchMetadataCached(track.title, track.author);
            album = meta?.album;
            year = meta?.year || null;
        }

        album = sanitize(album || "Unknown Album");

        const outputDir = path.join(DOWNLOAD_ROOT, artist, album);
        ensureDir(outputDir);

        const outputPath = path.join(outputDir, `${title}.mp3`);

        if (fs.existsSync(outputPath)) return;

        console.log(`[RAW FALLBACK] ${artist} - ${title}`);

        const passthrough = new PassThrough();
        const hashStream = new PassThrough();

        stream.interceptors.add(passthrough);
        stream.interceptors.add(hashStream);

        const hash = crypto.createHash("sha1");
        hashStream.on("data", (c) => hash.update(c));

        let aborted = false;
        stream.on("close", () => (aborted = true));
        stream.on("error", () => (aborted = true));

        let thumbBuffer = await fetchThumbnail(
            track.thumbnail || track.raw?.thumbnails?.[0]?.url,
        );

        // ---- Detect WebP ----
        const isWebp =
        thumbBuffer &&
        thumbBuffer.subarray(0, 4).toString() === "RIFF" &&
        thumbBuffer.subarray(8, 12).toString() === "WEBP";

        if (isWebp) {
            console.log("[THUMBNAIL] WebP detected → converting to JPEG");

            const converted = await convertToJpeg(thumbBuffer);

            if (converted && converted.length > 0) {
                thumbBuffer = converted;
            } else {
                console.log("[THUMBNAIL] Conversion failed → skipping");
                thumbBuffer = null;
            }
        }

        const inputArgs =
            format === StreamType.Opus
                ? ["-f", "opus", "-i", "pipe:0"]
                : ["-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0"];

        const args = [
            "-loglevel", "error",
            "-fflags", "+discardcorrupt",
            "-err_detect", "ignore_err",
            "-probesize", "10M",
            "-analyzeduration", "10M",
            ...inputArgs,
        ];

        if (thumbBuffer) {
            args.push(
                "-f", "image2pipe",
                "-i", "pipe:3",
                "-map", "0:a",
                "-map", "1:v",
                "-c:v", "mjpeg",
                "-id3v2_version", "3",
                "-metadata:s:v", "title=Album cover",
                "-metadata:s:v", "comment=Cover (front)",
            );
        }

        if (!thumbBuffer) args.push("-vn");
        args.push(
            "-ar", "44100",
            "-ac", "2",
            "-b:a", "192k",
            "-metadata", `title=${title}`,
            "-metadata", `artist=${artist}`,
            "-metadata", `album=${album}`,
        );


        if (year) 
            args.push("-metadata", `date=${year}`);

        args.push("-f", "mp3", outputPath);

        const ffmpeg = spawn("ffmpeg", args, {
            stdio: ["pipe", "ignore", "pipe", "pipe"],
        });

        ffmpeg.stdin.on("error", () => {});

        (async () => {
            try {
                await pipeline(passthrough, ffmpeg.stdin);
            } catch {}
        })();

        if (thumbBuffer && ffmpeg.stdio[3] && !ffmpeg.stdio[3].destroyed) {
            ffmpeg.stdio[3].write(thumbBuffer);
            ffmpeg.stdio[3].end();
        }

        const code = await new Promise((r) => ffmpeg.on("close", r));

        if (code !== 0) {
            console.log(`[FFMPEG ERROR] ${title} (code ${code})`);
            fs.rmSync(outputPath, { force: true });
            return;
        }

        if (aborted || !fs.existsSync(outputPath)) {
            fs.rmSync(outputPath, { force: true });
            return;
        }

        const stats = fs.statSync(outputPath);
        if (stats.size < 100_000) {
            fs.rmSync(outputPath, { force: true });
            return;
        }

        const digest = hash.digest("hex");

        if (knownHashes.has(digest)) {
            fs.rmSync(outputPath, { force: true });
            return;
        }

        knownHashes.add(digest);

        console.log(`[DONE RAW] ${outputPath}`);
    } finally {
        activeDownloadOperations = Math.max(0, activeDownloadOperations - 1);
    }
}

function isDownloadOperationOngoing() {
    return activeDownloadOperations > 0 || activeJobs.size > 0 || queue.length > 0;
}

/**
 * Standard MP3 bitrates (kbps) with a sample rate LAME accepts for them, highest first.
 * Below 32 kbps MPEG-1 isn't valid, so the sample rate drops to MPEG-2/2.5 rates.
 */
const MP3_BITRATE_STEPS = [
    { kbps: 320, ar: 44100 },
    { kbps: 256, ar: 44100 },
    { kbps: 224, ar: 44100 },
    { kbps: 192, ar: 44100 },
    { kbps: 160, ar: 44100 },
    { kbps: 128, ar: 44100 },
    { kbps: 112, ar: 44100 },
    { kbps: 96, ar: 44100 },
    { kbps: 80, ar: 44100 },
    { kbps: 64, ar: 44100 },
    { kbps: 56, ar: 44100 },
    { kbps: 48, ar: 44100 },
    { kbps: 40, ar: 44100 },
    { kbps: 32, ar: 44100 },
    { kbps: 24, ar: 22050 },
    { kbps: 16, ar: 22050 },
    { kbps: 8, ar: 11025 },
];
const ORIGINAL_BITRATE_KBPS = 192;
const COMPRESS_SAFETY_RATIO = 0.95;
const MAX_COMPRESS_ATTEMPTS = 3;

/**
 * Re-encodes an MP3 at a single bitrate.
 * @returns {Promise<number>} ffmpeg exit code
 */
function reencodeMp3(inputPath, outputPath, { kbps, ar }, keepCover) {
    const args = [
        "-y",
        "-loglevel", "error",
        "-i", inputPath,
        "-map", "0:a:0",
        ...(keepCover ? ["-map", "0:v?", "-c:v", "copy", "-id3v2_version", "3"] : ["-vn"]),
        "-map_metadata", "0",
        "-c:a", "libmp3lame",
        "-b:a", `${kbps}k`,
        "-ar", String(ar),
        "-ac", kbps <= 48 ? "1" : "2",
        "-f", "mp3",
        outputPath,
    ];

    const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "ignore"] });

    return new Promise((resolve) => {
        ffmpeg.on("error", () => resolve(1));
        ffmpeg.on("close", resolve);
    });
}

/**
 * Creates a compressed copy of an MP3 that fits under the given size.
 * @param {string} inputPath
 * @param {number} maxSizeMB
 * @param {number} [durationMS] Track duration, used to pick the bitrate. Estimated from file size if missing.
 * @returns {Promise<{ path: string, bitrateKbps: number, sizeMB: number } | null>} null if it can't fit
 */
async function compressAudioFile(inputPath, maxSizeMB, durationMS) {
    activeDownloadOperations++;
    try {
        const inputSize = fs.statSync(inputPath).size;
        const maxBytes = maxSizeMB * 1024 * 1024;
        const targetBytes = maxBytes * COMPRESS_SAFETY_RATIO;

        const durationSec = durationMS > 0
            ? durationMS / 1000
            : (inputSize * 8) / (ORIGINAL_BITRATE_KBPS * 1000);

        const kbpsForBudget = (bytes) => (bytes * 8) / durationSec / 1000;
        const lowestKbps = MP3_BITRATE_STEPS[MP3_BITRATE_STEPS.length - 1].kbps;

        // Whatever isn't audio (mostly cover art + tags) still has to fit in the budget
        const overheadBytes = Math.max(0, inputSize - (ORIGINAL_BITRATE_KBPS * 1000 / 8) * durationSec);
        let keepCover = true;
        let targetKbps = kbpsForBudget(targetBytes - overheadBytes);

        // Cover art doesn't leave room for any usable bitrate, drop it
        if (targetKbps < lowestKbps) {
            keepCover = false;
            targetKbps = kbpsForBudget(targetBytes);
        }

        let stepIndex = MP3_BITRATE_STEPS.findIndex((s) => s.kbps <= targetKbps);
        if (stepIndex === -1) return null; // Too long to fit even at the lowest bitrate

        const { dir, name } = path.parse(inputPath);

        for (let attempt = 0; attempt < MAX_COMPRESS_ATTEMPTS && stepIndex < MP3_BITRATE_STEPS.length; attempt++) {
            const step = MP3_BITRATE_STEPS[stepIndex];
            const outputPath = path.join(dir, `${name} (compressed ${step.kbps}kbps).mp3`);

            if (!fs.existsSync(outputPath)) {
                console.log(`[COMPRESS] ${name} → ${step.kbps}kbps${keepCover ? "" : " (no cover)"}`);
                const code = await reencodeMp3(inputPath, outputPath, step, keepCover);

                if (code !== 0) {
                    fs.rmSync(outputPath, { force: true });
                    return null;
                }
            }

            const size = fs.statSync(outputPath).size;
            if (size < maxBytes)
                return { path: outputPath, bitrateKbps: step.kbps, sizeMB: size / (1024 * 1024) };

            fs.rmSync(outputPath, { force: true });

            // First drop the cover art, then go down a bitrate step
            if (keepCover) keepCover = false;
            else stepIndex++;
        }

        return null;
    } finally {
        activeDownloadOperations = Math.max(0, activeDownloadOperations - 1);
    }
}

module.exports = { downloadTrack, downloadViaStream, compressAudioFile, ensureDir, isDownloadOperationOngoing };

