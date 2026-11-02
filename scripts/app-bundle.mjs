// Wraps a Node binary in `Ops Console.app`, so macOS names the daemon Ops Console, with its logo, wherever it
// lists apps: System Settings › Privacy & Security above all, where the operator grants Full Disk Access.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const APP_NAME = 'Ops Console';
/** Matches the launchd label, `dev.ops-console`. */
const BUNDLE_ID = 'dev.ops-console';
const ICON = path.resolve(import.meta.dirname, '../cli/assets/ops-console.icns');

/**
 * Builds `<dir>/<name>.app` around `node` and returns the path of its executable. `pnpm dev` builds its own,
 * under another name and id, so macOS keeps its permissions apart from the installed app's.
 */
export async function buildAppBundle({ node, dir, version, name = APP_NAME, id = BUNDLE_ID }) {
  const app = path.join(dir, `${name}.app`);
  const contents = path.join(app, 'Contents');
  await mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await mkdir(path.join(contents, 'Resources'), { recursive: true });
  const executable = path.join(contents, 'MacOS', name);
  await copyFile(node, executable);
  await copyFile(ICON, path.join(contents, 'Resources', 'ops-console.icns'));
  await writeFile(path.join(contents, 'Info.plist'), infoPlist({ version, name, id }));
  // Node's own signature names Node; an ad-hoc one names the bundle. A new Node means a new signature, and
  // macOS asks for Full Disk Access again.
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' });
  return executable;
}

function infoPlist({ version, name, id }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleExecutable</key>
    <string>${name}</string>
    <key>CFBundleIdentifier</key>
    <string>${id}</string>
    <key>CFBundleName</key>
    <string>${name}</string>
    <key>CFBundleDisplayName</key>
    <string>${name}</string>
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
