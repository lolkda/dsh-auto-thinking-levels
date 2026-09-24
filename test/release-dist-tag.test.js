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

/** The step that proves npm trusts this workflow before a release is spent. */
const OIDC_PREFLIGHT_STEP = 'Prove npm trusts this workflow before spending a release on it';

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
 * Run one workflow step script in a throwaway directory.
 * @param options - the step name, the declared package.json fields, and extra env.
 * @returns the exit status and both streams.
 */
function runScript({ name, pkg = { name: 'dsh-auto-thinking-levels', version: '0.1.1' }, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'release-step-'));
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg)}\n`);
  const result = spawnSync('bash', ['-c', stepScript(name)], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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

test('the publish step is handed the derived tag and mints its own credential', () => {
  const publish = stepScript(PUBLISH_STEP);
  assert.match(publish, /npm publish "\$\{args\[@\]\}"/);
  assert.match(publish, /--tag "\$TAG"/);
  assert.match(publish, /args\+=\(--dry-run\)/);

  // Trusted publishing: the credential is the job's OIDC identity, so nothing
  // may thread a token in — a stored token here would silently shadow OIDC.
  assert.doesNotMatch(publish, /NODE_AUTH_TOKEN/);
  const yaml = readFileSync(WORKFLOW, 'utf8');
  assert.doesNotMatch(yaml, /secrets\.NPM_TOKEN/);
  assert.doesNotMatch(yaml, /NODE_AUTH_TOKEN/);
  assert.match(yaml, /id-token: write/);
});

test('the OIDC preflight refuses to run without an id-token', () => {
  // Blank rather than deleted: `runScript` merges over process.env, and on a
  // GitHub runner these two are genuinely set, so deleting them would not stick.
  const { status, stdout } = runScript({
    name: OIDC_PREFLIGHT_STEP,
    env: { ACTIONS_ID_TOKEN_REQUEST_URL: '', ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' },
  });
  assert.equal(status, 1);
  assert.match(stdout, /::error::this job cannot mint an OIDC token/);
});

test('the OIDC preflight accepts any 2xx, because npm answers the exchange with 201', () => {
  const script = stepScript(OIDC_PREFLIGHT_STEP);
  assert.match(script, /if \[\[ "\$status" != 2\* \]\]; then/);
  assert.doesNotMatch(script, /!= "200"/);
});

test('the OIDC preflight never prints the exchanged token, and says what to register', () => {
  const script = stepScript(OIDC_PREFLIGHT_STEP);
  assert.match(script, /oidc\/token\/exchange\/package\/\$\{package\}/);
  assert.match(script, /npmjs\.com\/package\/\$\{package\}\/access/);
  assert.match(script, /owner lolkda, repository dsh-auto-thinking-levels, workflow publish\.yml/);
  assert.match(script, /npm accepted the OIDC token exchange for \$\{package\}/);

  // The 2xx body is a live short-lived npm token: never dumped, and removed
  // after use. On failure only npm's own `message` field is echoed.
  assert.doesNotMatch(script, /cat \/tmp\/oidc-exchange\.json/);
  assert.match(script, /jq -r '\.message \/\/ empty' \/tmp\/oidc-exchange\.json/);
  assert.match(script, /rm -f \/tmp\/oidc-exchange\.json/);
});
