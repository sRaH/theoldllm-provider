/**
 * Real model metadata, sourced from models.dev.
 *
 * theoldllm's `/v1/models` returns only `{id, object, owned_by, created,
 * permission}` — no limits, no display names, no modalities. Guessing these
 * misleads the runtime: `Model.Info.default` hardcodes 200k context / 32k
 * output and `withDefaults` (core's session/runner/model.ts) feeds
 * `model.limit.context` straight into the route as the true ceiling. Real
 * limits run from 200k (claude-haiku-4.5) to 1.05M (gpt-6-luna).
 *
 * models.dev is the catalog OpenCode itself syncs from, keyed by the upstream
 * model id, which theoldllm passes through unchanged.
 */

const MODELS_DEV = "https://models.dev/api.json"
const CACHE_MS = 24 * 60 * 60_000

export type CatalogEntry = {
  readonly name?: string
  readonly family?: string
  readonly released?: number
  readonly reasoning?: boolean
  /** Effort levels the model accepts, when it declares an `effort` ladder. */
  readonly efforts?: readonly string[]
  /** Absent when nothing trustworthy is known; never invented. */
  readonly context?: number
  readonly output?: number
  readonly input?: number
  readonly modalities?: { readonly input: string[]; readonly output: string[] }
}

type Raw = {
  name?: unknown
  family?: unknown
  release_date?: unknown
  reasoning?: unknown
  reasoning_options?: unknown
  limit?: { context?: unknown; output?: unknown; input?: unknown }
  modalities?: { input?: unknown; output?: unknown }
}

/** id -> metadata. Refreshed daily; a miss falls back to the caller's default. */
let cache: {
  at: number
  byID: Map<string, CatalogEntry>
  byNormalized: Map<string, CatalogEntry>
  byDated: Map<string, CatalogEntry>
} | undefined

/**
 * theoldllm writes `claude-opus-4.5` where models.dev writes `claude-opus-4-5`.
 * Folding case and `.`/`_`/`/` to `-` recovers those without inventing matches.
 */
const normalize = (id: string) => id.toLowerCase().replace(/[._/]/g, "-")

/**
 * theoldllm suffixes a variant or community-tweak marker that models.dev puts
 * on the base model instead: `gemini-2.5-flash-thinking` vs `gemini-2.5-flash`,
 * `glm-5.2-venice` vs `glm-5.2`. Only these known markers are stripped — a
 * blind prefix match would map `deepseek-v4` onto `deepseek-v4-pro` and invent
 * limits for a different model.
 */
const VARIANT_SUFFIX =
  /-(thinking|reasoning|vision|beta|preview|venice|heretic|ludicrous|uncensored\d*)$/

/** A dated snapshot of the same model: `command-a-03-2025` -> `command-a`. */
const DATED_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{2}-\d{4}|\d{8}|\d{6})$/

/** `glm-5-venice` -> `GLM 5 Venice`. A readable label, not a claim about specs. */
function titleize(id: string) {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => (/^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1)))
    .join(" ")
}

/**
 * The `effort` ladder from models.dev's `reasoning_options`, e.g.
 * `[{type:"effort",values:["low","medium","high"]}]`. A `toggle` entry declares
 * reasoning as on/off with no levels, so it yields nothing.
 */
function effortsOf(options: unknown): readonly string[] | undefined {
  if (!Array.isArray(options)) return undefined
  for (const option of options) {
    const effort = option as { type?: unknown; values?: unknown }
    if (effort.type === "effort" && Array.isArray(effort.values)) {
      const values = effort.values.filter((v): v is string => typeof v === "string")
      if (values.length > 0) return values
    }
  }
  return undefined
}

