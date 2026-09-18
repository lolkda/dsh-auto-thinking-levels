/**
 * Pure planning logic for dsh-auto-thinking-levels.
 *
 * Everything here is a total function over plain data: it decides *what* the
 * settings document should say, and never reads or writes anything. The plugin
 * entry (`../index.js`) owns the I/O. Keeping the split means the interesting
 * rules — which models get filled, which are deliberately left alone, what the
 * merged table looks like — are testable without a running harness.
 *
 * @module dsh-auto-thinking-levels/plan
 */

/** The pi-ai adapter's settings namespace (`dsh-llm-pi-ai`'s `NS` constant). */
export const DEFAULT_NAMESPACE = 'llm-pi-ai';

/**
 * The seven levels pi-ai's `ModelThinkingLevel` declares, in escalation order,
 * with the wire spelling each sends. `off: null` is the one level allowed to
 * carry no value — it means "supported, send nothing", which is the correct
 * dispatch wherever not thinking is the reasoning parameter's absence.
 */
export const DEFAULT_LEVELS = Object.freeze({
  off: null,
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
});

/** How much of each model's table this plugin is allowed to own. */
export const FILL_MODES = Object.freeze(['missing', 'complete']);

/** Whether a value is a plain data object, the only shape a settings layer holds. */
export function plainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate the row's `config` block. Every field is optional; the defaults
 * already mean "every provider, every model, the full seven levels".
 * @param config - the raw row config, when the patch supplies one.
 * @returns the resolved options.
 * @throws {TypeError} naming the offending field.
 */
export function readOptions(config) {
  if (config !== undefined && !plainObject(config)) {
    throw new TypeError('dsh-auto-thinking-levels: config must be a mapping of keys');
  }
  const raw = config ?? {};

  const namespace = raw.namespace ?? DEFAULT_NAMESPACE;
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new TypeError('dsh-auto-thinking-levels: config.namespace must be a non-empty string');
  }

  const fill = raw.fill ?? 'complete';
  if (!FILL_MODES.includes(fill)) {
    throw new TypeError(`dsh-auto-thinking-levels: config.fill must be one of ${FILL_MODES.join(', ')}`);
  }

  const levels = raw.levels ?? DEFAULT_LEVELS;
  if (!plainObject(levels) || Object.keys(levels).length === 0) {
    throw new TypeError('dsh-auto-thinking-levels: config.levels must be a non-empty mapping of level -> wire value');
  }
  for (const [level, wire] of Object.entries(levels)) {
    if (wire === null) continue;
    if (typeof wire !== 'string' || wire.length === 0) {
      throw new TypeError(`dsh-auto-thinking-levels: config.levels.${level} must be a non-empty string, or null for "send nothing"`);
    }
  }

  const providers = raw.providers ?? [];
  if (!Array.isArray(providers) || providers.some((entry) => typeof entry !== 'string')) {
    throw new TypeError('dsh-auto-thinking-levels: config.providers must be an array of provider route names');
  }

  const enabled = raw.enabled ?? true;
  if (typeof enabled !== 'boolean') {
    throw new TypeError('dsh-auto-thinking-levels: config.enabled must be a boolean');
  }

  const known = new Set(['namespace', 'fill', 'levels', 'providers', 'enabled']);
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`dsh-auto-thinking-levels: unknown config key(s): ${unknown.join(', ')}`);
  }

  return { namespace, fill, levels, providers, enabled };
}

/**
 * Decide the table one model should carry.
 * @param current - the model's declared `reasoningEfforts`, when it has one.
 * @param options - resolved plugin options.
 * @returns the table to write, or `undefined` to leave the model alone.
 */
export function mergeEfforts(current, options) {
  // `false` is the model's own "does not reason" answer — an explicit
  // declaration, not a gap, and the one value this plugin must not fill in.
  if (current === false) return undefined;
  if (current === undefined) return { ...options.levels };
  if (!plainObject(current)) return undefined;
  if (options.fill !== 'complete') return undefined;
  const incomplete = Object.keys(options.levels).some((level) => !(level in current));
  if (!incomplete) return undefined;
  // The user's own spellings win over the plugin's defaults, key for key.
  return { ...options.levels, ...current };
}

/**
 * Top up a route's declared `models` list.
 * @param route - route key, for the change report.
 * @param models - the route's raw `models` array.
 * @param options - resolved plugin options.
 * @param added - collector of `route/model` labels actually changed.
 * @returns the replacement array, or `undefined` when every entry is already complete.
 */
export function planModels(route, models, options, added) {
  let changed = false;
  const next = models.map((entry) => {
    if (!plainObject(entry)) return entry;
    const merged = mergeEfforts(entry.reasoningEfforts, options);
    if (merged === undefined) return entry;
    changed = true;
    added.push(`${route}/${String(entry.id)}`);
    return { ...entry, reasoningEfforts: merged };
  });
  return changed ? next : undefined;
}

/**
 * Top up a catalog route through `modelOverrides`, one entry per model the
 * adapter actually serves. The adapter refuses an override naming a model the
 * installed catalog does not describe, so the served list — not a guess at the
 * catalog — is what gets named here.
 * @param route - route key, for the change report.
 * @param existing - the route's raw `modelOverrides`, when it has any.
 * @param servedIds - ids the adapter reports serving for this route.
 * @param options - resolved plugin options.
 * @param added - collector of `route/model` labels actually changed.
 * @returns the replacement dict, or `undefined` when nothing was missing.
 */
export function planOverrides(route, existing, servedIds, options, added) {
  const current = plainObject(existing) ? existing : {};
  const next = { ...current };
  let changed = false;
  for (const id of servedIds) {
    if (typeof id !== 'string' || id.length === 0) continue;
    const entry = plainObject(current[id]) ? current[id] : {};
    const merged = mergeEfforts(entry.reasoningEfforts, options);
    if (merged === undefined) continue;
    next[id] = { ...entry, reasoningEfforts: merged };
    changed = true;
    added.push(`${route}/${id}`);
  }
  return changed ? next : undefined;
}

/**
 * Bound a change report: a catalog route can carry dozens of models, and one
 * log line should stay one log line.
 * @param labels - `route/model` labels that were changed.
 * @returns the labels, truncated with a remainder count.
 */
export function summarize(labels) {
  const shown = labels.slice(0, 8).join(', ');
  return labels.length > 8 ? `${shown}, +${labels.length - 8} more` : shown;
}
