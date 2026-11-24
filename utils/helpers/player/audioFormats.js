/**
 * Output formats and quality levels for downloads.
 *
 * A "profile" is a format + quality pair resolved to everything the downloader needs:
 * ffmpeg encoder args, file extension, whether cover art can be embedded, and a bitrate
 * used to estimate the file size before downloading.
 *
 * Note: sources are usually lossy (YouTube ~128-160 kbps Opus, SoundCloud 128 kbps MP3),
 * so a higher quality or FLAC can't add detail that isn't in the source, it only avoids losing more.
 */

const QUALITIES = ["low", "medium", "high"];

const FORMATS = {
    mp3: {
        label: "MP3",
        extension: ".mp3",
        muxer: "mp3",
        sampleRate: 44100,
        bitrates: { low: 128, medium: 192, high: 320 },
        encoderArgs: (kbps) => ["-c:a", "libmp3lame", "-b:a", `${kbps}k`],
        coverArgs: ["-c:v", "mjpeg", "-id3v2_version", "3", "-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)"],
    },
    m4a: {
        label: "M4A (AAC)",
        extension: ".m4a",
        muxer: "ipod",
        sampleRate: 44100,
        bitrates: { low: 128, medium: 192, high: 256 },
        encoderArgs: (kbps) => ["-c:a", "aac", "-b:a", `${kbps}k`, "-movflags", "+faststart"],
        coverArgs: ["-c:v", "mjpeg", "-disposition:v", "attached_pic"],
    },
    opus: {
        label: "Opus",
        extension: ".opus",
        muxer: "ogg",
        sampleRate: 48000, // The only full-band rate libopus accepts
        bitrates: { low: 96, medium: 128, high: 192 },
        encoderArgs: (kbps) => ["-c:a", "libopus", "-b:a", `${kbps}k`],
        coverArgs: null, // Ogg cover art needs a METADATA_BLOCK_PICTURE tag, ffmpeg can't mux it from an image stream
    },
    flac: {
        label: "FLAC (lossless)",
        extension: ".flac",
        muxer: "flac",
        sampleRate: null, // Keep the source rate
        bitrates: null, // Lossless, quality doesn't apply
        estimateKbps: 900,
        encoderArgs: () => ["-c:a", "flac", "-compression_level", "8"],
        coverArgs: ["-c:v", "mjpeg", "-disposition:v", "attached_pic"],
    },
};

const DEFAULT_FORMAT = "mp3";
const DEFAULT_QUALITY = "medium";

/** Choices for slash command options */
const FORMAT_CHOICES = Object.entries(FORMATS).map(([value, format]) => ({ name: format.label, value }));
const QUALITY_CHOICES = [
    { name: "Low (smaller file)", value: "low" },
    { name: "Medium", value: "medium" },
    { name: "High", value: "high" },
];

/**
 * @typedef {object} AudioProfile
 * @property {string} format Key in FORMATS
 * @property {string} quality low | medium | high
 * @property {string} extension
 * @property {string} muxer ffmpeg -f value
 * @property {number | null} sampleRate
 * @property {number | null} kbps Encoder bitrate, null for lossless
 * @property {number} estimateKbps Average bitrate, used for size estimates
 * @property {string[]} encoderArgs
 * @property {string[] | null} coverArgs null when the format can't embed cover art
 * @property {string} label e.g. "MP3 · 320 kbps"
 * @property {string} key Unique id, used for the cache folder
 * @property {boolean} isDefault
 */

/**
 * Resolves a format + quality to a profile. Unknown values fall back to the defaults.
 * @param {string | null} [format]
 * @param {string | null} [quality]
 * @returns {AudioProfile}
 */
function resolveProfile(format, quality) {
    const formatKey = FORMATS[format] ? format : DEFAULT_FORMAT;
    const def = FORMATS[formatKey];
    const qualityKey = QUALITIES.includes(quality) ? quality : DEFAULT_QUALITY;
    const kbps = def.bitrates ? def.bitrates[qualityKey] : null;

    return {
        format: formatKey,
        quality: def.bitrates ? qualityKey : "lossless",
        extension: def.extension,
        muxer: def.muxer,
        sampleRate: def.sampleRate,
        kbps,
        estimateKbps: kbps ?? def.estimateKbps,
        encoderArgs: def.encoderArgs(kbps),
        coverArgs: def.coverArgs,
        label: kbps ? `${def.label} · ${kbps} kbps` : def.label,
        key: def.bitrates ? `${formatKey}-${qualityKey}` : formatKey,
        isDefault: formatKey === DEFAULT_FORMAT && qualityKey === DEFAULT_QUALITY,
    };
}

module.exports = {
    FORMATS,
    QUALITIES,
    DEFAULT_FORMAT,
    DEFAULT_QUALITY,
    FORMAT_CHOICES,
    QUALITY_CHOICES,
    resolveProfile,
};
