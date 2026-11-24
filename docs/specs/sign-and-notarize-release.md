# Sign and notarize the release

**Status:** draft, on hold until an Apple Developer Program membership exists (see Blocker). Nothing in it is built: releases are ad hoc signed.
**Design:** none. Permissions page: no change. Follows no design screen.

## Problem

Every release ships `Ops Console.app` with an ad hoc signature, which carries no developer name. System Settings lists
the console under Login Items as an unidentified developer. A tarball opened from a browser or a Homebrew cask meets
Gatekeeper's block. Each new Node changes the signature's `cdhash`, so macOS asks again for Full Disk Access, and the
Keychain handover has to move every item on every release. Teams that allow only identified, notarized apps cannot
install it.

`curl | sh` is not affected by Gatekeeper, since `curl` sets no quarantine flag. The gain there is the developer name in
Login Items, a signature that survives a Node bump, and a build a managed Mac accepts.

## Blocker

On hold. `/ship` waits until the owner holds an Apple Developer Program membership. Without it there is no Developer ID
certificate and no notarization, so Behaviors 1 to 4 cannot run and the handover rule has no team to compare. Lifting
the hold takes four things: the membership, the certificate and notarization key in the repository's secrets, the
sign-switch variable, and the first-signed-version constant. Then set Status to `ready`.

## Decision notes

- **Hold**: the owner chose to hold the whole change until the membership exists. The earlier plan
  to merge the build and the check with the switch off is kept in Settled, for when the hold lifts.
- **Keychain**: the first signed release takes its items from the last ad hoc one, with no re-entry of secrets. Later
  releases of the same team move nothing. The owner chose this over a one-time re-entry.
- **ADR 0004**: the owner approved the revision. It is already written in
  [the ADR](../adr/0004-secrets-in-keychain.md), so `/ship` only checks it still matches.
- **Gatekeeper**: `curl | sh` never met Gatekeeper, so the gain is for cask and browser downloads, managed Macs, the
  developer name in Login Items and a stable Full Disk Access grant. This ranks signing below the Homebrew tap, which
  works for the unsigned build.

## Behavior

1. When the release is set to sign, a tagged release builds `Ops Console.app` signed with the project's Developer ID
   Application identity, with the hardened runtime and a secure timestamp. Every other Mach-O file in the tarball is
   signed the same way. Apple notarizes the whole build, and the ticket is stapled to the app before the tarball is made.
2. On a Mac that installed a signed release, `spctl --assess --type execute` accepts the app as a notarized Developer ID
   app, and System Settings lists Ops Console under the project's developer name.
3. The three native modules the daemon loads (the database, the Keychain and the terminal) are signed with the same
   identity, so the hardened runtime's library validation stays on. The app carries the entitlements Node needs, and no
   more than the daemon's start on both architectures proves necessary. Helpers the daemon only spawns, the Agent SDK's
   binary among them, are not re-signed when they already carry a valid signature.
4. When the release is set to sign, it fails before it publishes anything if a signing or notarization secret is
   missing, the signing fails, Apple rejects the submission, or the stapled app fails `codesign --verify --strict` or
   `spctl --assess`. It never publishes an ad hoc build as a signed release.
5. When the release is not set to sign, it publishes the ad hoc build as today, and the release notes do not call it
   signed.
6. The existing release check runs on every tarball, signed or not: install, start under launchd, status, open, stop,
   on both architectures. Nothing else changes: the install script, the tarball layout, update and the checksums work
   as before.
7. A local package with no signing identity keeps the ad hoc signature, under the same rules as today.
8. The Keychain handover check keeps its three parts today. From the first signed version on it adds a fourth: the
   previous app must be signed by the same team as this app. Below the first signed version an ad hoc previous app
   passes, so the first signed release takes its items from the last ad hoc one as today.
9. When the previous app shares this app's team and bundle identifier, the Keychain items need no move. The console
   records this app as the owner and runs no `take`, since macOS trusts both apps for the same items.
10. A previous app at or above the first signed version with another team is a Handover refusal, and its reason reads
    "previous app is signed by a different team". One with no signature identity at all gets its own reason,
    "previous app is not signed by a developer".
11. A previous version folder whose name is not a plain version number is refused. A downgrade to an ad hoc release,
    or a local ad hoc package at a version at or above the first signed version, is refused under the same rule.
12. A build with no team of its own, a local ad hoc package for one, applies only the checks that exist today.
13. The operator regrants Full Disk Access once after the first signed release, since the grant followed the ad hoc
    signature. The Permissions page already shows the grant as missing and says how to grant it. Later releases keep
    it, because the grant follows the Developer ID identity, not each Node's `cdhash`.
14. The first signed release's notes say the operator regrants Full Disk Access once. The owner writes that line by
    hand before the tag, since the notes are otherwise generated.
15. No secret reaches a log, the release notes or the tarball. The certificate and the Apple notarization key exist only
    in the release job's secrets and its temporary keychain, which is deleted when the job ends.

## Settled

- **Identity**: Developer ID Application, from an Apple Developer Program membership held by the project owner. The
  Mac App Store and Developer ID Installer are not used: the console is a tarball, not a package.
- **Sign switch**: one repository variable decides whether a tagged release signs. Off, the release is ad hoc as today.
  On, a missing secret fails it. The owner turns it on at the first signed tag.
- **Notarize the whole build**: the app and every Mach-O file beside it go to Apple as one zip. A browser or cask
  download spreads quarantine to every extracted file, so an unnotarized native module would be blocked. Only the app
  takes a stapled ticket, since Apple staples bundles, not tarballs.
