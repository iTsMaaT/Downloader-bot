# Privacy Policy

_Last updated: November 23, 2026_

This policy explains what data Downloader Bot ("the bot") handles, why, and how you can remove it. The bot is an open-source Discord bot maintained by [iTsMaaT](https://github.com/iTsMaaT). Its source code is public at <https://github.com/iTsMaaT/Downloader-bot>, so everything described here can be checked in the code.

If you use a copy of the bot hosted by someone else, that person runs it and is responsible for it. This policy describes how the software behaves.

## What the bot handles

### When you use any command

- **Your Discord user ID, username, and the server and channel you used the command in.** These are printed in the bot's console log, together with the command name, for troubleshooting. They aren't stored in a database.
- **Your search text or the link you paste.** The bot sends it to the music sources it searches (YouTube, SoundCloud, Deezer, Spotify, Apple Music and similar) to find the song, and sends the song title and artist to [MusicBrainz](https://musicbrainz.org) to look up album information.
- **Downloaded audio files.** These are kept temporarily on the server that runs the bot so they can be sent to you, and are deleted automatically every day.

### When you link Google Drive (`/drive login`)

Linking Google Drive is optional. Only then, the bot stores the following in its database:

| Data | Why |
|---|---|
| Your Discord user ID | To know which Google account belongs to you |
| A Google refresh token, encrypted (AES-256-GCM) | To upload files to your Drive when you download something |
| Your Google account email address | To show you which account is linked (`/drive status`) |
| A list of files the bot uploaded for you (file name, size, Google Drive file ID, date, track count) | To show your history in `/drive status` |
| When you linked and last used Google Drive | To show in `/drive status` |

## Google user data

The bot asks Google for these permissions only:

- **`drive.file`**: lets the bot create files in your Google Drive and manage the files **it created**. It can't see, read, change or delete any other file in your Drive.
- **`openid` and `email`**: lets the bot see your email address, to show which account is linked.

How the bot uses this access:

- It creates one folder in your Drive (named "Downloader Bot" by default) and uploads the songs and playlist zips you download into it.
- It reads your Drive storage usage (used and total space) only to show it to you in `/drive status`.
- It never reads, downloads, modifies or deletes your other files, and never reads the content of the files it uploaded.
- Your Google data is never sold, shared with or transferred to third parties, and is never used for advertising, profiling, or training AI or machine learning models.
- Nobody reads your Google data. It is only processed automatically to provide the features above.

The bot's use and transfer of information received from Google APIs follows the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## How long data is kept

- **Downloaded files on the server**: deleted automatically every day.
- **Console logs**: kept only as long as the hosting provider keeps console output.
- **Google Drive link data**: kept until you unlink. Running `/drive logout` deletes your token, email and upload history from the database, and revokes the bot's access with Google.
- **Files uploaded to your Drive**: these belong to you and stay in your Drive until you delete them. Unlinking doesn't delete them.

You can also remove the bot's access at any time from your Google account at <https://myaccount.google.com/permissions>. The bot then deletes its stored link the next time it tries to use it.

## Security

Google refresh tokens are encrypted before being stored. Data is sent to Google, Discord and the music sources over HTTPS.

## Children

The bot follows Discord's minimum age requirements and isn't directed at children under 13 (or the minimum age in your country).

## Changes

If this policy changes, the new version is published at the same address with a new "Last updated" date. The full history of changes is visible in the repository.

## Contact

For questions, or to ask for your data to be deleted, open an issue at <https://github.com/iTsMaaT/Downloader-bot/issues>.
