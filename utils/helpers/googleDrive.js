const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const axios = require("axios");
const config = require("@utils/config/configUtils");
const { getDb } = require("@utils/db/database");

/**
 * Google Drive integration: per-user OAuth (device flow) + uploads into a dedicated folder.
 *
 * Only the `drive.file` scope is requested, so the bot can only see/modify files it created itself.
 * Refresh tokens are stored encrypted (AES-256-GCM) in the drive_links table, keyed by Discord user ID.
 */

const REQUIRED_ENVS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_DRIVE_TOKEN_KEY"];

const OAUTH_DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const DRIVE_ABOUT_URL = "https://www.googleapis.com/drive/v3/about";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SCOPES = [DRIVE_FILE_SCOPE, "openid", "email"];
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DEFAULT_FOLDER_NAME = "Downloader Bot";

const ACCESS_TOKEN_SAFETY_MS = 60_000;

const MIME_TYPES = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".zip": "application/zip",
};

/** Thrown when the stored credentials are no longer usable (revoked/expired). The link is removed. */
class DriveAuthError extends Error {
    constructor(message) {
        super(message);
        this.name = "DriveAuthError";
    }
}

/**
 * Thrown by the login flow.
 * code: "cancelled" | "denied" | "expired" | "missing_scope" | "failed"
 */
class DriveLoginError extends Error {
    constructor(code, message) {
        super(message || code);
        this.name = "DriveLoginError";
        this.code = code;
    }
}

const accessTokens = new Map(); // userId -> { token, expiresAt }
const folderLookups = new Map(); // userId -> Promise<folder>, avoids creating duplicate folders on concurrent uploads

function isConfigured() {
    return REQUIRED_ENVS.every((name) => Boolean(process.env[name]));
}

function getFolderName() {
    return config.get("googleDrive")?.folderName || DEFAULT_FOLDER_NAME;
}

// ---------------------------------------------------------------------------
// Encrypted token storage (SQLite)
// ---------------------------------------------------------------------------

function getEncryptionKey() {
    return crypto.createHash("sha256").update(process.env.GOOGLE_DRIVE_TOKEN_KEY).digest();
}

function encrypt(plainText) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString("base64")).join(".");
}

function decrypt(payload) {
    const [iv, tag, encrypted] = payload.split(".").map((s) => Buffer.from(s, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

const db = getDb;

function getLinkRow(userId) {
    return db().prepare("SELECT * FROM drive_links WHERE user_id = ?").get(userId);
}

function removeLink(userId) {
    accessTokens.delete(userId);
    // Upload history goes with it (ON DELETE CASCADE)
    db().prepare("DELETE FROM drive_links WHERE user_id = ?").run(userId);
}

/**
 * @param {string} userId Discord user ID
 * @returns {{ email: string | null, linkedAt: number, lastUsedAt: number | null } | null}
 */
function getLink(userId) {
    if (!isConfigured())
        return null;

    const row = getLinkRow(userId);
    return row ? { email: row.email, linkedAt: row.linked_at, lastUsedAt: row.last_used_at } : null;
}

function isLinked(userId) {
    return getLink(userId) !== null;
}

function recordUpload(userId, file, { kind, trackCount }) {
    const now = Date.now();
    db().transaction(() => {
        db().prepare(`
            INSERT INTO drive_uploads (user_id, file_id, name, size_bytes, kind, track_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(userId, file.id, file.name, Number(file.size) || 0, kind, trackCount, now);
        db().prepare("UPDATE drive_links SET last_used_at = ? WHERE user_id = ?").run(now, userId);
    })();
}

/**
 * Upload history recorded since the account was linked.
 * @param {string} userId Discord user ID
 */
function getUploadStats(userId) {
    const totals = db().prepare(`
        SELECT
            COALESCE(SUM(CASE WHEN kind = 'track' THEN 1 ELSE 0 END), 0) AS tracks,
            COALESCE(SUM(CASE WHEN kind = 'playlist' THEN 1 ELSE 0 END), 0) AS playlists,
            COALESCE(SUM(CASE WHEN kind = 'playlist' THEN track_count ELSE 0 END), 0) AS playlistTracks,
            COALESCE(SUM(size_bytes), 0) AS totalBytes
        FROM drive_uploads WHERE user_id = ?
    `).get(userId);

    const last = db().prepare(`
        SELECT name, kind, created_at AS createdAt FROM drive_uploads
        WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(userId);

    return { ...totals, last: last ?? null };
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

function postForm(url, params) {
    return axios.post(url, new URLSearchParams(params), { validateStatus: () => true });
}

function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted)
            return resolve();

        const timeout = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timeout);
            resolve();
        }, { once: true });
    });
}

/**
 * Starts a device authorization request.
 * @returns {Promise<{ deviceCode: string, userCode: string, verificationUrl: string, expiresIn: number, interval: number }>}
 */
