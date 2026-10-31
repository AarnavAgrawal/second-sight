// Claude models via the Mastra model router ("anthropic/<id>", reads ANTHROPIC_API_KEY from the project .env).
export const FAST_MODEL = `anthropic/${(process.env.ANTHROPIC_MODEL_FAST || "claude-haiku-5-5").trim()}` as const;
export const AGENT_MODEL = `anthropic/${(process.env.ANTHROPIC_MODEL_AGENT || "claude-sonnet-5-5").trim()}` as const;
