# Troubleshooting guide

**Status:** shipped
**Design:** none: a docs page in the site's current layout.

## Problem

An operator whose install, start or first run fails sees a message in a terminal, a banner or the Permissions page, and has nowhere to look it up. Roadmap step 2 wants a user in any timezone to get from install to a first verified alert without asking anyone. The messages and the fixes already exist in the product. No page ties them together.

## Behavior

1. `/docs/troubleshooting/` exists. The docs sidebar lists it after "Safety" and before "Run from source", the docs index shows its card, and "Install and update" links to it once.
2. The page has these sections, in this order: Install, Start and stop, Keychain, Run sandbox, Permissions, and When it is not here.
3. Install covers: an unsupported platform or CPU, a macOS older than 13.5, a failed download, a checksum mismatch (nothing is installed), `ops-console: command not found` because `~/.local/bin` is not on the PATH, and the Intel Homebrew on an Apple silicon Mac.
4. Start and stop covers: `ops-console start` not answering within 15 seconds (read the log tail it prints, and raise the wait with `OPS_CONSOLE_START_TIMEOUT_MS`), a port already in use (start again with `OPS_CONSOLE_PORT`), another daemon already running on the data folder, launchd refusing to load the job with `Bootstrap failed: 5: Input/output error` (run `ops-console stop`, then `ops-console start`), and an update that fails (run `ops-console update`).
5. Keychain covers: the banner that shows after a Keychain wait of 10 seconds (answer the Mac's password prompt), a run or step that fails after 60 seconds with `keychain_timeout` (answer the prompt, then retry the job), the same failure after 90 seconds during an update (the Keychain handover keeps running, so retry), and a Handover refusal on the Permissions page (the Mac may ask for the login password once per item until the previous version's folder is fixed or removed and the console restarts).
6. Run sandbox covers: the Run sandbox row reading unavailable (a run fails rather than run without it, and no setting turns the sandbox off) and a run that names a host the sandbox refused (add the host to the Network allowlist).
7. Permissions covers: Full Disk Access off (the Setup agent cannot start; grant it to Ops Console in System Settings, then `ops-console stop` and `ops-console start`) and Start at login off (switch Ops Console on under App Background Activity, then `ops-console start`, since `stop` keeps it off).
8. Each entry is a `###` heading with the symptom, then the message the product shows in a code span, the cause in one sentence, and the fix as a command or numbered steps. No tables.
9. A message is quoted only when the product shows it. The page makes no claim about a stale version after `brew upgrade`, a missing `claude` binary, or the wording of the SDK's own sandbox error.
10. When it is not here: run `ops-console status`, copy the last lines of `~/Library/Logs/ops-console/daemon.log`, note the version, and open an issue on the issue tracker. It says to remove secrets and customer data first, since the repo is public.
11. The site build still passes: every page builds, every internal link has a page, and no page loads anything from a third party.

## Settled

- **Areas**: install, start and stop, Keychain, Run sandbox, Permissions. Claude account sign-in stays on the Claude accounts page.
- **Terms**: Keychain wait, Keychain handover, Handover refusal, Run sandbox, Network allowlist and Start at login as the glossary defines them.
- **Glossary**: no new term.
- **Source of messages**: the product's own text at the time of writing. The page quotes the short, stable ones.

## Not required

- **Links from the app.** The Permissions page and the Keychain banner do not link to the guide.
- **A test that keeps the quoted messages true.** The site test pins the page, its place and its links. Review compares the text with the product.

## Safety

No change.

## Rejected

- **Tables of symptom, cause, fix**: a row cannot hold a command or steps, and has no anchor to link.
- **One page per area**: five short pages scatter a search, and the sidebar grows by five.
- **Linking the guide from the app now**: a frontend change that needs its own states and tests.
- **A drift test on quoted messages**: the messages live in several packages, and the test would break on a rewording with no operator effect.

## Seams

- **Node test** (site build test, existing): 1, 2 and 11. It builds the site and checks the page's place in the docs order, that "Install and update" links it, that the six section headings exist in order, and the existing link and third-party checks.
- **Read in review**: 3 to 10. The reviewer compares each entry with the message and fix in the product.

## Out of scope

- Links from the Permissions page and the Keychain banner to this guide: a follow-up spec.
- The sample repo and the video walkthrough: the other two items of roadmap step 2.
- Google OAuth verification and release signing: on hold.
