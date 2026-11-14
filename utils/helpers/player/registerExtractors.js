const { Player, AudioFilters, onBeforeCreateStream } = require("discord-player");
const { AttachmentExtractor } = require("@discord-player/extractor");
const { YoutubeExtractor } = require("discord-player-youtubei");
const { DeezerExtractor, NodeDecryptor, JSDecryptor } = require("discord-player-deezer");
const { patchDeezerExtractor } = require("@root/utils/helpers/player/deezerStream");
const { SoundgasmExtractor } = require("discord-player-soundgasm");
const { SoundcloudExtractor } = require("discord-player-soundcloud");
const { SpotifyExtractor } = require("discord-player-spotify");
const { AppleMusicExtractor } = require("discord-player-applemusic");
const { SubsonicExtractor } = require("discord-player-subsonic");
const { YoutubeSabrExtractor } = require("@utils/helpers/youtubei/youtubeiExtractor.js");
const { startInterceptor } = require("@utils/helpers/player/interceptor");
const youtubeCookieHandler = require("@utils/helpers/youtubeCookieHandler/youtubeCookieHandler");
const config = require("@utils/config/configUtils");
const logger = require("@utils/log");

const { Log } = require("youtubei.js");
Log.setLevel(Log.Level.NONE);

const discordPlayerConfig = config.get("discordPlayer");
const extractors = discordPlayerConfig?.extractors || {};

/**
 * Initializes a new Player instance
 * 
 * @param {Client} client 
 * @returns 
 */
async function initPlayer(client) {
    const player = new Player(client, {
        skipFFmpeg: discordPlayerConfig?.skipFFmpeg,
        ffmpegPath: discordPlayerConfig?.ffmpegPath,
    });
    if (discordPlayerConfig?.downloadStreams) startInterceptor(player);
    return player;
}

/**
 * Registers all extractors
 * 
 * @param {Player} player 
 * @returns 
 */
async function registerExtractors(player) {
    const ffmpegFilters = discordPlayerConfig?.ffmpegFilters || {};
    for (const filter of Object.entries(ffmpegFilters)) AudioFilters.define(filter[0], filter[1]);

    onBeforeCreateStream(async (track, queryType, queue) => {
        try {
            if (track.extractor.identifier === DeezerExtractor.identifier ||
                track.extractor.identifier === SoundcloudExtractor.identifier ||
                track.extractor.identifier === YoutubeSabrExtractor.identifier ||
                track.extractor.identifier === SubsonicExtractor.identifier ||
                track.extractor.identifier === AttachmentExtractor.identifier
            ) return await track.extractor?.stream(track);
            return undefined;
        } catch {
            return undefined;
        }
    });

    // const distubeExt = await player.extractors.register(distubePluginToExtractor(YouTubePlugin, { }));
    // distubeExt.priority = extractors.Youtubei.priority ?? distubeExt.priority;

    if (extractors.Subsonic.enabled) {
        const subsonicExt = await player.extractors.register(SubsonicExtractor, {
            username: process.env.SUBSONIC_USERNAME,
            password: process.env.SUBSONIC_PASSWORD,
            host: process.env.SUBSONIC_URL,
        });
        subsonicExt.priority = extractors.Subsonic.priority ?? subsonicExt.priority;
    }
    
    if (extractors.Soundgasm.enabled) {
        logger.info("Loading SoundgasmExtractor extractor...");
        const soundgasmExt = await player.extractors.register(SoundgasmExtractor, extractors.Soundgasm.config);
        soundgasmExt.priority = extractors.Soundgasm.priority ?? soundgasmExt.priority;
    }

    if (extractors.Soundcloud.enabled) {
        logger.info("Loading Soundcloud extractor...");
        const soundcloudExt = await player.extractors.register(SoundcloudExtractor, extractors.Soundcloud.config);
        soundcloudExt.priority = extractors.Soundcloud.priority ?? soundcloudExt.priority;
    }

    if (extractors.Youtubei.enabled || extractors.Youtubei.config.attemptYoutubeSearchEvenIfDisabled.useScraping) {
        logger.info("Loading YoutubeExtractor extractor...");
        try {
            const ytExt = await player.extractors.register(YoutubeExtractor, {
                ...getYoutubeExtractorOptions(extractors.Youtubei.config),
            });

            ytExt.priority = extractors.Youtubei.priority ? extractors.Youtubei.priority - 1 : ytExt.priority;
        } catch (e) {
            logger.error("Failed to register YoutubeExtractor:", e);
        }
    }

    if (extractors.Deezer.enabled) {
        logger.info("Loading Deezer extractor...");
        const deezerExt = await player.extractors.register(DeezerExtractor, getDeezerExtractorOptions(extractors.Deezer.config));
        deezerExt.priority = extractors.Deezer.priority ?? deezerExt.priority;
        patchDeezerExtractor(deezerExt); // upstream stream() never ends → downloads hang
    }

    if (extractors.Spotify.enabled) {
        logger.info("Loading SpotifyExtractor extractor...");
        const spotifyExt = await player.extractors.register(SpotifyExtractor, getSpotifyExtractorOptions(extractors.Spotify.config));
        spotifyExt.priority = extractors.Spotify.priority ?? spotifyExt.priority;
    }

    if (extractors.AppleMusic.enabled) {
        logger.info("Loading AppleMusicExtractor extractor...");
        const appleMusicExt = await player.extractors.register(AppleMusicExtractor, extractors.AppleMusic.config);
        appleMusicExt.priority = extractors.AppleMusic.priority ?? appleMusicExt.priority;
    }

    if (extractors.Attachment.enabled) {
        logger.info("Loading Attachment extractor...");
        const attachmentExt = await player.extractors.register(AttachmentExtractor, extractors.Attachment.config);
        attachmentExt.protocols = ["file"];
        attachmentExt.priority = extractors.Attachment.priority ?? attachmentExt.priority;
    }
}

