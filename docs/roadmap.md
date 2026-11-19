# Roadmap

Where Ops Console goes from a macOS tool to one developers install anywhere. Items are ranked by adoption gained per unit of work, and each one that needs code becomes a spec (`/spec`).

Today the console runs on macOS 13.5 or later, on Apple silicon or Intel. `install.sh` rejects every other OS, and `release.yml` builds two darwin tarballs. Installing is `curl | sh`. Datadog is the only monitoring source.

## 1. Trust and install on macOS

Small items for first-run friction. None conflicts with an ADR.

- Sign the binaries with an Apple Developer ID and notarize them, so Gatekeeper accepts a cask or browser download. Releases are ad hoc signed today. Spec: [sign-and-notarize-release](specs/sign-and-notarize-release.md). On hold until the owner has an Apple Developer Program membership.
- Publish a Homebrew tap that installs the existing darwin tarballs, and make `brew upgrade` work next to `ops-console update`. Spec: [homebrew-tap](specs/homebrew-tap.md).
- Finish Google OAuth verification for the Google Docs, Sheets and Drive Connectors. `drive.readonly` is a restricted scope, so verification may need a third-party security assessment. Until it passes, users see the unverified-app screen. Confirm the current verification status first.
- Add a data-flow section to `PRIVACY.md` and the site: what moves between the operator's machine, Anthropic's API and each Connector, and that none of it reaches an Ops Console server. [ADR 0003](adr/0003-local-only-server.md) already guarantees this, so the work is documentation.

## 2. Self-serve onboarding

A user in any timezone should get from install to a first verified alert without asking anyone.

- A sample repo with a failing route and mock Datadog alerts, so a new user can try the verify, review, fix and PR flow without production data.
- A troubleshooting guide on the docs site, covering the install, Keychain and sandbox failures people hit.
- A short video walkthrough of the same flow.

## 3. More monitoring sources

Datadog covers one slice of teams. Order by reach per integration:

1. Generic OpenTelemetry logs and a webhook receiver, which cover most other tools without a vendor-specific Connector.
2. AWS CloudWatch.
3. Grafana Loki.
4. New Relic.

The webhook receiver must respect [ADR 0003](adr/0003-local-only-server.md) (local-only server). Settle the design there before writing the spec.

## 4. Linux

The largest piece of work, because it changes two decisions:

- [ADR 0004](adr/0004-secrets-in-keychain.md) keeps secrets in the macOS Keychain. Linux needs libsecret or an equivalent behind the same interface.
- [ADR 0006](adr/0006-agent-runs-sandboxed-by-the-os.md) relies on the Agent SDK sandbox, which is Seatbelt on macOS. Check whether the SDK sandbox covers Linux through Bubblewrap. The console must keep failing a run when the sandbox is unavailable.
- launchd is replaced by a systemd user service.

Both ADRs are rewritten in place with the macOS-only design moved to Considered Options. Get approval before that rewrite. After the port, add `.deb`, AUR and npm/npx packages, in that order of effort.

## 5. Windows

Last, because both the sandbox and the secret store need a different design. Start with WSL2, which reuses the Linux build, and decide on a native build only if WSL2 adoption shows demand. Winget follows whichever route ships.

## 6. Localization

Translate the docs site first, then the UI. Do the UI after the screens settle, so strings do not churn. Target languages: Simplified Chinese, Japanese, Spanish, German and Korean. Extracting UI strings into message files is a prerequisite and can land earlier on its own.

## Order

| Step | Work | Needs ADR change |
| --- | --- | --- |
| 1 | Signing, notarization, Homebrew, Google verification, data-flow docs | No |
| 2 | Onboarding: sample repo, troubleshooting, video | No |
| 3 | OTel and webhook source, then CloudWatch, Loki, New Relic | Possibly 0003 |
| 4 | Linux | 0004, 0006 |
| 5 | Windows via WSL2 | Inherits Linux |
| 6 | Localization | No |
