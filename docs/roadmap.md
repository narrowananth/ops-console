# Roadmap

Where Ops Console goes from a macOS tool to one developers install anywhere. Items are ranked by adoption gained per unit of work, and each one that needs code becomes a spec (`/spec`).

Today the console runs on macOS 13.5 or later, on Apple silicon or Intel. `install.sh` rejects every other OS, and `release.yml` builds two darwin tarballs. Installing is `curl | sh` or Homebrew. Monitor reads five log sources: Datadog, OpenTelemetry logs, CloudWatch logs, Loki and New Relic.

## On hold

Owner decision. Each waits for the thing named, then moves back into the order below.

- Sign the binaries with an Apple Developer ID and notarize them, so Gatekeeper accepts a cask or browser download. Releases are ad hoc signed today. Spec: [sign-and-notarize-release](specs/sign-and-notarize-release.md). Waits for an Apple Developer Program membership.
- Finish Google OAuth verification for the Google Docs, Sheets and Drive Connectors. Until it passes, users see the unverified-app screen. `documents` and `spreadsheets` are sensitive scopes. `drive.readonly` is restricted and needs a paid third-party security assessment. No spec yet. Waits for the owner to restart it, and the current status in the Google Cloud console is not known.
- A sample repo with a failing route and mock Datadog alerts, so a new user can try the verify, review, fix and PR flow without production data. Spec: [sample-repo](specs/sample-repo.md). Low priority: it helps adoption and leaves the core flow as it is. Waits until onboarding outranks work on the core flow.
- A webhook receiver, so a monitoring tool can push an Alert to the console the moment it fires. A push needs a way in to a daemon that listens on 127.0.0.1 only, and every route in (a tunnel, a relay server, a second listener) conflicts with [ADR 0003](adr/0003-local-only-server.md). Scans and the OpenTelemetry Log folder already cover detection. No spec yet. Waits until a source cannot be read by Scan or Log folder, and an ADR 0003 design is approved.

## Self-serve onboarding

A user in any timezone should get from install to a first verified alert without asking anyone. What remains:

- A short video walkthrough of the flow. It needs data safe to show on camera, so it waits for the sample repo.

## Connectors

New Connectors ship one at a time, read only first: Figma, Notion, Shortcut and Render, then the mobile, operations and
product services in the order set by the stack. Plan, official documentation and open checks:
[connectors-roadmap](connectors-roadmap.md).

## 1. Linux

The largest piece of work, because it changes two decisions:

- [ADR 0004](adr/0004-secrets-in-keychain.md) keeps secrets in the macOS Keychain. Linux needs libsecret or an equivalent behind the same interface.
- [ADR 0006](adr/0006-agent-runs-sandboxed-by-the-os.md) relies on the Agent SDK sandbox, which is Seatbelt on macOS. Check whether the SDK sandbox covers Linux through Bubblewrap. The console must keep failing a run when the sandbox is unavailable.
- launchd is replaced by a systemd user service.

Both ADRs are rewritten in place with the macOS-only design moved to Considered Options. Get approval before that rewrite. After the port, add `.deb`, AUR and npm/npx packages, in that order of effort.

## 2. Windows

Last, because both the sandbox and the secret store need a different design. Start with WSL2, which reuses the Linux build, and decide on a native build only if WSL2 adoption shows demand. Winget follows whichever route ships.

## 3. Localization

Translate the docs site first, then the UI. Do the UI after the screens settle, so strings do not churn. Target languages: Simplified Chinese, Japanese, Spanish, German and Korean. Extracting UI strings into message files is a prerequisite and can land earlier on its own.

## Order

| Step | Work | Needs ADR change |
| --- | --- | --- |
| 1 | Linux | 0004, 0006 |
| 2 | Windows via WSL2 | Inherits Linux |
| 3 | Localization | No |

On hold, outside the order: signing and Google verification, the sample repo and the video that waits for it, and the webhook receiver.
