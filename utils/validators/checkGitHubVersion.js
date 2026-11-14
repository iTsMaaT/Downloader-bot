const logger = require("@utils/log");
const { version, repository } = require("@root/package.json");

/**
 * Check if the application version is up to date between github and package.json
 * @returns {void}
 */
const checkGitHubVersion = async function() {
    const githubVersion = await fetchGitHubVersion();
    if (!githubVersion) return;

    logger.debug(`Current version is ${version}`);

    const parse = v => v.split(/[-+]/)[0].split(".").map(n => parseInt(n, 10) || 0);
    const isNewer = (a, b) => {
        const pa = parse(a), pb = parse(b);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const diff = (pa[i] || 0) - (pb[i] || 0);
            if (diff !== 0) return diff > 0;
        }
        return false;
    };

    // A local version higher than GitHub's means it's awaiting a push
    if (isNewer(githubVersion, version)) {
        logger.warning(`New version available: ${githubVersion}`);
        logger.warning(`You are currently using version: ${version}`);
        if (githubVersion.split(".")[0] !== version.split(".")[0]) logger.severe("Major version mismatch");
        logger.warning("Please consider updating the application with 'git pull'.");
    }

    logger.info("Successfully checked application version.");
};

/**
 * Gets the version from the package.json of the GitHub repository set in package.json.
 * Never throws: if the repo can't be found or read, the check is skipped.
 * @returns {Promise<string | null>}
 */
async function fetchGitHubVersion() {
    const skip = (reason) => {
        logger.warning(`${reason} Skipping version check.`);
        return null;
    };

    const repoUrl = typeof repository === "string" ? repository : repository?.url;
    if (!repoUrl)
        return skip("No GitHub repository set in package.json.");

    // Supports "https://github.com/owner/repo(.git)", "git+https://...", "git@github.com:owner/repo.git" and "owner/repo"
    const match = repoUrl.match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
    if (!match)
        return skip(`Couldn't read the GitHub repository from "${repoUrl}".`);

    const repoIdentifier = `${match[1]}/${match[2]}`;
    logger.debug(`Checking application version compared to GitHub (${repoIdentifier})...`);

    try {
        const response = await fetch(`https://api.github.com/repos/${repoIdentifier}/contents/package.json`, {
            signal: AbortSignal.timeout(10_000),
        });

        if (response.status === 404)
            return skip(`GitHub repository ${repoIdentifier} not found (or it is private).`);

        if (!response.ok)
            return skip(`GitHub API returned ${response.status} for ${repoIdentifier}.`);

        const result = await response.json();
        const githubVersion = JSON.parse(Buffer.from(result.content, "base64").toString("utf-8")).version;

        if (typeof githubVersion !== "string")
            return skip(`No version found in the package.json of ${repoIdentifier}.`);

        return githubVersion;
    } catch (error) {
        return skip(`Couldn't check the version on GitHub (${error.message}).`);
    }
}

module.exports = { execute: checkGitHubVersion };