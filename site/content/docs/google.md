# Google Docs, Sheets and Drive

Three Connectors let the agent read and edit your Google files. You sign in to Google once in Ops Console, and every Claude account you use reaches the same files, whether CLIProxy is on or off. The Google sign-in belongs to the console, not to a Claude account.

## Connect

1. Open Integrations and press Connect on Google Docs, Google Sheets or Google Drive.
2. Google's account chooser opens in your browser. Pick the Google account to use.
3. Google may show "Google hasn't verified this app". That is expected: click Advanced, then Go to Ops Console, then Allow.
4. The Connector reads connected, with the Google email beside it.

Each Connector signs in on its own and asks for one permission. You can connect Sheets without giving the agent Drive, and use a different Google account for each.

## What the agent can do

| Connector | Permission | Tools |
| --------- | ---------- | ----- |
| Google Docs | Read and edit Google Docs | `get_document`, `create_document`, `append_text`, `replace_text` |
| Google Sheets | Read and edit Google Sheets | `get_spreadsheet`, `get_values`, `update_values`, `append_values`, `create_spreadsheet` |
| Google Drive | Read Drive files | `search_files`, `get_file`, `read_file` |

A tool takes a link or an id. Docs and Sheets reach the files you give them by link or id. To find a file by name, connect Drive. `read_file` returns a Google Doc as text, a Google Sheet's first sheet as CSV and a text file as it is. Long text is cut at 100,000 characters, and a binary file or one over 1 MB is refused.

Drive is read-only: no tool deletes a file, empties the trash or changes who can open a file, so no Access mode can do either.

In a chat Session, a Google tool follows the Session's Access mode like any other tool: supervised asks before a write. Jobs such as a Verification, a Fix or a review get no Google tools.

## How it stays private

The console keeps your Google refresh token in the macOS Keychain. The agent never sees it. A small helper process that Claude Code starts reads the token, gets an access token that lasts at most an hour and keeps it in memory, and makes each call to Google. Nothing goes to the project. See the [privacy policy](/privacy/).

## Disconnect and revoke

Disconnect deletes the token from the Keychain and revokes it at Google, unless another connected Google Connector uses the same Google account, in which case that access stays. You can also remove Ops Console on your [Google account's third-party access page](https://myaccount.google.com/connections).

## Troubleshooting

| What you see | What to do |
| ------------ | ---------- |
| Google blocks the app on a work account | Your Workspace admin restricts outside apps. Ask them to allow the client ID the sign-in shows |
| "<name> needs signing in again" | Google ended the sign-in, for example after a password change. Press Connect again |
| "Google sign-in is not set up in this build" | A build made without the Google client, such as one run from source without the `OPS_CONSOLE_GOOGLE_CLIENT_ID` and `OPS_CONSOLE_GOOGLE_CLIENT_SECRET` variables. Use a release build |
| "<name> sign-in did not finish within 5 minutes" | Press Connect and finish the sign-in sooner |
