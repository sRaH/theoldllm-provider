import { costMultiplier } from "./multipliers"

/**
 * Reasoning-effort variants, attached as `Model.Info.variants`.
 *
 * Core's own variant plugin does this for GLM-5.2 with
 * `body: { reasoning_effort: id }`, and theoldllm validates `reasoning_effort`
 * as a first-class request field, so the same shape works here.
 *
 * The ladder comes from *configuration*, not per-model probing: models.dev
 * already declares `reasoning` plus an `effort` ladder, so configuring a base
 * model is enough and 43 of the 121 models pick up variants that way.
 *
 * But that declaration describes the upstream model, not what theoldllm
 * honours, and the two disagree. Probing the same question plain and with
 * `reasoning_effort: "high"` and comparing completion tokens:
 *
 *   engaged   gemini-3.8-flash (3 -> 191), gemini-3-flash-preview (3 -> 269),
 *             claude-haiku-4.5 (5 -> 39), glm-5.2 (35 -> 130)
 *   inert     claude-sonnet-5 (3 -> 3), claude-opus-5 (12 -> 12),
 *             gpt-5.5 (24 -> 26), gpt-5.6-luna (4 -> 4), gpt-6-luna (23 -> 16),
 *             deepseek-v4-pro (39 -> 39)
 *
 * The inert ones still declare a full ladder upstream, so left alone the
 * catalog would hand out a switch that silently does nothing. Anthropic's real
 * control is `thinking: {type, budget_tokens}`, which this gateway does not map,
 * and deepseek always thinks, so its effort level has nothing to scale.
 */
const INERT = new Set([
  "claude-sonnet-5",
  "claude-opus-5",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-6-luna",
  "deepseek-v4-pro",
])

/**
 * Effort levels to expose for a model: the catalog's ladder, minus the models
 * measured to ignore the parameter. Undefined means expose nothing, because a
 * switch that does nothing is worse than no switch.
 */
export function effortsFor(id: string, declared?: readonly string[]): readonly string[] | undefined {
  if (INERT.has(id)) return undefined
  // A single level is not a choice, so it is not worth a variant row.
  return declared && declared.length > 1 ? declared : undefined
}

/**
 * A thinking/reasoning model that should fold into its base as a variant,
 * leaving one picker row instead of two.
 *
 * Only when the base is also in the catalog *and* bills at the same multiplier.
 * Eight of the ten pairs are identical and collapse for free; the other two —
 * `gemini-2.5-flash` and `gemini-3-flash-preview`, both 20x against a 5x
 * thinking twin — keep their own entry, because folding them would quietly make
 * thinking four times more expensive.
 */
export function collapseTarget(id: string, available: ReadonlySet<string>): string | undefined {
  const base = id.replace(/-(?:thinking|reasoning)$/, "")
  if (base === id || !available.has(base)) return undefined
  return costMultiplier(base) === costMultiplier(id) ? base : undefined
}
