// The name comes from ONE constant, and new text stays within the drafting
// rules: no em dash, and no hardcoded product name.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BRAND, SERVER_VERSION } from '../src/brand.js';
import { ENV } from '../src/config.js';
import { baseConfig, connect, fakeFetch } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  private?: boolean;
  bin?: Record<string, string>;
};

// Every authored file in the package: README, sources, tests, configs.
// Generated and vendored trees are skipped.
const SKIP_DIRS = new Set(['node_modules', 'dist']);
const SKIP_FILES = new Set(['package-lock.json']);
function authoredFiles(dir: string = ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...authoredFiles(full));
    } else if (!SKIP_FILES.has(entry)) {
      out.push(full);
    }
  }
  return out;
}

const EM_DASH = String.fromCharCode(0x2014);

function filesContaining(files: string[], test: (text: string, file: string) => boolean): string[] {
  return files.filter((f) => test(readFileSync(f, 'utf8'), relative(ROOT, f))).map((f) => relative(ROOT, f));
}

describe('brand constant', () => {
  it('package.json name equals the constant, and the package is public', () => {
    expect(pkg.name).toBe('hellohop-mcp');
    expect(pkg.name).toBe(BRAND.packageName);
    expect(pkg.version).toBe('0.3.1');
    expect(pkg.private).toBeUndefined();
    expect(Object.keys(pkg.bin ?? {})).toEqual([BRAND.binName]);
  });

  it('pins the release version in the lockfile and server constant', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
      name: string;
      version: string;
      packages: Record<string, { name: string; version: string }>;
    };
    expect(lock.name).toBe('hellohop-mcp');
    expect(lock.packages['']!.name).toBe('hellohop-mcp');
    expect(lock.version).toBe('0.3.1');
    expect(lock.packages['']!.version).toBe('0.3.1');
    expect(SERVER_VERSION).toBe('0.3.1');
  });

  it('the MCP server is constructed with the constant (as a client sees it)', async () => {
    const { fetch } = fakeFetch();
    const client = await connect(baseConfig(), fetch);
    expect(client.getServerVersion()).toEqual({ name: BRAND.packageName, version: SERVER_VERSION });
    expect(client.getServerVersion()?.name).toBe(pkg.name);
  });

  it('no authored file hardcodes the working product name', () => {
    const files = authoredFiles();
    // Positive control on the walk: it reached the files that matter.
    const rel = files.map((f) => relative(ROOT, f));
    expect(rel).toContain('README.md');
    expect(rel).toContain('CHANGELOG.md');
    expect(rel).toContain(join('src', 'brand.ts'));
    expect(rel).toContain(join('src', 'server.ts'));
    // Built from parts so this file does not match itself.
    const name = new RegExp(['wa', 'gate'].join(''), 'i');
    expect(name.test('the W' + 'Agate API')).toBe(true);
    // The settled package and command names are the only allowed spellings.
    const strip = (t: string) =>
      [BRAND.packageName, BRAND.binName, BRAND.publicApiUrl, BRAND.docsUrl, BRAND.siteUrl, BRAND.mcpName].reduce(
        (s, a) => s.split(a).join(''),
        t,
      );
    expect(strip('x ' + BRAND.packageName + ' ' + BRAND.binName)).not.toMatch(name);
    // The settled brand is published in the distribution metadata on purpose
    // (the registry listing and the npm page); source and tests stay clean.
    const METADATA = new Set(['README.md', 'package.json', 'server.json']);
    const scanned = files.filter((f) => !METADATA.has(relative(ROOT, f)));
    expect(scanned.map((f) => relative(ROOT, f))).toContain('CHANGELOG.md');
    expect(scanned.length).toBeGreaterThan(5);
    // No file may name the old brand, the changelog included (RAMOW, owner 2026-10-24).
    expect(filesContaining(scanned, (t) => name.test(strip(t)))).toEqual([]);
  });

  it('package.json publishes the HelloHop homepage and repository links', () => {
    const full = pkg as unknown as Record<string, unknown>;
    expect(full.homepage).toBe(BRAND.siteUrl);
    expect(full.mcpName).toBe(BRAND.mcpName);
    expect(full.repository).toEqual({
      type: 'git',
      url: 'https://github.com/socialgroundco/hellohop-mcp',
    });
    expect(full.bugs).toEqual({ url: 'https://github.com/socialgroundco/hellohop-mcp/issues' });
  });

  it('the README shows the package name from the constant', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain(BRAND.packageName);
    expect(readme).toContain(BRAND.publicApiUrl);
    expect(readme).not.toContain('example.test');
  });
});

describe('registry manifest', () => {
  const server = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8')) as {
    name: string;
    description: string;
    version: string;
    packages: { identifier: string; version: string; transport: { type: string }; environmentVariables: { name: string; isSecret?: boolean }[] }[];
  };
  it('matches package.json and the registry limits', () => {
    expect(server.name).toBe('app.hellohop/hellohop');
    expect(server.name).toBe(BRAND.mcpName);
    expect(server.version).toBe('0.3.1');
    expect(server.description.length).toBeLessThanOrEqual(100);
    const p = server.packages[0]!;
    expect(p.identifier).toBe('hellohop-mcp');
    expect(p.identifier).toBe(pkg.name);
    expect(p.version).toBe('0.3.1');
    expect(p.transport.type).toBe('stdio');
    expect(p.environmentVariables.find((v) => v.name === ENV.token)?.isSecret).toBe(true);
    expect(p.environmentVariables.map((v) => v.name).sort()).toEqual(Object.values(ENV).sort());
  });
});

describe('drafting rules', () => {
  it('no em dash in README, src, tests or configs', () => {
    const files = authoredFiles();
    // Positive controls: the walk covers README and src, and the check
    // detects the character.
    const rel = files.map((f) => relative(ROOT, f));
    expect(rel).toContain('README.md');
    expect(rel.filter((f) => f.startsWith('src')).length).toBeGreaterThan(3);
    expect(`a ${EM_DASH} b`.includes(EM_DASH)).toBe(true);
    expect(filesContaining(files, (t) => t.includes(EM_DASH))).toEqual([]);
  });
});
