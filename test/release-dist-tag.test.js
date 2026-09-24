/**
 * The release workflow's dist-tag derivation.
 *
 * `npm publish` refuses to ship a prerelease without an explicit `--tag`
 * ("You must specify a tag using --tag when publishing a prerelease version"),
 * so the dist-tag has to be derived from the version instead of left implicit —
 * and an rc must never land on `latest`, or every `npm i` would pull a release
 * candidate.
 *
 * These tests execute the workflow's own step script, extracted from the YAML
 * rather than copied, so the shell that ships is the shell that is proven.
 *
 * @module dsh-auto-thinking-levels/test/release-dist-tag
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/** The workflow under test. */
const WORKFLOW = new URL('../.github/workflows/publish.yml', import.meta.url);

/** The step that turns a version into a dist-tag. */
const RESOLVE_STEP = 'Resolve version, dist-tag and tarball name';

/** The step that actually publishes. */
const PUBLISH_STEP = 'Publish';

/**
 * Pull one step's `run: |` block out of the workflow so it can be executed.
 * @param name - the step's `name:` value.
 * @returns the block's shell script, dedented.
 */
function stepScript(name) {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `no workflow step named "${name}"`);
  const runAt = lines.findIndex((line, i) => i > start && /^\s*run: \|\s*$/.test(line));
  assert.notEqual(runAt, -1, `step "${name}" has no block \`run:\``);

  const runIndent = lines[runAt].length - lines[runAt].trimStart().length;
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length <= runIndent) break;
    body.push(line);
  }
  while (body.length > 0 && body.at(-1).trim() === '') body.pop();

  const contentIndent = Math.min(
    ...body.filter((line) => line.trim() !== '').map((line) => line.length - line.trimStart().length),
  );
  return body.map((line) => line.slice(contentIndent)).join('\n');
}

/**
 * Run a workflow step against a throwaway package.json and a simulated ref.
 * @param options - the declared version and the GitHub ref to simulate.
 * @returns the exit status, both streams, and the parsed `GITHUB_OUTPUT` keys.
 */
function runStep({ version, refType, refName }) {
  const dir = mkdtempSync(join(tmpdir(), 'dist-tag-'));
  const outputFile = join(dir, 'github_output');
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh-auto-thinking-levels', version })}\n`);
  writeFileSync(outputFile, '');

  const result = spawnSync('bash', ['-c', stepScript(RESOLVE_STEP)], {
    cwd: dir,
    env: { ...process.env, GITHUB_REF_TYPE: refType, GITHUB_REF_NAME: refName, GITHUB_OUTPUT: outputFile },
    encoding: 'utf8',
  });
  const outputs = Object.fromEntries(
    readFileSync(outputFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outputs };
}

test('a stable version ships under latest', () => {
  const { status, outputs } = runStep({ version: '0.1.1', refType: 'tag', refName: 'v0.1.1' });
  assert.equal(status, 0);
  assert.equal(outputs.tag, 'latest');
  assert.equal(outputs.prerelease, 'false');
  assert.equal(outputs.version, '0.1.1');
});

test('an rc is published under rc, never under latest', () => {
  const { status, outputs } = runStep({ version: '0.1.1-rc.1', refType: 'tag', refName: 'v0.1.1-rc.1' });
  assert.equal(status, 0);
  assert.equal(outputs.tag, 'rc');
  assert.equal(outputs.prerelease, 'true');
});

test('every prerelease identifier keeps its own dist-tag', () => {
  for (const [version, tag] of [
    ['3.0.0-alpha.1', 'alpha'],
    ['1.0.0-beta.2', 'beta'],
    ['0.2.0-rc.3', 'rc'],
    ['2.0.0-next', 'next'],
    ['2.0.0-canary.7', 'canary'],
    ['1.2.3-dev', 'dev'],
  ]) {
    const { status, outputs } = runStep({ version, refType: 'tag', refName: `v${version}` });
    assert.equal(status, 0, `${version} failed: ${outputs.tag}`);
    assert.equal(outputs.tag, tag);
    assert.equal(outputs.prerelease, 'true');
  }
});

test('an unrecognised prerelease id falls back to next, with a warning', () => {
  const { status, outputs, stdout } = runStep({ version: '1.0.0-preview.3', refType: 'tag', refName: 'v1.0.0-preview.3' });
  assert.equal(status, 0);
  assert.equal(outputs.tag, 'next');
  assert.match(stdout, /unrecognised prerelease id 'preview'/);
});

test('a tag that does not name the version fails the run', () => {
  const { status, stdout } = runStep({ version: '0.1.1', refType: 'tag', refName: 'v0.1.2' });
  assert.equal(status, 1);
  assert.match(stdout, /::error::tag v0\.1\.2 does not match package\.json version 0\.1\.1/);
});

test('a manual dispatch skips the tag check but still derives the tag', () => {
  const { status, outputs } = runStep({ version: '0.1.1-rc.1', refType: 'branch', refName: 'main' });
  assert.equal(status, 0);
  assert.equal(outputs.tag, 'rc');
  assert.equal(outputs.prerelease, 'true');
});

test('the publish step is handed the derived tag and the token', () => {
  const publish = stepScript(PUBLISH_STEP);
  assert.match(publish, /npm publish "\$\{args\[@\]\}"/);
  assert.match(publish, /--tag "\$TAG"/);
  assert.match(publish, /args\+=\(--dry-run\)/);

  const yaml = readFileSync(WORKFLOW, 'utf8');
  assert.match(yaml, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
});
