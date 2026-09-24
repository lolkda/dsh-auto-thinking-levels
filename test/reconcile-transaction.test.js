import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';

import { apply } from '../index.js';

const FULL = {
  off: null,
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};
const EVENT = 'settings/document-updated';

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Model DSH's settings boundary, including its real AsyncLocalStorage guard.
 * Config writes and their notifications run inside serialized HMR transactions;
 * a nested write rejects before changing the document. Merely deferring a
 * callback with a timer/microtask does not escape this async context.
 */
function harness(t, models) {
  const executing = new AsyncLocalStorage();
  let operations = Promise.resolve();
  const hmr = {
    executing,
    runExclusive(operation) {
      if (executing.getStore()) return Promise.reject(new Error('HMR transactions cannot be nested'));
      const task = operations.then(() => executing.run(true, operation));
      operations = task.catch(() => {});
      return task;
    },
  };
  const listeners = new Map();
  const disposers = [];
  const warnings = [];
  let revision = 1;
  let current = structuredClone(models);
  let writes = 0;
  const emit = (event, ...args) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const settings = {
    describe() {
      const section = { providers: { cpa: { models: structuredClone(current) } } };
      return [{ ns: 'llm-pi-ai', revision, user: section, value: section }];
    },
    update(ns, patch, expectedRevision) {
      return hmr.runExclusive(() => {
        assert.equal(ns, 'llm-pi-ai');
        if (revision !== expectedRevision) {
          throw Object.assign(new Error('settings changed since it was read'), { code: 'SETTINGS_CONFLICT' });
        }
        current = structuredClone(patch.providers.cpa.models);
        writes += 1;
        revision += 1;
        emit(EVENT, ns, revision);
      });
    },
  };
  const scoped = {
    settings,
    effect(fn) { disposers.push(fn()); },
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(callback);
    },
  };
  const ctx = {
    logger: { info() {}, warn(...args) { warnings.push(args); } },
    get: (name) => name === 'hmr' ? hmr : undefined,
    inject: (_names, callback) => callback(scoped),
  };
  t.after(() => {
    for (const dispose of disposers.reverse()) dispose();
    executing.disable();
  });
  return {
    hmr,
    warnings,
    emit,
    mount() { apply(ctx); },
    get models() { return current; },
    get writes() { return writes; },
    publish(next) {
      current = structuredClone(next);
      revision += 1;
      emit(EVENT, 'llm-pi-ai', revision);
    },
  };
}

test('models saved during an HMR transaction receive their missing thinking levels', async (t) => {
  const h = harness(t, [{ id: 'existing', reasoningEfforts: FULL }]);
  h.mount();
  await settle();

  await h.hmr.runExclusive(() => {
    h.publish([...h.models, { id: 'qwen3.8-flash:free', name: 'Qwen' }]);
    assert.equal(h.hmr.executing.getStore(), true, 'the plugin must not disable the caller transaction');
  });
  await settle();

  assert.deepEqual(h.models[1], { id: 'qwen3.8-flash:free', name: 'Qwen', reasoningEfforts: FULL });
  assert.equal(h.writes, 1, 'the plugin persists one completed table');
  assert.deepEqual(h.warnings, []);
  h.emit(EVENT, 'llm-pi-ai', 2);
  await settle();
  assert.equal(h.writes, 1, 'repeated notifications remain idempotent');
});

test('consecutive GUI saves keep the pending pass after a revision conflict', async (t) => {
  const h = harness(t, [{ id: 'existing', reasoningEfforts: FULL }]);
  h.mount();
  await settle();

  // Both GUI writes queue before the first one emits. The plugin plans from
  // the first revision, but its queued write runs after the second GUI save.
  await Promise.all([
    h.hmr.runExclusive(() => h.publish([...h.models, { id: 'qwen3.8-flash:free' }])),
    h.hmr.runExclusive(() => h.publish([...h.models, { id: 'mimo-v2.5:free', contextWindow: 123456 }])),
  ]);
  await settle();

  assert.deepEqual(h.models, [
    { id: 'existing', reasoningEfforts: FULL },
    { id: 'qwen3.8-flash:free', reasoningEfforts: FULL },
    { id: 'mimo-v2.5:free', contextWindow: 123456, reasoningEfforts: FULL },
  ]);
  assert.equal(h.writes, 1, 'only the fresh revision may be written');
});

test('mounting the plugin inside HMR also reconciles outside the mount transaction', async (t) => {
  const h = harness(t, [
    { id: 'mimo-v2.6-flash:free' },
    { id: 'disabled', reasoningEfforts: false },
    { id: 'custom', reasoningEfforts: { high: 'ultra' }, contextWindow: 500000 },
  ]);
  await h.hmr.runExclusive(() => h.mount());
  await settle();

  assert.deepEqual(h.models, [
    { id: 'mimo-v2.6-flash:free', reasoningEfforts: FULL },
    { id: 'disabled', reasoningEfforts: false },
    { id: 'custom', reasoningEfforts: { ...FULL, high: 'ultra' }, contextWindow: 500000 },
  ]);
  assert.equal(h.writes, 1);
  assert.deepEqual(h.warnings, []);
});
