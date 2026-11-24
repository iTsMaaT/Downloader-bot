const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

/**
 * SQLite database (better-sqlite3, synchronous API).
 * The file lives at DATABASE_PATH, or ./data/bot.db by default.
 *
 * Schema changes go in MIGRATIONS: append a new entry, never edit an existing one.
 * The index of the last applied migration is tracked in PRAGMA user_version.
 */

const DB_PATH = path.resolve(process.env.DATABASE_PATH || "./data/bot.db");

const MIGRATIONS = [
    // 1: Google Drive links + upload history
    `
    CREATE TABLE drive_links (
        user_id       TEXT PRIMARY KEY,
        refresh_token TEXT NOT NULL,          -- AES-256-GCM encrypted, see utils/helpers/googleDrive.js
        email         TEXT,
        linked_at     INTEGER NOT NULL,
        last_used_at  INTEGER
    );

    CREATE TABLE drive_uploads (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     TEXT NOT NULL REFERENCES drive_links(user_id) ON DELETE CASCADE,
        file_id     TEXT NOT NULL,
        name        TEXT NOT NULL,
        size_bytes  INTEGER NOT NULL DEFAULT 0,
        kind        TEXT NOT NULL CHECK (kind IN ('track', 'playlist')),
        track_count INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL
    );

    CREATE INDEX idx_drive_uploads_user ON drive_uploads (user_id, created_at);
    `,
    // 2: Per-user preferences (/drive settings). Not tied to drive_links, so unlinking keeps them.
    `
    CREATE TABLE user_settings (
        user_id     TEXT PRIMARY KEY,
        destination TEXT NOT NULL DEFAULT 'ask' CHECK (destination IN ('ask', 'drive', 'discord')),
        format      TEXT,                     -- NULL = default, see utils/helpers/player/audioFormats.js
        quality     TEXT,
        updated_at  INTEGER NOT NULL
    );
    `,
];

/** @type {import("better-sqlite3").Database | null} */
let db = null;

function migrate(database) {
    const currentVersion = database.pragma("user_version", { simple: true });

    for (let version = currentVersion; version < MIGRATIONS.length; version++) {
        database.transaction(() => {
            database.exec(MIGRATIONS[version]);
            database.pragma(`user_version = ${version + 1}`);
        })();
        console.log(`Database migrated to version ${version + 1}`);
    }
}

/**
 * Returns the shared database connection, opening and migrating it on first use.
 * @returns {import("better-sqlite3").Database}
 */
function getDb() {
    if (db)
        return db;

    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrate(db);

    return db;
}

function closeDb() {
    db?.close();
    db = null;
}

module.exports = { getDb, closeDb, DB_PATH };
