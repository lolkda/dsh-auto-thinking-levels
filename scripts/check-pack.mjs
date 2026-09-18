#!/usr/bin/env node
/**
 * Assert the published artifact.
 *
 * What `npm publish` would ship is the contract, so the file list is checked
 * rather than trusted: a required file going missing, or a stray one (tests,
 * verification evidence, scratch directories) slipping in, fails here instead
 * of after a release.
 */
import { execSync } from 'node:child_process';

/** Files the package must contain. */
const REQUIRED = [
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'index.js',
  'lib/plan.js',
  'package.json',
];

/** Path prefixes that must never be published. */
const FORBIDDEN_PREFIXES = ['test/', 'scripts/', 'verification/', 'probe'];

/** npm prints the report as JSON on stdout; tolerate leading notices. */
function readReport(raw) {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error(`npm pack produced no JSON report:\n${raw}`);
  return JSON.parse(raw.slice(start, end + 1));
}

const report = readReport(execSync('npm pack --dry-run --json', { encoding: 'utf8' }));
if (report.length !== 1) throw new Error(`expected one pack report, got ${report.length}`);

const files = report[0].files.map((entry) => entry.path).sort();
const missing = REQUIRED.filter((path) => !files.includes(path));
const stray = files.filter((path) => FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)));

if (missing.length > 0 || stray.length > 0) {
  if (missing.length > 0) console.error('missing from the tarball:', missing.join(', '));
  if (stray.length > 0) console.error('must not be in the tarball:', stray.join(', '));
  process.exit(1);
}

console.log(`tarball ok: ${report[0].entryCount} files, ${report[0].size} bytes`);
for (const path of files) console.log(`  ${path}`);
