import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bareMachine, brewEntry, makeRelease, REPO, tempDir } from './helpers';

const render = async (input: Record<string, string>) => {
  const { renderFormula } = (await import(path.join(REPO, 'scripts/homebrew/render.mjs'))) as {
    renderFormula(input: Record<string, string>): Promise<string>;
  };
  return renderFormula(input);
};

const arm = 'a'.repeat(64);
const intel = 'b'.repeat(64);

describe('the rendered formula', () => {
  it('names the release version, both tarball URLs and both sha256 values', async () => {
    const formula = await render({ version: '2.3.4', sha256Arm64: arm, sha256X64: intel });

    expect(formula).toContain(
      'url "https://github.com/narrowananth/ops-console/releases/download/v2.3.4/ops-console-darwin-arm64.tar.gz"',
    );
    expect(formula).toContain(
      'url "https://github.com/narrowananth/ops-console/releases/download/v2.3.4/ops-console-darwin-x64.tar.gz"',
    );
    expect(formula).toContain(`sha256 "${arm}"`);
    expect(formula).toContain(`sha256 "${intel}"`);
    expect(formula).not.toContain('{{');
  });

  it('is valid Ruby', async () => {
    const formula = await render({ version: '2.3.4', sha256Arm64: arm, sha256X64: intel });
    const syntax = spawnSync('ruby', ['-c'], { input: formula, encoding: 'utf8' });

    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it('refuses a version or sha256 that is not what a release makes', async () => {
    await expect(render({ version: 'latest', sha256Arm64: arm, sha256X64: intel })).rejects.toThrow(/version/);
    await expect(render({ version: '2.3.4', sha256Arm64: 'xyz', sha256X64: intel })).rejects.toThrow(/sha256/);
  });

  it('stages a Cellar the entry command installs from, and writes nothing under the home folder', async () => {
    const release = await makeRelease('1.0.0');
    const tarball = 'ops-console-darwin-arm64.tar.gz';
    const sum = (await readFile(path.join(release, 'checksums.txt'), 'utf8')).split(' ')[0] ?? '';
    const formula = await render({ version: '1.0.0', sha256Arm64: sum, sha256X64: intel });
    const work = await tempDir('formula-');
    const build = path.join(work, 'build');
    const prefix = path.join(work, 'prefix');
    const home = path.join(work, 'home');
    await Promise.all([mkdir(build), mkdir(prefix), mkdir(home)]);
    await cp(path.join(release, tarball), path.join(build, tarball));
    await writeFile(path.join(work, 'ops-console.rb'), formula);
    // The few Homebrew helpers the install step uses, so its own code runs.
    const harness = `
      require 'fileutils'; require 'pathname'; require 'digest'
      include FileUtils
      class Pathname
        def install(src); mkpath; FileUtils.mv(src, self + File.basename(src)); end
        def write(text); dirname.mkpath; File.write(self, text); end
      end
      class Formula
        def self.method_missing(*); end
        def self.respond_to_missing?(*); true; end
        def self.test(*); end
        def version; '1.0.0'; end
        def libexec; Pathname.new(ENV.fetch('PREFIX')) + 'libexec'; end
        def bin; Pathname.new(ENV.fetch('PREFIX')) + 'bin'; end
        def system(*args); Kernel.system(*args.map(&:to_s)) or raise "failed: #{args.inspect}"; end
      end
      load ARGV[0]
      Dir.chdir(ARGV[1]) { OpsConsole.new.install }
    `;
    const staged = spawnSync('ruby', ['-e', harness, path.join(work, 'ops-console.rb'), build], {
      env: { ...process.env, PREFIX: prefix, HOME: home },
      encoding: 'utf8',
    });
    expect(staged.status, staged.stderr).toBe(0);
    expect(await readdir(home)).toEqual([]);
    expect(await readFile(path.join(prefix, 'bin/ops-console'), 'utf8')).toBe(
      await readFile(path.join(REPO, 'scripts/homebrew/entry.sh'), 'utf8'),
    );

    const m = await bareMachine(0);
    const result = await brewEntry({ prefix, entry: path.join(prefix, 'bin/ops-console') }, m, ['--version']);

    expect(result.code).toBe(0);
    expect(result.stdout.trim().split('\n').pop()).toBe('1.0.0');
  });
});
