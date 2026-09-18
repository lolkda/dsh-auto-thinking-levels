/**
 * dsh-auto-thinking-levels — Host plugin entry.
 *
 * The decision logic lives in `./lib/plan.js` and is pure. This module owns the
 * I/O: reading the settings namespace, writing through `settings.update`, and
 * the triggers that keep the plan applied.
 *
 * Why the settings layer is the right seam: `llm-pi-ai` reads a model's
 * `reasoningEfforts` table at materialization time and turns it into the pi-ai
 * descriptor's `thinkingLevelMap` (`resolveModelReasoning`). Every later
 * question is answered from that map, and only from it:
 *
 *   - `getSupportedThinkingLevels()` decides which levels a selector offers;
 *   - the same function gates the request path, so a level the map does not
 *     carry is refused with `UNSUPPORTED_REASONING_EFFORT` before any I/O.
 *
 * So patching an adapter's `resolveModel` could only ever move the first
 * answer, not the second, and the user would pick a level the provider call
 * then rejects. Writing the table into the namespace's user layer instead makes
 * the *configuration* correct, so both answers follow from it and survive every
 * reload without a re-patch. Writes go through `settings.update`, which
 * resolves and validates the candidate through the namespace's own schema and
 * `assertServiceable` before persisting — an injection that would not serve is
 * refused with nothing written.
 *
 * The plugin only ever ADDS the field. It never rewrites a level the user
 * already spelled, never removes an entry, and never touches a model that
 * declares `reasoningEfforts: false` (the explicit "this model does not
 * reason" answer). That makes it idempotent: a second pass finds nothing to do
 * and writes nothing.
 *
 * @module dsh-auto-thinking-levels
 */

import { plainObject, planModels, planOverrides, readOptions, summarize } from './lib/plan.js';

/**
 * Delays before re-reading a namespace that is not registered yet. The pi-ai
 * adapter installs its settings section during its own `apply`, and row order
 * decides whether that happened before this one — and `settings.register()`
 * emits no event, so a section appearing after us is not observable. A short
 * bounded ladder covers the startup race; the event listeners below cover
 * everything after it.
 */
const RETRY_LADDER_MS = Object.freeze([200, 500, 1000, 2000, 4000, 8000]);

export const name = 'dsh-auto-thinking-levels';

/** The adapter must exist before there is a namespace worth configuring. */
export const inject = ['llm'];

/**
 * Mount the row. The plugin is inert until a settings provider is present,
 * because without one there is no user layer to write and no resolved value to
 * compare against.
 * @param ctx - the row's Cordis context.
 * @param config - the row's `config` block, when the patch supplies one.
 * @throws {TypeError} when a supplied field is not one this plugin understands.
 */
export function apply(ctx, config) {
  const options = readOptions(config);
  if (!options.enabled) {
    ctx.logger.info('[%s] disabled by configuration; no namespace will be written', name);
    return;
  }

  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings;
    /** One pass at a time; a trigger arriving mid-pass sets the rerun flag instead. */
    let running = false;
    let rerun = false;
    /** Pending retry handle, and how many ladder steps it has consumed. */
    let timer;
    let attempt = 0;
    let disposed = false;

    const cancel = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    };

    const schedule = (delayMs) => {
      if (disposed) return;
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        void pump();
      }, delayMs);
      // `setTimeout` alone would keep a disposed profile alive for one tick.
      timer.unref?.();
    };

    /** Run passes until a pass settles, then stop; never overlaps. */
    async function pump() {
      if (disposed) return;
      if (running) {
        rerun = true;
        return;
      }
      running = true;
      try {
        do {
          rerun = false;
          const outcome = await sync();
          if (outcome === 'deferred') {
            const delay = RETRY_LADDER_MS[Math.min(attempt, RETRY_LADDER_MS.length - 1)];
            const more = attempt < RETRY_LADDER_MS.length;
            attempt += 1;
            if (more) schedule(delay);
            return;
          }
          attempt = 0;
        } while (rerun);
      } catch (error) {
        // A failed pass must never escape into the event bus: the settings
        // document is untouched, and the next trigger tries again.
        ctx.logger.warn('[%s] sync failed; the settings document was left untouched', name);
        ctx.logger.warn(error);
      } finally {
        running = false;
      }
    }

    /**
     * One reconcile pass.
     * @returns `'done'` when the namespace was read (whether or not it needed a
     *   write), or `'deferred'` when it is not registered yet.
     */
    async function sync() {
      const descriptor = settings
        .describe()
        .find((entry) => String(entry.ns) === options.namespace);
      if (descriptor === undefined) return 'deferred';

      const user = plainObject(descriptor.user) ? descriptor.user : {};
      const resolved = plainObject(descriptor.value) ? descriptor.value : {};
      const userProviders = plainObject(user.providers) ? user.providers : {};
      const resolvedProviders = plainObject(resolved.providers) ? resolved.providers : {};

      const routes = Object.keys(resolvedProviders).filter(
        (route) => options.providers.length === 0 || options.providers.includes(route),
      );

      const patch = {};
      const added = [];
      for (const route of routes) {
        const raw = plainObject(userProviders[route]) ? userProviders[route] : {};
        // A route that declares `models` gets the table on each entry. A route
        // that does not is a catalog route, whose served models are only
        // nameable through `modelOverrides` — and `modelOverrides` beside a
        // `models` list is refused by the adapter, so the two never combine.
        const declared = raw.models;
        if (Array.isArray(declared) && declared.length > 0) {
          const next = planModels(route, declared, options, added);
          if (next !== undefined) patch[route] = { models: next };
          continue;
        }
        const overrides = await planRouteOverrides(route, raw.modelOverrides, added);
        if (overrides !== undefined) patch[route] = { modelOverrides: overrides };
      }

      if (Object.keys(patch).length === 0) return 'done';

      ctx.logger.info(
        '[%s] %s: adding reasoningEfforts for %d model(s) across %d provider route(s) — %s',
        name,
        options.namespace,
        added.length,
        Object.keys(patch).length,
        summarize(added),
      );
      await settings.update(options.namespace, { providers: patch }, descriptor.revision);
      return 'done';
    }

    /**
     * Ask the adapter which models a catalog route actually serves, then plan
     * overrides for them.
     * @param route - route key.
     * @param existing - the route's raw `modelOverrides`, when it has any.
     * @param added - collector of `route/model` labels actually changed.
     * @returns the replacement dict, or `undefined` when nothing was missing.
     */
    async function planRouteOverrides(route, existing, added) {
      const llm = ctx.get('llm');
      if (llm === undefined) return undefined;
      let served;
      try {
        served = await llm.listModels(route);
      } catch (error) {
        // A route whose adapter is mid-replacement reports nothing to serve;
        // the next trigger retries rather than failing the pass.
        ctx.logger.warn('[%s] could not list models for route "%s"', name, route);
        ctx.logger.warn(error);
        return undefined;
      }
      const ids = served.map((model) => model?.id).filter((id) => typeof id === 'string');
      return planOverrides(route, existing, ids, options, added);
    }

    settingsCtx.effect(() => () => {
      disposed = true;
      cancel();
    });

    settingsCtx.on('settings/updated', (ns) => {
      if (String(ns) === options.namespace) void pump();
    });
    // Routes appearing or disappearing re-shapes which models exist to cover.
    settingsCtx.on('llm/adapters-updated', () => void pump());

    void pump();
  });
}
