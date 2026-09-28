/**
 * Per-model cost multipliers, mirrored from theoldllm's own pricing page
 * (`static/app.js` EXACT_MULTIPLIERS, which its backend bills from).
 *
 * The API exposes no multiplier anywhere: neither `/v1/models` nor
 * `/v1/usage` nor any response header carries it. The page computes the
 * badge as: exact pin first, then family defaults (claude 50x, luna 5x,
 * gemini and gpt-5.5 20x, other gpt/o3/o4 10x, everything else 5x).
 *
 * A multiplier of 0 means the model consumes no daily quota.
 */
const EXACT_MULTIPLIERS: Record<string, number> = {
  jev: 0,
  "classifier-fast": 0,
  "glm-5.3": 5,
  "glm-5.3-flash": 5,
  "glm-5.1": 5,
  "glm-5.1-venice": 5,
  "glm-5.2-venice": 5,
  "gemini-3.8-flash": 20,
  "gemini-3.8-flash-thinking": 20,
  "gemini-3.7-flash": 20,
  "gemini-3.7-flash-thinking": 20,
  "gemini-3.6-flash": 20,
  "gemini-3.6-flash-thinking": 20,
  "gemini-3.5-flash": 20,
  "gemini-3.5-flash-thinking": 20,
  "gemini-3.5-flash-lite": 5,
  "gemini-3.5-flash-lite-thinking": 5,
  "gemini-3.1-pro-preview": 50,
  "gemini-3.1-flash-lite": 5,
  "gemini-3.1-flash-lite-thinking": 5,
  "gemini-3-flash-preview-thinking": 5,
  "gemini-2.5-pro": 20,
  "gemini-2.5-flash-thinking": 5,
  "gemma-4-26b-a4b-it": 5,
  "grok-4.6": 20,
  "grok-4.7": 20,
  "grok-4.5": 20,
  "grok-4": 50,
  "grok-4.20-reasoning": 5,
  "grok-4.20-non-reasoning": 5,
  "kimi-k3": 20,
  "kimi-k2.7-code": 5,
  "kimi-k2.6": 5,
  "mimo-v2.5": 5,
  "mimo-v2.5-pro": 5,
  "mimo-v2.6-flash": 5,
  "gpt-6-astra": 100,
  "gpt-6-luna": 5,
  "gpt-6-sol": 20,
  "gpt-5.6-sol": 50,
  "gpt-5.6-terra": 20,
  "gpt-5.5": 100,
  "deepseek-v4.1-flash": 5,
  "qwen3.8-27b": 5,
  "qwen3.6-27b": 5,
  "schizogpt": 5,
  "deepseek-v4-flash-0731": 5,
  "deepseek-v4-pro-0813": 5,
  "deepseek-v4-pro": 5,
  "deepseek-v3.2": 5,
  "mistral-medium-3-5": 20,
  "sonar-pro": 50,
  "sonar-reasoning-pro": 20,
  "sonar-deep-research": 20,
  "command-a-plus": 5,
  "command-a": 5,
  "revenant-uncensored": 5,
  "emotional-medium": 5,
  "llama-3.1-8b-ludicrous": 5,
  "claude-sonnet-4-5": 50,
  "claude-haiku-4-5": 50,
  "claude-opus-5-5": 50,
}

/** Same order of precedence the pricing page uses. */
export function costMultiplier(modelID: string): number {
  const id = modelID.toLowerCase()
  const pinned = EXACT_MULTIPLIERS[id]
  if (pinned !== undefined) return pinned
  if (id.startsWith("claude")) return 50
  if (id === "gpt-5.6-luna") return 5
  if (id === "gpt-5.5" || id.startsWith("gemini")) return 20
  if (id.startsWith("gpt-") || id.startsWith("o3") || id.startsWith("o4")) return 10
  return 5
}
