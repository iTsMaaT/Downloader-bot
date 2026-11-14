const crypto = require("node:crypto");
const { PassThrough, Readable } = require("node:stream");
const { JSDecryptor } = require("discord-player-deezer");

/**
 * Replacement for discord-player-deezer@2.6.0's streamTrack.
 *
 * The upstream version has two bugs:
 *  - its PassThrough is never ended (and the last <2048 bytes are never flushed),
 *    so consumers like ffmpeg wait for EOF forever and the download hangs;
 *  - its "readable" handler is async, so overlapping events can write chunks out of order.
 *
 * This version reads the body sequentially, flushes the tail, ends the stream,
 * forwards errors, and throws readable errors when Deezer refuses a request.
 */

const IV = Buffer.from(Array.from({ length: 8 }, (_, x) => x));
const CHUNK_SIZE = 2048;
const BROWSER_UA = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";

function extractTrackId(url) {
    const match = /deezer\.com\/(?:[a-zA-Z-]+\/)?track\/(\d+)/.exec(String(url || ""));
    if (!match) throw new Error(`Not a Deezer track URL: ${url}`);
    return match[1];
}

function buildTrackKey(trackId, decryptionKey) {
    const hash = crypto.createHash("md5").update(trackId, "ascii").digest("hex");
    const key = Buffer.alloc(16);

    for (let i = 0; i < 16; i++)
        key.writeInt8(hash.charCodeAt(i) ^ hash.charCodeAt(i + 16) ^ decryptionKey.charCodeAt(i), i);

    return key;
}

function describeDeezerError(payload) {
    const errors = payload?.errors ?? payload?.error ?? payload?.data?.[0]?.errors;
    if (!errors) return "unexpected response";
    return typeof errors === "string" ? errors : JSON.stringify(errors);
}

async function getMediaUrl(ext, trackId) {
    if (!ext.userInfo)
        throw new Error("Deezer user info not loaded (is the ARL cookie valid?)");

    const infoRes = await ext.fetch(
        `https://www.deezer.com/ajax/gw-light.php?method=song.getListData&input=3&api_version=1.0&api_token=${ext.userInfo.csrfToken}`,
        {
            method: "POST",
            headers: {
                Cookie: `${ext.userInfo.cookie}; arl=${ext.options.arl}`,
                "User-Agent": BROWSER_UA,
                DNT: "1",
            },
            body: JSON.stringify({ sng_ids: [trackId] }),
        },
    );
    const info = await infoRes.json();
    const songInfo = info?.results?.data?.[0];

    if (!songInfo?.TRACK_TOKEN)
        throw new Error(`Deezer song info unavailable: ${describeDeezerError(info)}`);

    const streamRes = await fetch("https://media.deezer.com/v1/get_url", {
        method: "POST",
        body: JSON.stringify({
            license_token: ext.userInfo.licenseToken,
            media: [{
                type: "FULL",
                formats: ["FLAC", "MP3_256", "MP3_128", "MP3_MISC"].map((format) => ({ cipher: "BF_CBC_STRIPE", format })),
            }],
            track_tokens: [songInfo.TRACK_TOKEN],
        }),
    });
    const streamInfo = await streamRes.json();
    const url = streamInfo?.data?.[0]?.media?.[0]?.sources?.[0]?.url;

    if (!url)
        throw new Error(`Deezer refused the stream (account/region restriction?): ${describeDeezerError(streamInfo)}`);

    return url;
}

async function streamDeezerTrack(track, ext) {
    const decryptionKey = ext.options.decryptionKey;
    if (!decryptionKey) throw new Error("MISSING DEEZER DECRYPTION KEY");

    const trackId = extractTrackId(track.url);
    const Decryptor = ext.options.decryptor || JSDecryptor;
    const decryptor = new Decryptor(buildTrackKey(trackId, decryptionKey), IV);

    const mediaUrl = await getMediaUrl(ext, trackId);
    ext.context?.player?.debug?.(`DEEZER FOUND MEDIA URL ${mediaUrl}`);

    const mediaRes = await ext.fetch(mediaUrl);
    if (!mediaRes.ok || !mediaRes.body)
        throw new Error(`Deezer media request failed (HTTP ${mediaRes.status})`);

    const body = Readable.fromWeb(mediaRes.body);
    const output = new PassThrough();

    (async () => {
        let buffer = Buffer.alloc(0);
        let index = 0;

        const writeChunk = async (chunk) => {
            const data = index % 3 === 0 && chunk.length === CHUNK_SIZE
                ? await decryptor.decrypt(chunk)
                : chunk;
            index++;

            if (!output.write(data))
                await new Promise((resolve) => output.once("drain", resolve));
        };

        try {
            for await (const piece of body) {
                if (output.destroyed) break;
                buffer = buffer.length ? Buffer.concat([buffer, piece]) : piece;

                while (buffer.length >= CHUNK_SIZE) {
                    await writeChunk(buffer.subarray(0, CHUNK_SIZE));
                    buffer = buffer.subarray(CHUNK_SIZE);
                }
            }

            // Trailing partial chunk is never encrypted in BF_CBC_STRIPE
            if (buffer.length && !output.destroyed)
                await writeChunk(buffer);

            output.end();
        } catch (err) {
            output.destroy(err);
        }
    })();

    // Stop downloading if the consumer goes away
    output.once("close", () => body.destroy());

    return output;
}

/**
 * Swap the registered Deezer extractor's stream() for the fixed implementation.
 * @param {import("discord-player").BaseExtractor} deezerExt
 */
function patchDeezerExtractor(deezerExt) {
    deezerExt.stream = (track) => streamDeezerTrack(track, deezerExt);

    // bridge() calls this.stream(), so it picks up the fix automatically
    return deezerExt;
}

module.exports = { streamDeezerTrack, patchDeezerExtractor };
