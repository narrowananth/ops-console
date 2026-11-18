# Privacy policy

Effective 18 November 2026.

Ops Console is open-source software that runs on your own Mac. This page says what happens to your data when you use it, and in particular to the Google data you let it reach.

## Who runs what

The project publishes the code and the release downloads. It runs no server that Ops Console talks to for your work, and it receives no account data, no files and no usage statistics from your installation. Ops Console has no telemetry. The only network request it makes to the project is a check for a newer release on GitHub.

## Google data

You can connect Google Docs, Google Sheets and Google Drive. Each connection asks Google for one permission, which you approve on Google's own sign-in page:

| Connector | Permission | What it allows |
| --------- | ---------- | -------------- |
| Google Docs | `documents` | Read and edit your Google Docs |
| Google Sheets | `spreadsheets` | Read and edit your Google Sheets |
| Google Drive | `drive.readonly` | Search and read your Drive files, and change nothing |

Each connection also asks for your email address, to show which Google account is connected.

Ops Console reads or changes a file only when the coding agent you run in it calls one of these tools. It does not browse your files in the background.

## Where the data goes

- **Your refresh token** stays in your macOS Keychain. It is never written to a project file, a Claude configuration or a log, and the agent never sees it. An access token lasts at most an hour and lives in memory.
- **File contents** that a tool returns go to the agent, which is the Claude Code account or CLIProxy you chose in Ops Console. That provider handles them under its own terms. The project does not receive them.
- **Session history** on your Mac, including text a tool returned, is stored in a local database in the Ops Console data folder. It stays on your Mac until you delete it.
- **Nothing is sold or shared.** The project does not sell, rent or share Google user data, and does not use it for advertising or to train AI models.

Ops Console's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Your control

- **Disconnect** a Connector in Integrations. Ops Console deletes the token from your Keychain and revokes its access at Google, unless another connected Google Connector uses the same Google account, which keeps that access.
- **Revoke it at Google** at any time on your [Google account's third-party access page](https://myaccount.google.com/connections).
- **Delete the history** by deleting a Session in Ops Console, or the data folder.
- **Uninstall** with `ops-console uninstall`.

## Changes and contact

If this policy changes, the new text is committed to this repository with its date. Questions go to the project's [issue tracker](https://github.com/narrowananth/ops-console/issues).
