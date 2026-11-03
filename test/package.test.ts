import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

it('packs executable JavaScript without source maps or the removed private-path comment', () => {
  execFileSync('npm', ['run', 'build', '--silent'], { cwd: root, stdio: 'pipe' });
  // A previous build can leave maps behind. The publish allowlist must exclude
  // those too, independently of the compiler's sourceMap setting.
  const staleMap = path.join(root, 'dist', 'package-test-stale.js.map');
  writeFileSync(staleMap, '{}\n', { flag: 'wx' });
  try {
    expect(readFileSync(staleMap, 'utf8')).toBe('{}\n');
    const result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root, encoding: 'utf8', stdio: 'pipe',
    })) as { files: { path: string }[] }[];
    expect(result).toHaveLength(1);
    const files = result[0]!.files.map(file => file.path);
    // A package that ships nothing must not satisfy the exclusions below.
    expect(files).toEqual(expect.arrayContaining(['package.json', 'README.md', 'dist/index.js', 'dist/client.js']));
    expect(files.filter(file => file.endsWith('.map'))).toEqual([]);
    const javascript = files.filter(file => file.endsWith('.js'));
    expect(javascript.length).toBeGreaterThan(3);
    for (const file of javascript) {
      const source = readFileSync(path.join(root, file), 'utf8');
      expect(source, file).not.toContain('sourceMappingURL=');
      // Deliberately removed implementation reference: it must stay absent.
      // Split so the package's authored-file scan does not introduce the name.
      expect(source, file).not.toContain(['internal', 'edge', 'policy.go'].join('/'));
    }
  } finally {
    unlinkSync(staleMap);
  }
}, 30_000);
