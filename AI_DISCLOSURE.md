# AI Disclosure

This project is based on [WD-40](https://github.com/iTsMaaT/WD-40): its command and event loader, logger, config system, guild manager, owner commands and music player extractors (YouTube, Deezer, Spotify, etc.).

Most of the code built on top of it was written with AI assistance (Claude Code). It was heavily "vibe coded": features were described in plain language and the AI wrote the code. After each change, the code was inspected manually.

Parts written mostly with AI assistance include:

- The `/download` command: multi-source search, track picker and upload size checks (`commands/slash/utils/downloader/download.js`, `utils/helpers/player/downloadHelpers.js`)
- Compressing files that are too big for Discord's upload limit (`utils/helpers/player/downloader.js`)
- Deezer streaming (`utils/helpers/player/deezerStream.js`)
- The daily downloads cleanup (`utils/helpers/player/downloadsCleanupScheduler.js`)

If you find a bug or something that looks off, please open an issue.
