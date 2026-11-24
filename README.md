<h1 align="center">
    <br>
    Downloader Bot
    <br><br>
</h1>

<p align="center">
    A Discord bot that searches for songs and sends them to you as audio files, or saves them to your Google Drive.
    <br>
    Based on <a href="https://github.com/iTsMaaT/WD-40">WD-40</a>.
    <br>
    <a href="https://itsmaat.github.io/Downloader-bot/PRIVACY.html">Privacy Policy</a>
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

- Download songs as MP3, M4A (AAC), Opus or FLAC, in low, medium or high quality (MP3 192 kbps by default), with title, artist, album and cover art tags
- Search by name or paste a link from YouTube, SoundCloud, Deezer, Spotify, Apple Music and more
- Pick the source and the exact track from a list when searching by name
- Spotify and Apple Music links are matched to a source that can be downloaded
- Link your Google Drive to save downloads there, with no size limit
- Download whole playlists and albums as a zip (requires a linked Google Drive)
- Files too big for the server's upload limit can be saved to Google Drive or sent as a compressed version
- Downloaded files are cached and cleared every day at 3 AM

# Usage

Run `/download` with a song name or a link:

```
/download query: never gonna give you up
/download query: https://www.youtube.com/watch?v=dQw4w9WgXcQ
/download query: https://www.youtube.com/watch?v=dQw4w9WgXcQ format: FLAC (lossless)
```

- **With a link** from a source that can be streamed (YouTube, SoundCloud, Deezer, ...), the bot downloads it right away.
- **With a song name**, or a Spotify / Apple Music link, the bot searches every enabled source. Use the arrow buttons to switch between sources and pages, then pick the track from the menu. The list closes after 1 minute.
- **With a playlist or album link**, the bot downloads every track and zips them, with a `playlist.m3u8`. This needs a linked Google Drive (see below). Up to 100 tracks per playlist, and up to 3 playlists download at the same time across all users.

`/download` has a 10 second cooldown.

### Format and quality

| Format | Low | Medium | High | Cover art |
| - | - | - | - | - |
| MP3 (default) | 128 kbps | 192 kbps | 320 kbps | Yes |
| M4A (AAC) | 128 kbps | 192 kbps | 256 kbps | Yes |
| Opus | 96 kbps | 128 kbps | 192 kbps | No |
| FLAC | lossless | lossless | lossless | Yes |

Pick them for one download with the `format` and `quality` options of `/download`, or save your defaults with `/drive settings`. Most sources are already compressed (YouTube is around 128-160 kbps), so higher settings and FLAC mostly give bigger files, not better sound.

### Google Drive

Run `/drive login` and follow the link to connect your Google account. The bot can only see the files it creates, in a **Downloader Bot** folder in your Drive.

Once linked, `/download` asks whether to **send the file here** or **save it to Google Drive**. To skip that question, choose a default with `/drive settings destination:`. Playlists are saved to Drive as a single zip.

`/drive status` shows the linked account, your Drive storage and what the bot saved. `/drive logout` unlinks it and deletes what the bot stored about you (files already in your Drive stay there).

### File size limit

The upload limit depends on the server's boost level: 10MB by default, 50MB at level 2 and 100MB at level 3.

If a track is too big, the bot asks whether you want to **save it to Google Drive** (if linked), get a **compressed version**, or **cancel**. The compressed version is an MP3 at a lower bitrate (and drops the cover art if needed) so it fits under the limit. Very long tracks may not fit even when compressed.

# Commands

| Command | Description |
| - | - |
| `/download <query> [format] [quality]` | Search and download a song, or a playlist/album as a zip. |
| `/drive login` | Link your Google Drive. |
| `/drive logout` | Unlink your Google Drive and delete what the bot stored about you. |
| `/drive status` | Show the linked account, Drive storage and what was saved. |
| `/drive settings [destination] [format] [quality] [reset]` | Show or change where downloads go and their default format and quality. |
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

The bot uses a SQLite database for Google Drive links and user settings. It's created automatically at `./data/bot.db` (or `DATABASE_PATH`), so there's nothing to set up. Back it up, and keep it on persistent storage if you host in a container.