- **Sign the native modules**: the alternative, disabling library validation, lets any dylib load into the daemon,
  which holds the Keychain items.
- **Fail closed on release**: with the switch on, a missing secret stops the release. A silent ad hoc fallback would ship
  the build this spec exists to replace.
- **Transition, then pin**: the first signed version is one constant. It holds no version until the owner sets it in the
  change that precedes the first signed tag, so nothing is pinned before signing exists.
- **Team identifier**: [ADR 0004](../adr/0004-secrets-in-keychain.md) pins no `cdhash`, since every Node bump
  changes it. The team identifier is stable across Node bumps, and macOS tracks Keychain and Full Disk Access trust by
  it and the bundle identifier. This holds on the first signed tag to be checked by hand.
- **Version from the folder name**: the previous app's version is its folder's name under the versions folder. The
  folder names are as trustworthy as anyone who can write there, and that person can already replace the installed app.
  The rule guards a stray or damaged bundle, as the check does today, and claims no more.
- **Full Disk Access regrant**: macOS ties the grant to the signature. The first signed release cannot keep an ad hoc
  grant, and the console cannot carry it across.
- **Ship order**: once the hold lifts, the build, the switch and the check merge with the switch off, and the owner
  turns it on at the first signed tag. The Status stays `draft` until the Blocker clears.
- **Secrets**: the certificate as a base64 `.p12` with its password, and an App Store Connect API key (key id, issuer
  id and the `.p8`) for notarization. All in GitHub Actions secrets of the repository.

## Not required

- **Signed or notarized builds before the first signed one**: they stay ad hoc and Gatekeeper still blocks a cask or a
  browser download of them.
- **Carrying the Full Disk Access grant across the first signed release**: the operator regrants once.
- **A signed or notarized `ops-console update` path on its own**: update uses the install script, which already
  checks the tarball's checksum.
- **A Windows or Linux signature**: those platforms have no build yet.
- **Notarizing the CLI as its own artifact**: the CLI is script run by the app's own Node.
- **A trustworthy version source**: a planted folder named `0.0.1` holding an ad hoc bundle passes the version rule.

## Safety

No change. The agent's reach is the same as before. The signing happens in the release job, outside any agent run,
and the handover check runs in the daemon and reads no secret.

## API

### `GET /terminals/keychain-handover`

Unchanged in shape. `reason` gains two values, listed under Behavior 10, and names no team identifier.

## UI

- **Permissions, Keychain row**: the Handover refusal state shows the two new reasons. No other state changes.
- **Permissions, Full Disk Access row**: no change. It shows "not granted" after the first signed release until the
  operator grants it.

## Rejected

- **Re-enter every secret once at the first signed release**: a worse upgrade than a handover that already works.
- **Accept ad hoc previous apps forever**: once identities exist, the check would stay a guard with no identity behind it.
- **Disable library validation**: simpler than signing the native modules, but lets an unsigned dylib load into the
  process that reads the Keychain.
- **Notarize the tarball**: Apple notarizes a zip, pkg or dmg. A tarball cannot hold a stapled ticket.
- **Sign when the secrets happen to exist**: ships an ad hoc build as a release when a secret goes missing, with no
  signal to the owner.
- **Run `take` on every release as today**: with one team, macOS already trusts the new app for the items, so the
  move gains nothing and may prompt for the login password.

## Glossary

- **Signed build**: a release app bundle signed with the project's Developer ID, notarized by Apple and stapled.
- **Ad hoc build**: an app bundle signed with no identity, as `pnpm dev` and a local package are. It has no team.

## ADR

- **Secrets in the Keychain (revised, written)**: the handover check gains the team rule from the first signed version on. A
  previous app of the same team needs no move of items. An ad hoc previous app stays valid only below that version. The
  ADR's opening premise, that each release is a new app macOS asks about once per item, holds for ad hoc builds only.
  The trade-off: one constant to set at the first signed tag, in exchange for a handover that stays valid across Node
  bumps. The ADR drops its line that the check pins no signing authority.

## Seams

- **Handover check with a fake `codesign` and a fake version folder (unit)**: 8 to 12. Cases: ad hoc previous below the
  first signed version, passes; at or above it, refused with its reason; same team, passes with no `take`; other team,
  refused with its reason; folder name not a plain version, refused; this app ad hoc, today's rules; no constant set,
  today's rules.
- **Packaging script with no identity (unit)**: 7.
- **Release workflow on a tag with the switch off (CI)**: 5 and 6. The workflow with the switch on cannot run before the membership, so 1 to 4 have no automated seam.
- **`GET /terminals/keychain-handover` (backend)**: the two reasons in 10.
- **Permissions Keychain row (browser)**: the new reasons in the UI section.
- **Manual on the first signed tag, on a Mac that ran an ad hoc release**: 1 to 4, 9, 13 and 14. Run `codesign
  --verify --strict`, `spctl --assess` and `xcrun stapler validate`, install over the ad hoc build, then read System
  Settings, Keychain prompts and the Full Disk Access row. The same run settles the entitlement set in 3.
- **Review**: 15. Review reads the workflow for any secret echoed or written to disk.

## Out of scope

- **Homebrew tap**: its own spec, `homebrew-tap`. It reuses the signed tarballs.
- **Linux and Windows signing**: with those platforms, in their own specs.
- **Automatic regrant of Full Disk Access on each release**: macOS offers no way.
