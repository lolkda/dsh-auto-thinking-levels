/**
 * The trigger seam between this plugin and the settings service.
 *
 * DSH 0.1.7-rc.1's `dsh-settings` emits exactly one settings event,
 * `settings/document-updated(ns, revision)`; the older `settings/updated`
 * (resolved value + source) is gone. `settings.register()` is gone too, so the
 * namespace is a profile entry id and `describe()` is the only read.
 *
 * A listener that names the removed event is invisible at startup: the first
 * pass runs from `apply`, so the plugin looks healthy and then silently stops
 * reacting to every later document change. These tests drive the real `apply`
 * with a fake service and assert the pass actually re-runs.
 *
 * @module dsh-auto-thinking-levels/test/reconcile-trigger
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../index.js';

/** The event name DSH 0.1.7-rc.1's settings service actually emits. */
const DEPLOYMENT_SETTINGS_EVENT = 'settings/document-updated';

/** Let every pending microtask and timer callback of a pass settle. */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * One provider route whose declared `models` list is missing the table.
 * @param ids - model ids the route declares.
 * @returns a raw user-layer provider section.
 */
function providerSection(ids) {
  return { providers: { cpa: { models: ids.map((id) => ({ id })) } } };
}

/**
 * Mount the plugin against the smallest settings service the plugin uses.
 * @returns the recorded writes, the emit hooks, and the effect disposers.
 */
function harness() {
  const updates = [];
  const listeners = new Map();
  const disposers = [];
  let document = {
    ns: 'llm-pi-ai',
    revision: 1,
    user: providerSection(['model-a']),
    value: providerSection(['model-a']),
  };

  const settings = {
    describe: () => [document],
    update: async (ns, patch, revision) => {
      updates.push({ ns, patch, revision });
    },
  };
  const scoped = {
    settings,
    effect: (fn) => {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
    on: (event, callback) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(callback);
    },
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    inject: (_names, callback) => {
      callback(scoped);
    },
    get: () => undefined,
  };

  apply(ctx, { enabled: true });
  return {
    updates,
    disposers,
    emit(event, ...args) {
      for (const callback of listeners.get(event) ?? []) callback(...args);
    },
    /** Publish the next document the way the Host would, then announce it. */
    publish(next, revision) {
      document = { ...document, revision, user: next, value: next };
      return revision;
    },
  };
}

test('a settings document change announced by DSH 0.1.7 re-runs the pass', async () => {
  const h = harness();
  await settle();
  assert.equal(h.updates.length, 1, 'the mount pass fills the models declared at startup');
  assert.deepEqual(h.updates[0].ns, 'llm-pi-ai');
  assert.deepEqual(h.updates[0].revision, 1);

  // A model appears after the mount pass. Without a listener on the event the
  // deployment emits, the new model never gets its table.
  const revision = h.publish(providerSection(['model-a', 'model-b']), 2);
  h.emit(DEPLOYMENT_SETTINGS_EVENT, 'llm-pi-ai', revision);
  await settle();

  assert.equal(h.updates.length, 2, 'the announced change starts a new pass');
  const second = h.updates[1];
  assert.deepEqual(second.revision, 2, 'the pass reads the announced revision');
  assert.deepEqual(
    second.patch.providers.cpa.models.map((model) => model.id),
    ['model-a', 'model-b'],
    'the pass covers the models the new document declares',
  );
});

test('an announcement for another namespace leaves this one alone', async () => {
  const h = harness();
  await settle();
  h.emit(DEPLOYMENT_SETTINGS_EVENT, 'llm-deepseek', 7);
  await settle();
  assert.equal(h.updates.length, 1, 'another namespace is not this plugin\'s business');
});
