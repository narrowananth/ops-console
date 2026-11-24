import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openPlan } from '../src/opener';
import { platformPaths } from '../src/paths';
import { systemdUnit } from '../src/systemd';
import { tempDir } from './helpers';

describe('platformPaths', () => {
  it('keeps the macOS folders', () => {
    const p = platformPaths('darwin', '/Users/a', {});
    expect(p.dataDir).toBe('/Users/a/Library/Application Support/ops-console');
    expect(p.logFile).toBe('/Users/a/Library/Logs/ops-console/daemon.log');
    expect(p.daemonExecutable).toBe('/Users/a/.ops-console/current/Ops Console.app/Contents/MacOS/Ops Console');
    expect(p.plist).toBe('/Users/a/Library/LaunchAgents/dev.ops-console.plist');
  });

  it('puts Linux data, logs and the unit under the XDG defaults, and runs node itself', () => {
    const p = platformPaths('linux', '/home/a', {});
    expect(p.dataDir).toBe('/home/a/.local/share/ops-console');
    expect(p.logFile).toBe('/home/a/.local/state/ops-console/daemon.log');
    expect(p.unitFile).toBe('/home/a/.config/systemd/user/ops-console.service');
    expect(p.daemonExecutable).toBe('/home/a/.ops-console/current/node/bin/node');
    expect(p.installDir).toBe('/home/a/.ops-console');
  });

  it('follows the XDG variables when they are absolute, and ignores relative or empty ones', () => {
    const set = platformPaths('linux', '/home/a', {
      XDG_DATA_HOME: '/data',
      XDG_STATE_HOME: '/state',
      XDG_CONFIG_HOME: '/config',
    });
    expect(set.dataDir).toBe('/data/ops-console');
    expect(set.logFile).toBe('/state/ops-console/daemon.log');
    expect(set.unitFile).toBe('/config/systemd/user/ops-console.service');

    const bad = platformPaths('linux', '/home/a', { XDG_DATA_HOME: 'relative', XDG_STATE_HOME: '' });
    expect(bad.dataDir).toBe('/home/a/.local/share/ops-console');
    expect(bad.logFile).toBe('/home/a/.local/state/ops-console/daemon.log');
  });

  it.each(['darwin', 'linux'] as const)('lets OPS_CONSOLE_DATA_DIR name the data folder on %s', (platform) => {
    expect(platformPaths(platform, '/h', { OPS_CONSOLE_DATA_DIR: '/elsewhere' }).dataDir).toBe('/elsewhere');
  });
});

describe('systemdUnit', () => {
  const unit = systemdUnit({
    executable: '/home/a/.ops-console/current/node/bin/node',
    script: '/home/a/.ops-console/current/app/main.js',
    logFile: '/home/a/.local/state/ops-console/daemon.log',
    env: { PATH: '/usr/bin:/bin', OPS_CONSOLE_DATA_DIR: '/home/a/.local/share/ops-console', UV_THREADPOOL_SIZE: '16' },
  });

  it('restarts the daemon, starts it at login and appends its output to the log', () => {
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('StandardOutput=append:/home/a/.local/state/ops-console/daemon.log');
    expect(unit).toContain('StandardError=append:/home/a/.local/state/ops-console/daemon.log');
  });

  it('runs the absolute paths and sets each variable', () => {
    expect(unit).toContain(
      'ExecStart="/home/a/.ops-console/current/node/bin/node" "/home/a/.ops-console/current/app/main.js"',
    );
    expect(unit).toContain('Environment="PATH=/usr/bin:/bin"');
    expect(unit).toContain('Environment="OPS_CONSOLE_DATA_DIR=/home/a/.local/share/ops-console"');
  });

  it('quotes what systemd would otherwise expand: percent specifiers, $VAR in ExecStart, quotes and backslashes', () => {
    const odd = systemdUnit({
      executable: '/home/a b/$HOME/node',
      script: '/100%/main.js',
      logFile: '/state/100%/daemon.log',
      env: { PATH: '/a"b:/c\\d:/e%h' },
    });
    expect(odd).toContain('ExecStart="/home/a b/$$HOME/node" "/100%%/main.js"');
    expect(odd).toContain('Environment="PATH=/a\\"b:/c\\\\d:/e%%h"');
    expect(odd).toContain('StandardOutput=append:/state/100%%/daemon.log');
  });
});

describe('openPlan', () => {
  const url = 'http://127.0.0.1:1/#token=t';

  it('runs open on macOS, with -a for a named browser', () => {
    expect(openPlan({ platform: 'darwin', env: {}, url })).toEqual({ command: 'open', args: [url] });
    expect(openPlan({ platform: 'darwin', env: {}, url, browser: 'Firefox' })).toEqual({
      command: 'open',
      args: ['-a', 'Firefox', url],
    });
  });

  it.each([{ DISPLAY: ':0' }, { WAYLAND_DISPLAY: 'wayland-0' }])(
    'runs xdg-open on a Linux desktop: %o',
    async (display) => {
      const dir = await tempDir();
      await writeFile(path.join(dir, 'xdg-open'), '#!/bin/sh\n', { mode: 0o755 });
      expect(openPlan({ platform: 'linux', env: { ...display, PATH: dir }, url })).toEqual({
        command: 'xdg-open',
        args: [url],
      });
    },
  );

  it('names the reason when there is no desktop or no xdg-open', () => {
    expect(openPlan({ platform: 'linux', env: { PATH: '/usr/bin' }, url })).toEqual({
      none: 'No desktop session found',
    });
    expect(openPlan({ platform: 'linux', env: { DISPLAY: ':0', PATH: '/nonexistent' }, url })).toEqual({
      none: 'xdg-open is not installed',
    });
  });

  it('runs the browser the operator named when there is a desktop', () => {
    expect(openPlan({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, url, browser: 'firefox' })).toEqual({
      command: 'firefox',
      args: [url],
    });
  });
});
