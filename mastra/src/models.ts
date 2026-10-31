// LLM models via the Mastra model router ("<provider>/<model-id>").
// Default provider is OpenAI (reads OPENAI_API_KEY from the project .env).
// Set LLM_PROVIDER=anthropic to use Claude instead (reads ANTHROPIC_API_KEY).
const env = (k: string) => process.env[k]?.trim() || undefined;

export const LLM_PROVIDER: "openai" | "anthropic" = env("LLM_PROVIDER")?.toLowerCase() === "anthropic" ? "anthropic" : "openai";

const MODELS = {
  openai: { fast: env("OPENAI_MODEL_FAST") || "gpt-5.4-mini", agent: env("OPENAI_MODEL_AGENT") || "gpt-5.5" },
  anthropic: { fast: env("ANTHROPIC_MODEL_FAST") || "claude-haiku-5-5", agent: env("ANTHROPIC_MODEL_AGENT") || "claude-sonnet-5-5" },
} as const;

/** Clearance parser agent. */
export const FAST_MODEL = `${LLM_PROVIDER}/${MODELS[LLM_PROVIDER].fast}` as const;
/** Sector controller and monitor agents. */
export const AGENT_MODEL = `${LLM_PROVIDER}/${MODELS[LLM_PROVIDER].agent}` as const;
