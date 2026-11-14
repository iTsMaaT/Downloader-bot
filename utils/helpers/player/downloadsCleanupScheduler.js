const cron = require("cron");
const fs = require("node:fs");
const path = require("node:path");
const config = require("@utils/config/configUtils");
const { isDownloadOperationOngoing } = require("@utils/helpers/player/downloader");

const DOWNLOAD_ROOT = path.resolve("./downloads");
const RETRY_DELAY_MS = 10 * 60 * 1000;
const SCHEDULE = "0 3 * * *";

let retryTimeout = null;

function ensureDownloadRoot() {
    if (!fs.existsSync(DOWNLOAD_ROOT))
        fs.mkdirSync(DOWNLOAD_ROOT, { recursive: true });
}

function deleteAllDownloads(logger) {
    try {
        fs.rmSync(DOWNLOAD_ROOT, { recursive: true, force: true });
        ensureDownloadRoot();
        logger.info("Daily cleanup: downloads folder cleared.");
    } catch (error) {
        logger.error(`Daily cleanup failed: ${error.message}`);
    }
}

async function runDownloadsCleanup(logger) {
    if (isDownloadOperationOngoing()) {
        logger.info("Daily cleanup skipped: download in progress, retrying in 10 minutes.");
        scheduleRetry(logger);
        return;
    }

    deleteAllDownloads(logger);
}

function scheduleRetry(logger) {
    if (retryTimeout)
        return;

    retryTimeout = setTimeout(async () => {
        retryTimeout = null;
        await runDownloadsCleanup(logger);
    }, RETRY_DELAY_MS);
}

function startDailyDownloadsCleanup(logger) {
    ensureDownloadRoot();

    const cleanupJob = new cron.CronJob(
        SCHEDULE,
        async () => {
            await runDownloadsCleanup(logger);
        },
        null,
        true,
        config.get("timeZone"),
    );

    logger.info("Daily downloads cleanup scheduled at 03:00.");

    return cleanupJob;
}

module.exports = {
    startDailyDownloadsCleanup,
};
