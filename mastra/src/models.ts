// OpenAI models via the Mastra model router ("openai/<id>", reads OPENAI_API_KEY from the project .env).
export const FAST_MODEL = `openai/${(process.env.OPENAI_MODEL_FAST || "gpt-5.4-mini").trim()}` as const;
export const AGENT_MODEL = `openai/${(process.env.OPENAI_MODEL_AGENT || "gpt-5.5").trim()}` as const;
