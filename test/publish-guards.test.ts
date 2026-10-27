import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/publish.yml', import.meta.url)), 'utf8');
type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { permissions?: Record<string, string>; steps: Step[]; needs?: string | string[]; environment?: string };
type Workflow = { permissions?: Record<string, string>; jobs: Record<string, Job> };
const parsed = parse(workflow) as Workflow;

function nodeScript(job: Job, name: string) {
  const step = job.steps.find((step) => step.name === name);
  expect(step, `missing step: ${name}`).toBeDefined();
  const match = /node --input-type=module <<'NODE'\n([\s\S]*?)^NODE$/m.exec(step!.run!);
  expect(match, `missing quoted Node heredoc: ${name}`).not.toBeNull();
  return match![1]!;
}

// Execute actual workflow scripts; never install dependencies or publish from these tests.
const npmGuard = nodeScript(parsed.jobs.publish!, 'Ensure npm supports trusted publishing');
const releaseGuard = nodeScript(parsed.jobs.build!, 'Verify release versions');

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

function checkPermissions(value: Workflow) {
  expect(value.permissions).toEqual({});
  expect(value.jobs.build!.permissions).toEqual({ contents: 'read' });
  expect(value.jobs.publish!.permissions).toEqual({ 'id-token': 'write', contents: 'read' });
  expect(Object.entries(value.jobs).filter(([, job]) => job.permissions?.['id-token'] === 'write')
    .map(([name]) => name)).toEqual(['publish']);
}

function checkPublisherSteps(value: Workflow) {
  for (const step of value.jobs.publish!.steps) {
    expect(step.uses ?? '').not.toMatch(/^actions\/checkout@/);
    expect(step.run ?? '').not.toMatch(/\b(?:npm\s+(?:ci|install)|npx|yarn|pnpm)\b/);
    expect(`${step.name ?? ''}\n${step.run ?? ''}`).not.toMatch(/\b(?:build|test|type-check)\b/i);
  }
}

function checkPublisherDependencies(value: Workflow) {
  const needs = value.jobs.publish!.needs;
  expect(typeof needs === 'string' ? [needs] : needs).toEqual(['build']);
}

function checkPublisherEnvironment(value: Workflow) {
  expect(value.jobs.publish!.environment).toBe('npm-publish');
}

function checkPins(value: Workflow) {
  for (const job of Object.values(value.jobs)) {
    for (const step of job.steps) {
      if (step.uses) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
    }
  }
}

// Exact npm bootstrap is the sole allowed install, using built-in tooling only.
function publisherWithoutBootstrap(value: Workflow) {
  const copy = structuredClone(value);
  const step = copy.jobs.publish!.steps.find((step) => step.name === 'Ensure npm supports trusted publishing')!;
  expect(step.run).toContain('npm install -g npm@11.21.1\n');
  step.run = step.run!.replace('npm install -g npm@11.21.1\n', '');
  return copy;
}