async function startDeviceLogin() {
    const res = await postForm(OAUTH_DEVICE_CODE_URL, {
        client_id: process.env.GOOGLE_CLIENT_ID,
        scope: SCOPES.join(" "),
    });

    if (res.status !== 200)
        throw new DriveLoginError("failed", `Google refused the login request: ${res.data?.error_description || res.data?.error || `HTTP ${res.status}`}`);

    return {
        deviceCode: res.data.device_code,
        userCode: res.data.user_code,
        verificationUrl: res.data.verification_url || res.data.verification_uri,
        expiresIn: res.data.expires_in,
        interval: res.data.interval || 5,
    };
}

/**
 * Polls Google until the user approves (or denies) the device login, then stores the refresh token.
 * @param {string} userId Discord user ID
 * @param {Awaited<ReturnType<typeof startDeviceLogin>>} device
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<{ email: string | null }>}
 */
async function pollDeviceLogin(userId, device, { signal, timeoutMs = Infinity } = {}) {
    let intervalMs = device.interval * 1000;
    const deadline = Date.now() + Math.min(device.expiresIn * 1000, timeoutMs);

    while (Date.now() < deadline) {
        await sleep(intervalMs, signal);
        if (signal?.aborted)
            throw new DriveLoginError("cancelled", "Login cancelled.");

        let res;
        try {
            res = await postForm(OAUTH_TOKEN_URL, {
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                device_code: device.deviceCode,
                grant_type: DEVICE_GRANT_TYPE,
            });
        } catch (error) {
            // Network hiccup, try again on the next tick
            console.warn(`Google Drive login poll failed: ${error.message}`);
            continue;
        }

        if (res.status === 200 && res.data?.access_token)
            return await completeLogin(userId, res.data);

        switch (res.data?.error) {
            case "authorization_pending":
                continue;
            case "slow_down":
                intervalMs += 5000;
                continue;
            case "access_denied":
                throw new DriveLoginError("denied", "Access was denied on the Google consent screen.");
            case "expired_token":
                throw new DriveLoginError("expired", "The login code expired.");
            default:
                throw new DriveLoginError("failed", res.data?.error_description || res.data?.error || `HTTP ${res.status}`);
        }
    }

    throw new DriveLoginError("expired", "The login code expired.");
}