function collect(payload: unknown) {
  const byID = new Map<string, CatalogEntry>()
  if (typeof payload !== "object" || payload === null) return byID
  for (const provider of Object.values(payload as Record<string, unknown>)) {
    const models = (provider as { models?: Record<string, unknown> })?.models
    if (typeof models !== "object" || models === null) continue
    for (const [id, model] of Object.entries(models)) {
      const raw = model as Raw
      const context = raw.limit?.context
      const output = raw.limit?.output
      if (typeof context !== "number" || typeof output !== "number") continue
      // The same model is listed under many providers and some entries are
      // dated aliases ("Claude Haiku 4.5 (latest)"), which read badly in the
      // picker. First entry wins; the alias suffix is dropped from the name.
      if (byID.has(id)) continue
      const modalities = raw.modalities
      byID.set(id, {
        name: typeof raw.name === "string" ? raw.name.replace(/\s*\([^)]*\)\s*$/, "").trim() : undefined,
        family: typeof raw.family === "string" ? raw.family : undefined,
        released: typeof raw.release_date === "string" ? Date.parse(raw.release_date) / 1000 : undefined,
        reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined,
        efforts: effortsOf(raw.reasoning_options),
        context,
        output,
        input: typeof raw.limit?.input === "number" ? raw.limit.input : undefined,
        modalities:
          Array.isArray(modalities?.input) && Array.isArray(modalities?.output)
            ? { input: modalities.input as string[], output: modalities.output as string[] }
            : undefined,
      })
    }
  }
  return byID
}

/**
 * Metadata for a model id, however it can be established:
 * exact id, then punctuation-folded, then the base model behind a known variant
 * suffix. Unlisted models fall back to a title-cased id with no limits, because
 * a guessed `limit.context` would corrupt the runtime's context budget.
 */
export function get(id: string): CatalogEntry {
  const key = normalize(id)
  const base = key.replace(VARIANT_SUFFIX, "")
  return lookup(id, key, base)
}

/** True when limits are real rather than the `Model.Info.default` guess. */
export function hasLimits(id: string) {
  return get(id).context !== undefined
}

function lookup(id: string, key: string, base: string): CatalogEntry {
  if (!cache) return { name: titleize(id) }
  const exact = cache.byID.get(id) ?? cache.byNormalized.get(key)
  if (exact) return exact
  // A variant suffix only borrows limits when the stripped base is a real
  // catalog id, so `deepseek-v4` never inherits from `deepseek-v4-pro`. The
  // name is dropped in that case: `gemini-2.5-flash-thinking` must not be
  // labelled "Gemini 2.5 Flash", which is a different model on the same row.
  const borrowed = base !== key ? cache.byNormalized.get(base) : undefined
  if (borrowed) return { ...borrowed, name: titleize(id) }
  // `command-a` is listed bare while its dated twin `command-a-03-2025` is
  // catalogued, so fall back to a sibling that is the same model, not just a
  // similar name. The sibling supplies limits only; the id stays the label.
  const sibling = cache.byDated.get(key)
  return sibling ? { ...sibling, name: titleize(id) } : { name: titleize(id) }
}

export async function load() {
  if (cache && Date.now() - cache.at < CACHE_MS) return
  try {
    const response = await fetch(MODELS_DEV, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`status ${response.status}`)
    const byID = collect(await response.json())
    if (byID.size === 0) throw new Error("catalog was empty")
    const byNormalized = new Map<string, CatalogEntry>()
    // Dated snapshots of an unlisted model: `command-a-03-2025` -> `command-a`.
    const byDated = new Map<string, CatalogEntry>()
    for (const [id, entry] of byID) {
      const key = normalize(id)
      if (!byNormalized.has(key)) byNormalized.set(key, entry)
      const undated = key.replace(DATED_SUFFIX, "")
      if (undated !== key && !byDated.has(undated)) byDated.set(undated, entry)
    }
    cache = { at: Date.now(), byID, byNormalized, byDated }
  } catch (error) {
    // Keep serving a stale catalog rather than dropping every model.
    if (!cache) {
      console.warn(`[theoldllm] models.dev lookup failed, using default limits: ${error}`)
      return
    }
    console.warn(`[theoldllm] models.dev refresh failed, using cached limits: ${error}`)
  }
}