### Google Drive (optional)

`/drive` and playlist downloads need a Google OAuth app. Without it, `/drive` replies that it isn't set up and playlists are disabled. Single tracks still work.

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Set up the OAuth consent screen (Google Auth Platform): app name, support email, and a homepage and privacy policy URL. Add the `drive.file`, `openid` and `email` scopes.
3. Create an OAuth client of type **TVs and Limited Input devices**, and put its ID and secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. Set `GOOGLE_DRIVE_TOKEN_KEY` to a long random string. It encrypts the stored tokens. Changing or losing it unlinks everyone.
5. Publish the app to **Production**. While it's in Testing, only test users can log in and logins expire after 7 days.

# Configuration

## Environment variables

| Variable | Description |
| - | - |
| **Required** | |
| TOKEN | The bot token. |
| CLIENT_ID | The bot's client ID. |
| OWNER_ID | Your Discord user ID. |
| SERVER | `prod` or `dev`. On `dev`, the bot only responds to its owner and whitelisted users (superuser mode). |
| **Music sources** (optional) | |
| DEEZER_ARL_COOKIE | Your Deezer ARL cookie. Needed to download from Deezer. |
| DEEZER_MASTER_KEY | The Deezer master key. Needed to download from Deezer. |
| SPOTIFY_CLIENT_ID | Your Spotify app client ID. |
| SPOTIFY_CLIENT_SECRET | Your Spotify app client secret. |
| YOUTUBE_NETSCAPE_COOKIES_B64 | YouTube cookies (Netscape format, base64 encoded). Use an alt account. |
| SUBSONIC_URL | URL of your Subsonic server, if you enable the Subsonic source. |
| SUBSONIC_USERNAME | Subsonic username. |
| SUBSONIC_PASSWORD | Subsonic password. |
| **Google Drive** (optional) | |
| GOOGLE_CLIENT_ID | Google OAuth client ID (type "TVs and Limited Input devices"). |
| GOOGLE_CLIENT_SECRET | Google OAuth client secret. |
| GOOGLE_DRIVE_TOKEN_KEY | Any long random string, used to encrypt stored Google tokens. Changing it unlinks everyone. |
| **Other** (optional) | |
| DATABASE_PATH | Path of the SQLite database. Defaults to `./data/bot.db`. |
| SUPERUSER_MODE | `on` or `off`. Overrides superuser mode, e.g. `SERVER=dev` with `SUPERUSER_MODE=off` lets everyone use the dev bot. |
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

## Playlists and Google Drive

Also in `utils/config/config.jsonc`:

| Key | Default | Description |
| - | - | - |
| `playlistDownload.maxTracks` | 100 | Tracks past this are ignored. |
| `playlistDownload.maxDiscordZipParts` | 10 | Max zip files sent in Discord when a user picks Discord over Drive. |
| `playlistDownload.concurrency` | 2 | Tracks downloaded in parallel per playlist. |
| `playlistDownload.maxConcurrentJobs` | 3 | Playlists downloading at the same time, across all users. |
| `googleDrive.folderName` | Downloader Bot | Folder created in each user's Drive. |

# Known issues

- If you host on a VPS, YouTube may block your IP. In that case, disable YouTube in `utils/config/config.jsonc` and use Deezer or SoundCloud instead.
- Deezer downloads need a valid ARL cookie, which expires from time to time.
- While the Google OAuth app is in Testing mode, Drive logins expire after 7 days. Publish it to Production to avoid that.

# Credits

This bot is based on [WD-40](https://github.com/iTsMaaT/WD-40) by iTsMaaT. Most of the code added on top of it was written with AI assistance, see [AI_DISCLOSURE.md](AI_DISCLOSURE.md).

[JavaScript-Badge]: https://img.shields.io/badge/JavaScript-%23323330.svg?style=flat&logo=javascript&logoColor=%23F7DF1E
[JavaScript-Url]: https://en.wikipedia.org/wiki/JavaScript "JavaScript"