/**
 * Reloads all extractors
 * 
 * @param {Player} player 
 * @returns
 */
async function reload(player) {
    await player.extractors.unregisterAll();
    await registerExtractors(player);
}

/**
 * Gets the Youtube extractor options
 * 
 * @param {object} playerconfig 
 * @returns 
 */
function getYoutubeExtractorOptions(playerconfig) {
    /** @type {import("discord-player-youtubei").YoutubeOptions} */
    const options = {};

    if (playerconfig?.useCookie) {
        const { cookiePath, cookieHeader } = youtubeCookieHandler.getYoutubeCookies();
        if (cookieHeader) options.cookie = cookieHeader;
        if (cookiePath) options.downloads = { ytdlp: { cookiePath } };
    }

    return options;
}

/**
 * Gets the Deezer extractor options
 * 
 * @param {object} playerconfig 
 * @returns 
 */
function getDeezerExtractorOptions(playerconfig) {
    const options = {
        // OpenSSL 3 (Node 17+) drops Blowfish unless the legacy provider is enabled
        decryptor: require("node:crypto").getCiphers().includes("bf-cbc") ? NodeDecryptor : JSDecryptor,
        reloadUserInterval: playerconfig?.reloadUserInterval || 32400000,
    };

    if (playerconfig?.useAccount) {
        options.arl = process.env.DEEZER_ARL_COOKIE;
        options.decryptionKey = process.env.DEEZER_MASTER_KEY;
    }

    return options;
}

/**
 * Gets the Spotify extractor options
 * 
 * @param {object} playerconfig 
 * @returns 
 */
function getSpotifyExtractorOptions(playerconfig) {
    const options = {};

    if (playerconfig?.useAccount) {
        options.clientId = process.env.SPOTIFY_CLIENT_ID;
        options.clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    }

    options.anon = {
        maxPagingQueries: playerconfig?.maxPagingQueries ?? 100,
    };

    return options;
}

function tokenToObject(token) {
    if (!token.includes("; ") || !token.includes("=")) {
        throw new Error(
            "Error: this is not a valid authentication token. Make sure you are putting the entire string instead of just what's behind access_token=",
        );
    }

    const kvPair = token.split("; ");

    const validKeys = [
        "access_token",
        "expiry_date",
        "expires_in",
        "refresh_token",
        "scope",
        "token_type",
        "client",
    ];
    const finalObject = {};
    for (const kv of kvPair) {
        const [key, value] = kv.split("=");
        if (!validKeys.includes(key)) continue;
        finalObject[key] = Number.isNaN(Number(value))
            ? value
            : Number(value);
    }

    // perform final checks
    const requiredKeys = ["access_token", "expiry_date", "refresh_token"];

    for (const key of requiredKeys) {
        if (!(key in finalObject)) {
            throw new Error(
                `Error: Invalid authentication keys. Missing the required key ${key}. Make sure you are putting the entire string instead of just what's behind access_token=`,
            );
        }
    }

    return finalObject;
}

module.exports = { initPlayer, registerExtractors, reload };