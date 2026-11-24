const { Constants, YTNodes } = require("youtubei.js");
const { EnabledTrackTypes, buildSabrFormat, Logger, LogLevel } = require("googlevideo/utils");
const { SabrStream } = require("googlevideo/sabr-stream");
const { getWebPoMinter, invalidateWebPoMinter, generateDataSyncTokens } = require("./poTokenGenerator.js");
const { getInnertube } = require("./getInnertube.js");
const { toNodeReadable } = require("./youtubeSharedUtils.js");

const DEFAULT_OPTIONS = {
    audioQuality: "AUDIO_QUALITY_MEDIUM",
    enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
    // The default (10) waits ~55s with backoff before giving up, mostly on a request past the end of the track
    maxRetries: 3,
};

// How much audio can be missing at the end for a failed stream to still count as complete
const COMPLETE_TOLERANCE_MS = 1500;

/**
 * Sums the duration of the segments downloaded for a format and reads its expected duration.
 * @param {{ formatInitializationMetadata: any, downloadedSegments: Map<any, { durationMs?: string }> }} format
 * @returns {{ downloadedMs: number, expectedMs: number }}
 */
function getFormatProgress(format) {
    const meta = format.formatInitializationMetadata ?? {};
    const units = parseInt(meta.durationUnits || "0");
    const timescale = parseInt(meta.durationTimescale || "0");
    const expectedMs = timescale ? Math.trunc(units / (timescale / 1000)) : 0;
    let downloadedMs = 0;
    for (const segment of format.downloadedSegments.values())
        downloadedMs += parseInt(segment.durationMs || "0");
    return { downloadedMs, expectedMs };
}


/**
 * Creates a SABR stream for a given video ID
 * 
 * @param {string} videoId - The video ID
 * @returns {Promise<Readable>} The SABR stream
 */
async function createSabrStream(videoId, cookies, logSabrEvents = false) {
    // googlevideo logs every retry and the final failure itself; failures that matter are logged below instead
    Logger.getInstance().setLogLevels(logSabrEvents ? LogLevel.ALL : LogLevel.NONE);

    const innertube = await getInnertube(cookies);
    let accountInfo;

    // === Mint initial PO token ===
    try {
        accountInfo = await innertube.account.getInfo();
    } catch (e) {   
        accountInfo = null;
    }
    const dataSyncId = accountInfo?.contents?.contents[0]?.endpoint?.payload?.supportedTokens?.[2]?.datasyncIdToken?.datasyncIdToken ?? innertube.session.context.client.visitorData;
    const minter = await getWebPoMinter(innertube);
    const contentPoToken = await minter.mint(videoId);
    const poToken = await minter.mint(dataSyncId);

    // === Player request ===
    const watchEndpoint = new YTNodes.NavigationEndpoint({ watchEndpoint: { videoId } });
    const playerResponse = await watchEndpoint.call(innertube.actions, {
        playbackContext: {
            // adPlaybackContext: { pyv: true },
            contentPlaybackContext: {
                vis: 0,
                splay: false,
                lactMilliseconds: "-1",
                signatureTimestamp: innertube.session.player?.signature_timestamp,
            },
        },
        contentCheckOk: true,
        racyCheckOk: true,
        serviceIntegrityDimensions: { poToken: poToken },
        parse: true,
    });

    const serverAbrStreamingUrl = await innertube.session.player?.decipher(
        playerResponse.streaming_data?.server_abr_streaming_url,
    );
    const videoPlaybackUstreamerConfig =
    playerResponse.player_config?.media_common_config
        .media_ustreamer_request_config?.video_playback_ustreamer_config;

    if (!videoPlaybackUstreamerConfig) throw new Error("ustreamerConfig not found");
    if (!serverAbrStreamingUrl) throw new Error("serverAbrStreamingUrl not found");

    const sabrFormats = playerResponse.streaming_data?.adaptive_formats.map(buildSabrFormat).filter(f => f.isOriginal ?? true) || [];

    const serverAbrStream = new SabrStream({
        formats: sabrFormats,
        serverAbrStreamingUrl,
        videoPlaybackUstreamerConfig,
        poToken: contentPoToken,
        clientInfo: {
            clientName: parseInt(Constants.CLIENT_NAME_IDS[innertube.session.context.client.clientName]),
            clientVersion: innertube.session.context.client.clientVersion,
        },
    });

    // SabrStream clears its format state before reporting an error, so keep our own references
    const audioFormats = [];
    serverAbrStream.on("formatInitialization", (format) => {
        if (format.formatInitializationMetadata?.mimeType?.includes("audio")) audioFormats.push(format);
    });
    const isComplete = () => audioFormats.some((format) => {
        const { downloadedMs, expectedMs } = getFormatProgress(format);
        return expectedMs > 0 && downloadedMs >= expectedMs - COMPLETE_TOLERANCE_MS;
    });

    // === Stream protection handling ===
    let protectionFailureCount = 0;
    let lastStatus = null;
    serverAbrStream.on("streamProtectionStatusUpdate", async (statusUpdate) => {
        if (statusUpdate.status !== lastStatus) {
            if (logSabrEvents) console.log("Stream Protection Status Update:", statusUpdate);
            lastStatus = statusUpdate.status;
        }
        if (statusUpdate.status === 2) {
            protectionFailureCount = Math.min(protectionFailureCount + 1, 10);
            if (protectionFailureCount === 1 || protectionFailureCount % 5 === 0) 
                if (logSabrEvents) console.log(`Rotating PO token... (attempt ${protectionFailureCount})`);
        
            try {
                const rotationMinter = await getWebPoMinter(innertube, { forceRefresh: protectionFailureCount >= 3 });
                const placeholderToken = rotationMinter.generatePlaceholder(videoId);
                serverAbrStream.setPoToken(placeholderToken);
                const mintedPoToken = await rotationMinter.mint(videoId);
                serverAbrStream.setPoToken(mintedPoToken);
            } catch (err) {
                if (protectionFailureCount === 1 || protectionFailureCount % 5 === 0) 
                    if (logSabrEvents) console.error("Failed to rotate PO token:", err);
            
            }
        } else if (statusUpdate.status === 3) {
            if (logSabrEvents) console.error("Stream protection rejected token (SPS 3). Resetting Botguard.");
            invalidateWebPoMinter();
        } else {
            protectionFailureCount = 0;
        }
    });

    // === Start SABR stream ===
    const { audioStream } = await serverAbrStream.start(DEFAULT_OPTIONS);
    const nodeStream = toNodeReadable(audioStream, {
        isComplete,
        onIgnoredError: (err) => {
            if (logSabrEvents) console.log(`[SABR] ${videoId}: ignored error after the full track was received (${err.message})`);
        },
    });
    nodeStream.on("error", (err) => {
        const progress = audioFormats.map(getFormatProgress).map(p => `${p.downloadedMs}/${p.expectedMs}ms`).join(", ") || "no audio received";
        console.error(`[SABR] ${videoId}: stream failed before the end (${progress}): ${err.message}`);
    });

    return nodeStream;
}

module.exports = {
    createSabrStream,
};
