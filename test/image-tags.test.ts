import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Release helper runs directly in Node, outside TypeScript build.
import { imageTags } from '../scripts/image-tags.mjs';
const sha = 'a'.repeat(40);
describe('container release policy', () => {
  it('publishes main commits by full SHA only', () => {
    expect(imageTags({ sha })).toEqual([`sha-${sha}`]);
  });
  it('publishes stable version and latest together', () => {
    expect(imageTags({ sha, version: '0.2.0', packageVersion: '0.2.0' })).toEqual([`sha-${sha}`, '0.2.0', 'latest']);
  });
  it('keeps prereleases and older release backfills off latest', () => {
    expect(imageTags({ sha, version: '0.3.0-rc.1', packageVersion: '0.3.0-rc.1' })).not.toContain('latest');
    expect(imageTags({ sha, version: '0.2.9', packageVersion: '0.2.9', stableVersions: ['0.10.0'] })).not.toContain('latest');
  });
  it('rejects mismatched versions and invalid tags', () => {
    expect(() => imageTags({ sha, version: '0.3.0', packageVersion: '0.2.0' })).toThrow();
    for (const version of ['01.2.0', '1.2.3+build', '1.2.3-01', 'latest', '1.2']) {
      expect(() => imageTags({ sha, version, packageVersion: version })).toThrow();
    }
    expect(() => imageTags({ sha: 'abc' })).toThrow();
  });
});

it('validates release metadata against a real Git checkout', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'db-mcp-release-test-'));
  const helper = fileURLToPath(new URL('../scripts/image-tags.mjs', import.meta.url));
  const options = { cwd, encoding: 'utf8' as const, stdio: 'pipe' as const };
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', ...args,
  ], options).trim();
  const metadata = (version = '') => JSON.parse(execFileSync(process.execPath, [helper, version], options));
  const pkg = join(cwd, 'package.json');
  try {
    git('init', '-q');
    writeFileSync(pkg, '{"version":"0.1.0"}');
    git('add', 'package.json');
    git('commit', '-qm', 'fixture');
    const commit = git('rev-parse', 'HEAD');
    expect(metadata().tags).toEqual([`sha-${commit}`]);
    expect(() => metadata('0.1.0')).toThrow(/unknown revision|ambiguous argument/);
    git('tag', '-a', 'v0.1.0', '-m', 'release fixture');
    expect(metadata('0.1.0').tags).toEqual([`sha-${commit}`, '0.1.0', 'latest']);
    writeFileSync(join(cwd, 'dirty.txt'), 'untracked');
    expect(() => metadata()).toThrow(/local changes/);
    unlinkSync(join(cwd, 'dirty.txt'));
    writeFileSync(pkg, '{"version":"0.2.0"}');
    expect(() => metadata()).toThrow(/local changes/);
    git('add', 'package.json');
    git('commit', '-qm', 'next fixture');
    expect(() => metadata('0.1.0')).toThrow(/point at HEAD/);
    git('tag', 'v0.1.1');
    expect(() => metadata('0.1.1')).toThrow(/match root package/);
    git('tag', '-a', 'v0.2.0', '-m', 'next release');
    git('tag', 'v0.10.0');
    expect(metadata('0.2.0').tags).not.toContain('latest');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