async function completeLogin(userId, tokenData) {
    // With granular consent, users can untick the Drive permission
    const grantedScopes = String(tokenData.scope || "").split(" ");
    if (!grantedScopes.includes(DRIVE_FILE_SCOPE)) {
        await postForm(OAUTH_REVOKE_URL, { token: tokenData.refresh_token || tokenData.access_token }).catch(() => { /**/ });
        throw new DriveLoginError("missing_scope", "Google Drive access was not granted.");
    }

    if (!tokenData.refresh_token)
        throw new DriveLoginError("failed", "Google did not return a refresh token.");

    let email = null;
    try {
        const res = await axios.get(USERINFO_URL, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
        email = res.data?.email ?? null;
    } catch {
        // Email is only used for display
    }

    db().prepare(`
        INSERT INTO drive_links (user_id, refresh_token, email, linked_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET
            refresh_token = excluded.refresh_token,
            email = excluded.email,
            linked_at = excluded.linked_at
    `).run(userId, encrypt(tokenData.refresh_token), email, Date.now());

    accessTokens.set(userId, {
        token: tokenData.access_token,
        expiresAt: Date.now() + tokenData.expires_in * 1000,
    });

    return { email };
}

async function getAccessToken(userId) {
    const cached = accessTokens.get(userId);
    if (cached && cached.expiresAt - ACCESS_TOKEN_SAFETY_MS > Date.now())
        return cached.token;

    const row = getLinkRow(userId);
    if (!row)
        throw new DriveAuthError("Your Google Drive isn't linked.");

    let refreshToken;
    try {
        refreshToken = decrypt(row.refresh_token);
    } catch {
        removeLink(userId);
        throw new DriveAuthError("Stored Google credentials could not be decrypted.");
    }

    const res = await postForm(OAUTH_TOKEN_URL, {
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
    });

    if (res.status === 200 && res.data?.access_token) {
        accessTokens.set(userId, {
            token: res.data.access_token,
            expiresAt: Date.now() + res.data.expires_in * 1000,
        });
        return res.data.access_token;
    }

    if (res.data?.error === "invalid_grant") {
        removeLink(userId);
        throw new DriveAuthError("Google Drive access was revoked or has expired.");
    }

    throw new Error(`Couldn't refresh Google access: ${res.data?.error_description || res.data?.error || `HTTP ${res.status}`}`);
}

/**
 * Unlinks the user's Google Drive and revokes the token at Google.
 * @param {string} userId Discord user ID
 * @returns {Promise<{ wasLinked: boolean, revoked: boolean, email: string | null }>}
 */
async function unlink(userId) {
    const row = getLinkRow(userId);
    if (!row)
        return { wasLinked: false, revoked: false, email: null };

    removeLink(userId);

    let revoked = false;
    try {
        const res = await postForm(OAUTH_REVOKE_URL, { token: decrypt(row.refresh_token) });
        // invalid_token means it was already revoked on Google's side
        revoked = res.status === 200 || res.data?.error === "invalid_token";
    } catch {
        // Local link is gone either way
    }

    return { wasLinked: true, revoked, email: row.email };
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

function describeDriveError(error) {
    return error.response?.data?.error?.message || error.message;
}

function escapeQueryValue(value) {
    return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findFolder(token) {
    // drive.file only lists folders this app created, so a name match is our folder
    const res = await axios.get(DRIVE_FILES_URL, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
            q: `mimeType='${FOLDER_MIME}' and name='${escapeQueryValue(getFolderName())}' and trashed=false`,
            fields: "files(id,webViewLink)",
            pageSize: 1,
            spaces: "drive",
        },
    });

    return res.data.files?.[0] ?? null;
}

async function findOrCreateFolder(token) {
    const existing = await findFolder(token);
    if (existing)
        return existing;

    const created = await axios.post(DRIVE_FILES_URL, { name: getFolderName(), mimeType: FOLDER_MIME }, {
        headers: { Authorization: `Bearer ${token}` },
        params: { fields: "id,webViewLink" },
    });
    return created.data;
}

function getFolder(userId, token) {
    if (!folderLookups.has(userId)) {
        const lookup = findOrCreateFolder(token).finally(() => folderLookups.delete(userId));
        folderLookups.set(userId, lookup);
    }

    return folderLookups.get(userId);
}

/**
 * Uploads a local file into the user's download folder on Google Drive.
 * @param {string} userId Discord user ID
 * @param {string} filePath Local file path
 * @param {{ name?: string, mimeType?: string, kind?: "track" | "playlist", trackCount?: number }} [options]
 * @returns {Promise<{ id: string, name: string, size: string, webViewLink: string, folderLink: string }>}
 */
async function uploadFile(userId, filePath, { name, mimeType, kind = "track", trackCount = 1 } = {}) {
    const token = await getAccessToken(userId);

    let file;
    try {
        const folder = await getFolder(userId, token);
        const { size } = await fs.promises.stat(filePath);
        const contentType = mimeType || MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
        const headers = { Authorization: `Bearer ${token}` };

        // Resumable upload: works for any size and streams from disk
        const session = await axios.post(DRIVE_UPLOAD_URL, {
            name: name || path.basename(filePath),
            parents: [folder.id],
        }, {
            headers: {
                ...headers,
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Type": contentType,
                "X-Upload-Content-Length": size,
            },
            params: { uploadType: "resumable", fields: "id,name,size,webViewLink" },
        });

        const uploaded = await axios.put(session.headers.location, fs.createReadStream(filePath), {
            headers: { ...headers, "Content-Type": contentType, "Content-Length": size },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
        });

        file = { ...uploaded.data, folderLink: folder.webViewLink };
    } catch (error) {
        if (error.response?.status === 401) {
            accessTokens.delete(userId);
            throw new Error("Google rejected the access token, please try again.", { cause: error });
        }

        throw new Error(describeDriveError(error), { cause: error });
    }

    try {
        recordUpload(userId, file, { kind, trackCount });
    } catch (error) {
        // The file is in Drive, missing history shouldn't fail the download
        console.error(`Couldn't record Google Drive upload: ${error.message}`);
    }

    return file;
}

/**
 * Collects everything /drive status shows. Also verifies the link still works.
 * @param {string} userId Discord user ID
 * @returns {Promise<null | {
 *   email: string | null, linkedAt: number, lastUsedAt: number | null,
 *   connection: "ok" | "revoked" | "error", error?: string,
 *   quota: { usage: number, limit: number | null } | null,
 *   folderLink: string | null,
 *   stats: ReturnType<typeof getUploadStats>,
 * }>} null if not linked
 */
async function getStatus(userId) {
    const link = getLink(userId);
    if (!link)
        return null;

    const status = { ...link, connection: "ok", quota: null, folderLink: null, stats: getUploadStats(userId) };

    let token;
    try {
        token = await getAccessToken(userId);
    } catch (error) {
        status.connection = error instanceof DriveAuthError ? "revoked" : "error";
        status.error = error.message;
        return status;
    }

    const headers = { Authorization: `Bearer ${token}` };
    const [about, folder] = await Promise.allSettled([
        axios.get(DRIVE_ABOUT_URL, { headers, params: { fields: "storageQuota(limit,usage)" } }),
        findFolder(token),
    ]);

    if (about.status === "fulfilled") {
        const quota = about.value.data.storageQuota ?? {};
        status.quota = {
            usage: Number(quota.usage) || 0,
            // No limit = unlimited storage (some Workspace plans)
            limit: quota.limit ? Number(quota.limit) : null,
        };
    }

    if (folder.status === "fulfilled")
        status.folderLink = folder.value?.webViewLink ?? null;

    return status;
}

module.exports = {
    REQUIRED_ENVS,
    DriveAuthError,
    DriveLoginError,
    isConfigured,
    getFolderName,
    getLink,
    isLinked,
    startDeviceLogin,
    pollDeviceLogin,
    unlink,
    uploadFile,
    getStatus,
};
