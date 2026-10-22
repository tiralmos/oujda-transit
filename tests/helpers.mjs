// Builds network.json from the repository's CSVs once per test run.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let cached;
export function network() {
  if (!cached) {
    const out = mkdtempSync(join(tmpdir(), 'oujda-'));
    execFileSync('python3', [join(ROOT, 'tools', 'build_data.py'), join(ROOT, 'data'), out], { stdio: 'pipe' });
    cached = JSON.parse(readFileSync(join(out, 'network.json'), 'utf8'));
  }
  return cached;
}