describe('publish workflow isolation', () => {
  it('grants OIDC only to publish, with empty root permissions', () => checkPermissions(parsed));
  it('keeps checkout, dependency installation, builds and tests out of publish', () => {
    checkPublisherSteps(publisherWithoutBootstrap(parsed));
  });
  it('requires the build artifact before publishing', () => checkPublisherDependencies(parsed));
  it('gates publishing on the npm-publish environment', () => checkPublisherEnvironment(parsed));
  it('pins every action in both jobs to a full commit SHA', () => checkPins(parsed));

  const mutations: [string, (value: Workflow) => void, (value: Workflow) => void][] = [
    ['add build OIDC', (value) => { value.jobs.build!.permissions!['id-token'] = 'write'; }, checkPermissions],
    ['add checkout', (value) => { value.jobs.publish!.steps.push({ uses: 'actions/checkout@' + 'a'.repeat(40) }); }, checkPublisherSteps],
    ['add npm ci', (value) => { value.jobs.publish!.steps.push({ run: 'npm ci' }); }, checkPublisherSteps],
    ['add npm install', (value) => { value.jobs.publish!.steps.push({ run: 'npm install malicious' }); }, checkPublisherSteps],
    ['add npx', (value) => { value.jobs.publish!.steps.push({ run: 'npx malicious' }); }, checkPublisherSteps],
    ['add yarn', (value) => { value.jobs.publish!.steps.push({ run: 'yarn install' }); }, checkPublisherSteps],
    ['add pnpm', (value) => { value.jobs.publish!.steps.push({ run: 'pnpm install' }); }, checkPublisherSteps],
    ['add build', (value) => { value.jobs.publish!.steps.push({ run: 'npm run build' }); }, checkPublisherSteps],
    ['add test', (value) => { value.jobs.publish!.steps.push({ run: 'npm test' }); }, checkPublisherSteps],
    ['unpin build action', (value) => { value.jobs.build!.steps.find((step) => step.uses)!.uses = 'actions/checkout@v7'; }, checkPins],
    ['unpin publish action', (value) => { value.jobs.publish!.steps.find((step) => step.uses)!.uses = 'actions/download-artifact@v4'; }, checkPins],
    ['drop needs', (value) => { delete value.jobs.publish!.needs; }, checkPublisherDependencies],
    ['drop environment', (value) => { delete value.jobs.publish!.environment; }, checkPublisherEnvironment],
  ];
  it.each(mutations)('detects negative mutation: %s', (_name, mutate, check) => {
    const original = publisherWithoutBootstrap(parsed);
    checkPermissions(original);
    checkPublisherSteps(original);
    checkPublisherDependencies(original);
    checkPublisherEnvironment(original);
    checkPins(original);
    const mutated = structuredClone(original);
    mutate(mutated);
    expect(mutated).not.toEqual(original); // Assert the mutation applied before expecting red.
    expect(() => check(mutated)).toThrow();
  });
});

function runTarball(script: string, tag = 'v0.3.2', name = 'hellohop-mcp', extraFile = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'publish-tarball-'));
  try {
    const fixture = join(cwd, 'fixture');
    const artifact = join(cwd, 'artifact');
    mkdirSync(join(fixture, 'package'), { recursive: true });
    mkdirSync(artifact);
    writeFileSync(join(fixture, 'package/package.json'), JSON.stringify({
      name, version: '0.3.2',
      scripts: { prepublishOnly: 'node index.js', prepare: 'node index.js', postinstall: 'node index.js' },
    }));
    // A lifecycle script must never run during manifest validation.
    writeFileSync(join(fixture, 'package/index.js'), 'throw new Error("must never execute tarball code");');
    const packed = spawnSync('tar', ['-czf', join(artifact, 'hellohop-mcp-0.3.2.tgz'), '-C', fixture, 'package'], {
      encoding: 'utf8', timeout: 5000,
    });
    expect(packed.status).toBe(0);
    if (extraFile) writeFileSync(join(artifact, '.unexpected'), 'extra artifact file');
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      cwd: artifact, input: script, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, RELEASE_TAG: tag },
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return result;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('publish tarball guard', () => {
  const script = () => nodeScript(parsed.jobs.publish!, 'Verify tarball release');
  it('accepts one tarball with the expected name and exact tag', () => {
    expect(runTarball(script()).status).toBe(0);
  });
  it.each([
    ['mismatching tag', 'v0.3.3', 'hellohop-mcp', false, tagCheck, 'false', 'Tarball name and version must match the release tag'],
    ['suffix tag', 'v0.3.2-rc1', 'hellohop-mcp', false, tagCheck, '!process.env.RELEASE_TAG.startsWith(`v${pkg.version}`)', 'Tarball name and version must match the release tag'],
    ['wrong name', 'v0.3.2', 'other-package', false, "pkg.name !== 'hellohop-mcp'", 'false', 'Tarball name and version must match the release tag'],
    ['multi-file artifact', 'v0.3.2', 'hellohop-mcp', true, 'files.length !== 1', 'false', 'Artifact must contain exactly one regular .tgz file'],
  ] as const)('rejects %s and detects a bypassed check', (_name, tag, name, extra, before, after, message) => {
    const rejected = runTarball(script(), tag, name, extra);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(message);
    expect(runTarball(weaken(script(), before, after), tag, name, extra).status).toBe(0);
  });
});
