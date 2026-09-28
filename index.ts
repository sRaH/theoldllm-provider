import { Integration, Model, Plugin, Provider } from "@opencode/plugin"
import { get, load } from "./catalog"
import { costMultiplier } from "./multipliers"
import { collapseTarget, effortsFor } from "./variants"

const PROVIDER_ID = "theoldllm"
const BASE_URL = "https://theoldllm.com/v1"
const API_KEY_ENV = "THEOLDLLM_API_KEY"
const REFRESH_MS = 30 * 60_000

type Options = {
  baseURL?: string
  models?: string[]
  /** How often to poll `GET /usage`. Default 5 minutes. */
  pollMs?: number
}

const providerID = Provider.ID.make(PROVIDER_ID)
const integrationID = Integration.ID.make(PROVIDER_ID)

/** OpenAI /v1/models lists far more than chat completions. */
const NON_CHAT = ["embedding", "whisper", "tts", "dall-e", "moderation", "transcribe"]

async function discover(apiKey: string, baseURL: string) {
  const response = await fetch(`${baseURL}/models`, {
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) throw new Error(`GET ${baseURL}/models returned ${response.status} ${response.statusText}`)
  const body: unknown = await response.json()
  const data = Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data : []
  const ids = data
    .map((entry) => (typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .filter((id) => !NON_CHAT.some((fragment) => id.includes(fragment)))
  return [...new Set(ids)].sort()
}

type Usage = {
  readonly daily: { used: number; limit: number; remaining: number }
  readonly window?: { remaining: number; limit: number; windowSeconds: number }
}

async function fetchUsage(apiKey: string, baseURL: string): Promise<Usage> {
  const response = await fetch(`${baseURL}/usage`, {
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) throw new Error(`GET ${baseURL}/usage returned ${response.status} ${response.statusText}`)
  const body = (await response.json()) as {
    daily_tokens?: { used?: number; limit?: number; remaining?: number }
    rate_limit?: { remaining?: number; limit?: number; window_seconds?: number }
  }
  const daily = body.daily_tokens
  if (!daily || typeof daily.used !== "number" || typeof daily.limit !== "number") {
    throw new Error("usage response is missing daily_tokens")
  }
  const window = body.rate_limit
  return {
    daily: {
      used: daily.used,
      limit: daily.limit,
      remaining: daily.remaining ?? Math.max(0, daily.limit - daily.used),
    },
    window:
      window && typeof window.remaining === "number" && typeof window.limit === "number"
        ? { remaining: window.remaining, limit: window.limit, windowSeconds: window.window_seconds ?? 0 }
        : undefined,
  }
}

const percent = (used: number, limit: number) => (limit > 0 ? (used / limit) * 100 : 0)

/** Warn-only, ascending. Each threshold fires once per crossing. */
const THRESHOLDS = [80, 95, 100] as const

const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(0)}k` : `${n}`

export default Plugin.define({
  id: "theoldllm.provider",
  async setup(ctx) {
    const options = ctx.options as Options
    const baseURL = options.baseURL ?? BASE_URL

    // Registering the integration is what puts the provider in `/connect`.
    // The key method is the selectable entry; the env method keeps
    // THEOLDLLM_API_KEY working without an explicit connect.
    await ctx.integration.transform((editor) => {
      editor.update(integrationID, (ref) => {
        ref.name = "TheOldLLM"
      })
      editor.method.update({ integrationID, method: { type: "key", label: "TheOldLLM API key" } })
      editor.method.update({ integrationID, method: { type: "env", names: [API_KEY_ENV] } })
    })

    const info: Provider.Info = {
      ...Provider.Info.empty(providerID),
      name: "TheOldLLM",
      activation: "enabled",
      integrationID,
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL },
    }

    const source = { models: options.models ?? ([] as string[]) }
    await load()

    // Recomputed on every transform: /v1/models discovery fills source.models
    // after setup and then triggers a reload.
    const build = () => {
      // Fold a thinking twin into its base as a variant, but only where that
      // costs nothing — see collapseTarget for why the multiplier must match.
      const available = new Set(source.models)
      const folded = new Map<string, string>()
      for (const id of source.models) {
        const base = collapseTarget(id, available)
        if (base) folded.set(id, base)
      }
      const bases = new Set(folded.values())

      // The name is what the picker renders and what its fuzzy search matches,
      // so it stays short: a clean human label plus the multiplier and nothing
      // else. Two ids can resolve to the same label (`command-a` vs
      // `command-a-03-2025`), and the picker keys on name, so disambiguate.
      const listed = source.models.filter((id) => !folded.has(id))
      const seen = new Map<string, number>()
      const ambiguous = new Set<string>()
      for (const id of listed) {
        const name = get(id).name ?? id
        seen.set(name, (seen.get(name) ?? 0) + 1)
        if (seen.get(name) === 2) ambiguous.add(name)
      }

      return listed.map((id) => {
        // Everything else is real metadata from models.dev; a miss falls back
        // to Model.Info.default. Limits matter most, since the runtime feeds
        // limit.context straight into the route as the true context ceiling.
        const model = Model.Info.default(providerID, Model.ID.make(id))
        const known = get(id)
        const multiplier = costMultiplier(id)
        const label = known.name ?? id
        const name = ambiguous.has(label) ? id : label

        const efforts = (effortsFor(id, known.efforts) ?? []).map((effort) => ({
          id: Model.VariantID.make(effort),
          body: { reasoning_effort: effort },
        }))
        // A folded thinking twin rides along as a variant on its base, unless
        // the model already exposes "high", which does the same job.
        const variants =
          bases.has(id) && !efforts.some((variant) => variant.id === "high")
            ? [...efforts, { id: Model.VariantID.make("thinking"), body: { reasoning_effort: "high" } }]
            : efforts

        return {
          ...model,
          name: `${name} (${multiplier === 0 ? "free" : `${multiplier}x`})`,
          ...(variants.length ? { variants } : {}),
          ...(known.family ? { family: Model.Family.make(known.family) } : {}),
          ...(known.released ? { time: { released: known.released } } : {}),
          // Limits stay at the default unless models.dev actually knows them.
          ...(known.context !== undefined && known.output !== undefined
            ? {
                limit: {
                  context: known.context,
                  output: known.output,
                  ...(known.input === undefined ? {} : { input: known.input }),
                },
                ...(known.modalities ? { capabilities: { ...model.capabilities, ...known.modalities } } : {}),
              }
            : {}),
        }
      })
    }

    await ctx.provider.transform((editor) => {
      editor.add({ info, models: build() })
    })

    const apiKey = async () => {
      const connection = await ctx.integration.connection.active(integrationID)
      const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
      if (credential?.type === "key") return credential.key
      const fromEnv = process.env[API_KEY_ENV]
      return fromEnv?.trim() ? fromEnv : undefined
    }

    const refresh = async () => {
      if (options.models) return
      const key = await apiKey()
      if (!key) {
        console.warn(`[theoldllm] no credential from /connect or ${API_KEY_ENV}; no models discovered`)
        return
      }
      try {
        source.models = await discover(key, baseURL)
        await ctx.provider.reload()
      } catch (error) {
        console.warn(`[theoldllm] model discovery failed: ${error}`)
      }
    }

    // The API exposes no rate-limit headers, so usage has to be polled.
    // Daily quota resets at midnight UTC.
    const pollMs = Number(options.pollMs ?? 5 * 60_000)
    let announced = -1

    const checkUsage = async () => {
      const key = await apiKey()
      if (!key) return
      let usage: Usage
      try {
        usage = await fetchUsage(key, baseURL)
      } catch (error) {
        console.warn(`[theoldllm] usage check failed: ${error}`)
        return
      }
      const { used, limit } = usage.daily
      const pct = percent(used, limit)
      const crossed = THRESHOLDS.find((t) => pct >= t && t > announced)
      if (crossed === undefined) return
      announced = crossed
      const atLimit = used >= limit
      const message =
        `[theoldllm] daily tokens ${compact(used)}/${compact(limit)} (${pct.toFixed(1)}%) used` +
        (usage.window ? `, ${usage.window.remaining}/${usage.window.limit} requests left in ${usage.window.windowSeconds}s window` : "")
      if (atLimit) console.error(`${message} — limit reached, resets at midnight UTC`)
      else if (crossed >= 95) console.warn(`${message} — approaching the daily limit`)
      else console.warn(message)
    }

    await ctx.session.hook("http.response", ({ response, model }) => {
      if (response.status === 429) {
        announced = -1
        // The multiplier is a quota weight, not a dollar rate — worth naming on
        // a 429 because a heavy model burns the daily cap far faster.
        const multiplier = costMultiplier(model.id)
        console.warn(`[theoldllm] 429 from ${model.id} (${multiplier}x cost) — re-checking usage`)
        void checkUsage()
      }
    }, { providerID: PROVIDER_ID })

    await refresh()
    await checkUsage()

    const timer = setInterval(() => void checkUsage(), pollMs)
    const abort = new AbortController()
    const watch = async () => {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        if (event.type === "credential.updated") {
          announced = -1
          await refresh()
          await checkUsage()
        }
      }
    }
    void watch().catch(() => {})

    return () => {
      clearInterval(timer)
      abort.abort()
    }
  },
})
