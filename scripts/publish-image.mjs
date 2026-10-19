#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { metadata } from './image-tags.mjs';

const { values } = parseArgs({ options: {
  version: { type: 'string', default: '' },
  push: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('node scripts/publish-image.mjs [--version 0.1.0] [--push]\nDefault: print build command only. Requires clean checkout; release requires matching v-tag.');
  process.exit(0);
}
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const { sha, tags } = metadata(values.version);
const image = 'ghcr.io/l92-labs/db-mcp';
const args = ['buildx', 'build', '--platform', 'linux/amd64,linux/arm64', '--push',
  '--provenance=mode=min', '--sbom=true',
  '--label', 'org.opencontainers.image.source=https://github.com/L92-Labs/db-mcp',
  '--label', `org.opencontainers.image.revision=${sha}`,
  '--label', 'org.opencontainers.image.licenses=MIT'];
if (values.version) args.push('--label', `org.opencontainers.image.version=${values.version}`);
for (const tag of tags) args.push('--tag', `${image}:${tag}`);
args.push('.');
console.log(`docker ${args.join(' ')}`);
if (values.push) execFileSync('docker', args, { stdio: 'inherit' });
else console.log('Dry run. Add --push after validation and docker login ghcr.io.');
