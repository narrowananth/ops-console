// Wraps a Node binary in `Ops Console.app`, so macOS names the daemon Ops Console, with its logo, wherever it
// lists apps: System Settings › Privacy & Security above all, where the operator grants Full Disk Access.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const APP_NAME = 'Ops Console';
/** Matches the launchd label, `dev.ops-console`. */
const BUNDLE_ID = 'dev.ops-console';
const ICON = path.resolve(import.meta.dirname, '../cli/assets/ops-console.icns');

/** Builds `<dir>/Ops Console.app` around `node` and returns the path of its executable. */
export async function buildAppBundle({ node, dir, version }) {
  const app = path.join(dir, `${APP_NAME}.app`);
  const contents = path.join(app, 'Contents');
  await mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await mkdir(path.join(contents, 'Resources'), { recursive: true });
  const executable = path.join(contents, 'MacOS', APP_NAME);
  await copyFile(node, executable);
  await copyFile(ICON, path.join(contents, 'Resources', 'ops-console.icns'));
  await writeFile(path.join(contents, 'Info.plist'), infoPlist(version));
  // Node's own signature names Node; an ad-hoc one names the bundle. A new Node means a new signature, and
  // macOS asks for Full Disk Access again.
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' });
  return executable;
}

function infoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIconFile</key>
    <string>ops-console</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${version}</string>
    <key>LSUIElement</key>
    <true/>
  </dict>
</plist>
`;
}
