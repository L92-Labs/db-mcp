import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Build metadata is excluded: '+' is not valid in Docker tags.
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
export function imageTags({ sha, version = '', packageVersion, stableVersions = [] }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Expected full Git commit SHA');
  const tags = [`sha-${sha}`];
  if (!version) return tags;
  if (!versionPattern.test(version) || version.length > 128) throw new Error('Invalid image SemVer');
  if (version !== packageVersion) throw new Error('Release must match root package.json version');
  tags.push(version);
  if (!version.includes('-')) {
    const newer = stableVersions.filter(v => versionPattern.test(v) && !v.includes('-')).some(v => {
      const a = v.split('.').map(BigInt), b = version.split('.').map(BigInt);
      for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
      return false;
    });
    if (!newer) tags.push('latest');
  }
  return tags;
}

export function metadata(version = '') {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const sha = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain')) throw new Error('Commit or remove local changes before publishing');
  if (version && git('rev-list', '-n', '1', `v${version}`) !== sha) {
    throw new Error('Release tag must point at HEAD');
  }
  const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
  return { sha, tags: imageTags({ sha, version, packageVersion,
    stableVersions: git('tag', '--list', 'v*').split('\n').map(v => v.slice(1)) }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(metadata(process.argv[2] ?? '')));
}
