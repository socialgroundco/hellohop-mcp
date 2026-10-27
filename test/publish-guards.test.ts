import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/publish.yml', import.meta.url)), 'utf8');
// Execute the actual quoted heredocs, without installing or publishing anything.
const scripts = [...workflow.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)^          NODE$/gm)]
  .map((match) => match[1]!.replace(/^          /gm, ''));
expect(scripts).toHaveLength(2);
const [npmGuard, releaseGuard] = scripts as [string, string];

function run(script: string, tag = 'v0.3.2', serverVersion = '0.3.2', npmVersion = '11.5.1') {
  const cwd = mkdtempSync(join(tmpdir(), 'publish-guard-'));
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: '0.3.2' }));
    writeFileSync(join(cwd, 'server.json'), JSON.stringify({ version: serverVersion }));
    writeFileSync(join(cwd, 'npm'), '#!/bin/sh\nprintf \'%s\\n\' "$GUARD_NPM_OUTPUT"\n', { mode: 0o700 });
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      cwd,
      input: script,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, PATH: `${cwd}:${process.env.PATH}`, RELEASE_TAG: tag, GUARD_NPM_OUTPUT: npmVersion },
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return result;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// A mutation must apply exactly once; a no-op cannot masquerade as coverage.
function weaken(script: string, before: string, after: string) {
  expect(script.split(before)).toHaveLength(2);
  const mutated = script.replace(before, after);
  expect(mutated).not.toBe(script);
  return mutated;
}

const tagCheck = 'process.env.RELEASE_TAG !== `v${pkg.version}`';
const npmCheck = '!match || major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))';

describe('publish release guard', () => {
  it('accepts v0.3.2 with matching files', () => {
    expect(run(releaseGuard).status).toBe(0);
  });

  it.each([
    ['suffix', 'v0.3.2-rc1', '!process.env.RELEASE_TAG.startsWith(`v${pkg.version}`)'],
    ['v-less', '0.3.2', 'process.env.RELEASE_TAG !== pkg.version && ' + tagCheck],
    ['prefix-only', 'v0.3.20', '!process.env.RELEASE_TAG.startsWith(`v${pkg.version}`)'],
  ])('rejects a %s tag and detects a weakened comparison', (_name, tag, replacement) => {
    const rejected = run(releaseGuard, tag);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('Release tag, package.json version and server.json version must match');
    expect(run(weaken(releaseGuard, tagCheck, replacement), tag).status).toBe(0);
  });

  it('rejects a server.json mismatch and detects a removed comparison', () => {
    const rejected = run(releaseGuard, 'v0.3.2', '0.3.3');
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('Release tag, package.json version and server.json version must match');
    expect(run(weaken(releaseGuard, 'server.version !== pkg.version', 'false'), 'v0.3.2', '0.3.3').status).toBe(0);
  });
});

describe('publish npm guard', () => {
  it.each(['11.5.1', '11.5.2', '11.6.0', '12.0.0'])('accepts stable npm %s', (version) => {
    expect(run(npmGuard, undefined, undefined, version).status).toBe(0);
  });

  it.each(['10.99.99', '11.4.99', '11.5.0', '', 'garbage', '11.5', '11.5.1-rc1', '11.5.1+build'])
    ('rejects old or malformed npm %j and detects a bypassed guard', (version) => {
      const rejected = run(npmGuard, undefined, undefined, version);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('below the required stable version 11.5.1');
      expect(run(weaken(npmGuard, npmCheck, 'false'), undefined, undefined, version).status).toBe(0);
    });
});
