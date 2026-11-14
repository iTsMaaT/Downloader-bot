<h1 align="center">
    <br>
    Downloader Bot
    <br><br>
</h1>

<p align="center">
    A Discord bot that searches for songs and sends them to you as MP3 files.
    <br>
    Based on <a href="https://github.com/iTsMaaT/WD-40">WD-40</a>.
</p>

<br>

## Table of Contents

- [Features](#features)
- [Usage](#usage)
- [Commands](#commands)
- [Self-hosting](#self-hosting)
- [Configuration](#configuration)
- [Known issues](#known-issues)
- [Credits](#credits)

[![JavaScript][JavaScript-Badge]][JavaScript-Url]

# Features

- Download songs as MP3 files (192 kbps, with title, artist, album and cover art tags)
- Search by name or paste a link from YouTube, SoundCloud, Deezer, Spotify, Apple Music and more
- Pick the source and the exact track from a list when searching by name
- Spotify and Apple Music links are matched to a source that can be downloaded
- Files too big for the server's upload limit can be sent as a compressed version instead
- Downloaded files are cached and cleared every day at 3 AM

# Usage

Run `/download` with a song name or a link:

```
/download query: never gonna give you up
/download query: https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

- **With a link** from a source that can be streamed (YouTube, SoundCloud, Deezer, ...), the bot downloads it right away.
- **With a song name**, or a Spotify / Apple Music link, the bot searches every enabled source. Use the arrow buttons to switch between sources and pages, then pick the track from the menu. The list closes after 1 minute.
- **Playlists are not supported**, only single tracks.

### File size limit

The upload limit depends on the server's boost level: 10MB by default, 50MB at level 2 and 100MB at level 3.

If a track is too big, the bot asks whether you want a **compressed version** or to **cancel**. The compressed version uses a lower bitrate (and drops the cover art if needed) so it fits under the limit. Very long tracks may not fit even when compressed.

# Commands

| Command | Description |
| - | - |
| `/download <query>` | Search and download a song. |
| `/help [command]` | List the commands, or get help for one command. |
| `/ping` | Show the bot's latency and uptime. |
| `/prefix <prefix>` | Change the prefix for text commands (default `>`). |

The bot owner also has text commands (`>reload`, `>restart`, `>status`, `>logs`, ...) to manage the bot.

# Self-hosting

1. Create a bot app in the [Discord Developer Portal](https://discord.com/developers/applications) and get its token and client ID.
    - Installation Contexts: Guild Install
    - Scopes: `applications.commands`, `bot`
    - Permissions: View Channels, Send Messages, Embed Links, Attach Files
2. Enable all privileged intents in the bot app (the bot requests Server Members and Message Content).
3. Install [Node.js](https://nodejs.org/en/download/) v22.22 LTS or newer and the latest [FFmpeg](https://ffmpeg.org/download.html). FFmpeg must be on your `PATH`; the bot won't start without it.
4. Clone this repository and run `npm install` (use `npm install --legacy-peer-deps` if errors occur).
5. Create a `.env` file in the root directory (see `.env.example_full` and the table below).
6. Start the bot with `npm start`.

No database is needed.

# Configuration

## Environment variables

| Variable | Description |
| - | - |
| **Required** | |
| TOKEN | The bot token. |
| CLIENT_ID | The bot's client ID. |
| OWNER_ID | Your Discord user ID. |
| SERVER | `prod` or `dev`. On `dev`, the bot only responds to its owner. |
| **Music sources** (optional) | |
| DEEZER_ARL_COOKIE | Your Deezer ARL cookie. Needed to download from Deezer. |
| DEEZER_MASTER_KEY | The Deezer master key. Needed to download from Deezer. |
| SPOTIFY_CLIENT_ID | Your Spotify app client ID. |
| SPOTIFY_CLIENT_SECRET | Your Spotify app client secret. |
| YOUTUBE_NETSCAPE_COOKIES_B64 | YouTube cookies (Netscape format, base64 encoded). Use an alt account. |
| SUBSONIC_URL | URL of your Subsonic server, if you enable the Subsonic source. |
| SUBSONIC_USERNAME | Subsonic username. |
| SUBSONIC_PASSWORD | Subsonic password. |
| **Other** (optional) | |
| DEV_TOKEN | Token of a separate bot used when `SERVER` is `dev`. |
| CONFIG_FILEPATH | Override the config file path. `@root` refers to the project root. |
| SENTRY_DSN | Sentry DSN to send ERROR/SEVERE/WARNING logs to Sentry. |
| STATUS_CHANNEL_ID | Channel where the bot posts status updates. |
| LIVE_UPDATE_CHANNEL_ID | Channel where the bot posts live stats. |
| GUILD_UPDATE_ID | Channel where the bot posts when it joins or leaves a server. |
| MEMBERS_UPDATE_ID | Channel where the bot posts member updates. |
| GUILD_BLACKLIST | Comma-separated server IDs the bot leaves as soon as it joins. |
| GLOBAL_BLACKLIST | Comma-separated user IDs that can't use the bot. |
| SUPERUSER_WHITELIST | Comma-separated user IDs with superuser permissions. |

## Sources

Sources are enabled, disabled and ordered in `utils/config/config.jsonc`, under `discordPlayer.extractors`. Sources with a higher `priority` are shown first in the `/download` picker.

# Known issues

- If you host on a VPS, YouTube may block your IP. In that case, disable YouTube in `utils/config/config.jsonc` and use Deezer or SoundCloud instead.
- Deezer downloads need a valid ARL cookie, which expires from time to time.

# Credits

This bot is based on [WD-40](https://github.com/iTsMaaT/WD-40) by iTsMaaT. Most of the code added on top of it was written with AI assistance, see [AI_DISCLOSURE.md](AI_DISCLOSURE.md).

[JavaScript-Badge]: https://img.shields.io/badge/JavaScript-%23323330.svg?style=flat&logo=javascript&logoColor=%23F7DF1E
[JavaScript-Url]: https://en.wikipedia.org/wiki/JavaScript "JavaScript"
