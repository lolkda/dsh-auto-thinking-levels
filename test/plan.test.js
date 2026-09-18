import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LEVELS,
  mergeEfforts,
  planModels,
  planOverrides,
  plainObject,
  readOptions,
  summarize,
} from '../lib/plan.js';

const FULL = {
  off: null,
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

test('readOptions: defaults mean every provider, every model, seven levels', () => {
  const options = readOptions(undefined);
  assert.equal(options.namespace, 'llm-pi-ai');
  assert.equal(options.fill, 'complete');
  assert.deepEqual(options.levels, DEFAULT_LEVELS);
  assert.deepEqual(options.providers, []);
  assert.equal(options.enabled, true);
});

test('readOptions: a supplied field wins over its default', () => {
  const options = readOptions({ fill: 'missing', providers: ['cpa'], enabled: false });
  assert.equal(options.fill, 'missing');
  assert.deepEqual(options.providers, ['cpa']);
  assert.equal(options.enabled, false);
});

test('readOptions: rejects a config that is not a mapping', () => {
  assert.throws(() => readOptions('nope'), TypeError);
  assert.throws(() => readOptions(['nope']), TypeError);
});

test('readOptions: rejects each malformed field by name', () => {
  assert.throws(() => readOptions({ namespace: '' }), /config\.namespace/);
  assert.throws(() => readOptions({ fill: 'sometimes' }), /config\.fill/);
  assert.throws(() => readOptions({ levels: {} }), /config\.levels/);
  assert.throws(() => readOptions({ levels: { high: '' } }), /config\.levels\.high/);
  assert.throws(() => readOptions({ providers: 'cpa' }), /config\.providers/);
  assert.throws(() => readOptions({ providers: [1] }), /config\.providers/);
  assert.throws(() => readOptions({ enabled: 'yes' }), /config\.enabled/);
});

test('readOptions: rejects an unknown key rather than ignoring it', () => {
  assert.throws(() => readOptions({ fil: 'complete' }), /unknown config key\(s\): fil/);
});

test('readOptions: accepts null as a level value, meaning "send nothing"', () => {
  const options = readOptions({ levels: { off: null, high: 'ultra' } });
  assert.deepEqual(options.levels, { off: null, high: 'ultra' });
});

test('plainObject: only a plain data object counts', () => {
  assert.equal(plainObject({}), true);
  assert.equal(plainObject(Object.create(null)), true);
  assert.equal(plainObject([]), false);
  assert.equal(plainObject(null), false);
  assert.equal(plainObject('x'), false);
  assert.equal(plainObject(new Date()), false);
});

test('mergeEfforts: a model with no table gets the full set', () => {
  assert.deepEqual(mergeEfforts(undefined, readOptions(undefined)), FULL);
});

test('mergeEfforts: `false` is a declaration, never a gap to fill', () => {
  assert.equal(mergeEfforts(false, readOptions(undefined)), undefined);
  assert.equal(mergeEfforts(false, readOptions({ fill: 'complete' })), undefined);
});

test('mergeEfforts: fill=complete tops up a partial table, keeping the user spellings', () => {
  const merged = mergeEfforts({ off: null, high: 'ultra', max: 'max' }, readOptions(undefined));
  assert.deepEqual(merged, { ...FULL, high: 'ultra' });
});

test('mergeEfforts: fill=missing leaves a deliberate subset alone', () => {
  const options = readOptions({ fill: 'missing' });
  assert.equal(mergeEfforts({ off: null, high: 'high', max: 'max' }, options), undefined);
});

test('mergeEfforts: an already-complete table is not rewritten', () => {
  assert.equal(mergeEfforts(FULL, readOptions(undefined)), undefined);
  assert.equal(mergeEfforts({ ...FULL, extra: 'x' }, readOptions(undefined)), undefined);
});

test('mergeEfforts: a table that is not a mapping is left alone', () => {
  assert.equal(mergeEfforts('high', readOptions(undefined)), undefined);
  assert.equal(mergeEfforts([], readOptions(undefined)), undefined);
});

test('planModels: reports nothing to do when every entry is complete', () => {
  const added = [];
  const models = [{ id: 'a', reasoningEfforts: FULL }];
  assert.equal(planModels('cpa', models, readOptions(undefined), added), undefined);
  assert.deepEqual(added, []);
});

test('planModels: fills only the gaps and preserves every other field', () => {
  const added = [];
  const models = [
    { id: 'done', name: 'Done', contextWindow: 1, reasoningEfforts: FULL },
    { id: 'empty', name: 'Empty', input: ['text', 'image'] },
  ];
  const next = planModels('cpa', models, readOptions(undefined), added);
  assert.equal(next[0], models[0], 'an untouched entry keeps its identity');
  assert.deepEqual(next[1], { id: 'empty', name: 'Empty', input: ['text', 'image'], reasoningEfforts: FULL });
  assert.deepEqual(added, ['cpa/empty']);
});

test('planModels: a non-object entry is passed through untouched', () => {
  const next = planModels('cpa', [null, { id: 'a' }], readOptions(undefined), []);
  assert.equal(next[0], null);
  assert.deepEqual(next[1].reasoningEfforts, FULL);
});

test('planOverrides: fills one override per served model', () => {
  const added = [];
  const next = planOverrides('local', undefined, ['m1', 'm2'], readOptions(undefined), added);
  assert.deepEqual(next, {
    m1: { reasoningEfforts: FULL },
    m2: { reasoningEfforts: FULL },
  });
  assert.deepEqual(added, ['local/m1', 'local/m2']);
});

test('planOverrides: keeps existing overrides and their other fields', () => {
  const added = [];
  const existing = { m1: { name: 'One', reasoningEfforts: FULL } };
  const next = planOverrides('local', existing, ['m1', 'm2'], readOptions(undefined), added);
  assert.deepEqual(next.m1, { name: 'One', reasoningEfforts: FULL });
  assert.deepEqual(next.m2, { reasoningEfforts: FULL });
  assert.deepEqual(added, ['local/m2']);
});

test('planOverrides: ignores ids that are not usable keys', () => {
  const added = [];
  const next = planOverrides('local', undefined, ['ok', '', null, undefined, 7], readOptions(undefined), added);
  assert.deepEqual(Object.keys(next), ['ok']);
  assert.deepEqual(added, ['local/ok']);
});

test('summarize: keeps one log line one log line', () => {
  assert.equal(summarize(['a', 'b']), 'a, b');
  const many = Array.from({ length: 11 }, (_, i) => `m${i}`);
  assert.equal(summarize(many), 'm0, m1, m2, m3, m4, m5, m6, m7, +3 more');
});
