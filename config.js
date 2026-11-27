import "dotenv/config";
import { z } from "zod";

const positiveInteger = (defaultValue) =>
  z.coerce.number().int().positive().default(defaultValue);

const repositoryAllowlist = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.split(",").map((repository) => repository.trim().toLowerCase()))
  .pipe(
    z
      .array(z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/))
      .min(1),
  );

const botAuthorAllowlist = z
  .string()
  .default("")
  .transform((value) => value.split(",").map((author) => author.trim().toLowerCase()).filter(Boolean))
  .pipe(z.array(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?(?:\[bot\])?$/)));

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    PORT: positiveInteger(3000).pipe(z.number().max(65535)),

    GITHUB_APP_ID: z.string().trim().regex(/^[1-9]\d*$/),
    GITHUB_PRIVATE_KEY: z.string().trim().min(1),
    GITHUB_WEBHOOK_SECRET: z.string().trim().min(1),
    GITHUB_REPOSITORY_ALLOWLIST: repositoryAllowlist,
    GITHUB_BOT_AUTHOR_ALLOWLIST: botAuthorAllowlist,

    DATABASE_URL: z
      .string()
      .trim()
      .url()
      .refine(
        (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
        "Expected a PostgreSQL connection URL",
      ),

    OPENAI_API_KEY: z.string().trim().min(1),
    OPENAI_MODEL: z.string().trim().min(1),
    REVIEW_V3_ASTRA_SONNET: z.enum(['true', 'false']).default('false'),
    REVIEW_V3_ENABLED: z.enum(['true', 'false']).default('false'),
    REVIEW_V3_AGENT_MODELS: z.string().default('{}').transform((value, ctx) => {
      try { return z.object({ 'context-dependency': z.string().min(1).optional(), 'security-logic': z.string().min(1).optional(), architecture: z.string().min(1).optional() }).strict().parse(JSON.parse(value)); }
      catch { ctx.addIssue({ code: 'custom', message: 'Expected agent-to-model mapping' }); return z.NEVER; }
    }),
    REVIEW_V3_MODEL_PRICING: z.string().default('{}').transform((value, ctx) => {
      try {
        return z.record(z.string(), z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }).strict()).parse(JSON.parse(value));
      } catch { ctx.addIssue({ code: 'custom', message: 'Expected model input/output USD per million tokens' }); return z.NEVER; }
    }),
    REVIEW_V3_AGENT_INPUT_TOKENS: positiveInteger(8000).pipe(z.number().max(24000)),
    REVIEW_V3_AGENT_OUTPUT_TOKENS: positiveInteger(1500).pipe(z.number().max(4000)),
    REVIEW_V3_AGENT_COST_MICROS: positiveInteger(100000),
    REVIEW_V3_PR_COST_MICROS: positiveInteger(300000),
    REVIEW_V3_MONTHLY_COST_MICROS: positiveInteger(30000000),
    REVIEW_V3_TEST_BUDGET_BYPASS: z.enum(['true', 'false']).default('false'),
    REVIEW_V3_TIMEOUT_MS: positiveInteger(90000).pipe(z.number().max(180000)),

    INNGEST_EVENT_KEY: z.string().trim().optional(),
    INNGEST_SIGNING_KEY: z.string().trim().optional(),

    // Owner ka GitHub username, bina @ ke.
    REVIEW_OWNER: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/)
      .optional(),

    REVIEW_MAX_FILES: positiveInteger(30),
    REVIEW_MAX_INPUT_CHARS: positiveInteger(80000),
    REVIEW_MAX_INPUT_TOKENS: positiveInteger(24000),
    REVIEW_MAX_OUTPUT_TOKENS: positiveInteger(4000),

    REVIEW_MAX_FINDINGS: positiveInteger(5).pipe(z.number().max(5)),
    REVIEW_GLOBAL_CONCURRENCY: positiveInteger(5),
    REVIEW_DAILY_TOKEN_LIMIT: positiveInteger(100000),
    REVIEW_GLOBAL_DAILY_TOKEN_LIMIT: positiveInteger(500000),
    REVIEW_PR_DAILY_TOKEN_LIMIT: positiveInteger(50000),
    REVIEW_KILL_SWITCH: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV !== "production") return;

    for (const key of ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"]) {
      if (!env[key]) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Required in production",
        });
      }
    }
  });

export function loadConfig(environment = process.env) {
  const result = envSchema.safeParse(environment);

  if (!result.success) {
    // Error mein secret values print nahi karenge.
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join("."))),
    ];

    throw new Error(
      `Missing or invalid environment variables: ${fields.join(", ")}`,
    );
  }

  const env = result.data;

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,

    github: {
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n"),
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      repositoryAllowlist: env.GITHUB_REPOSITORY_ALLOWLIST,
      botAuthorAllowlist: env.GITHUB_BOT_AUTHOR_ALLOWLIST,
    },

    databaseUrl: env.DATABASE_URL,

    openai: {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
    },

    inngest: {
      eventKey: env.INNGEST_EVENT_KEY,
      signingKey: env.INNGEST_SIGNING_KEY,
      isDev: env.NODE_ENV !== "production",
    },

    review: {
      owner: env.REVIEW_OWNER || null,
      maxFiles: env.REVIEW_MAX_FILES,
      maxInputChars: env.REVIEW_MAX_INPUT_CHARS,
      maxInputTokens: env.REVIEW_MAX_INPUT_TOKENS,
      maxOutputTokens: env.REVIEW_MAX_OUTPUT_TOKENS,
      maxFindings: env.REVIEW_MAX_FINDINGS,
      globalConcurrency: env.REVIEW_GLOBAL_CONCURRENCY,
      dailyTokenLimit: env.REVIEW_DAILY_TOKEN_LIMIT,
      globalDailyTokenLimit: env.REVIEW_GLOBAL_DAILY_TOKEN_LIMIT,
      prDailyTokenLimit: env.REVIEW_PR_DAILY_TOKEN_LIMIT,
      killSwitch: env.REVIEW_KILL_SWITCH,
      v3: {
        enabled: env.REVIEW_V3_ENABLED === 'true',
        astraSonnet: env.REVIEW_V3_ASTRA_SONNET === 'true',
        models: env.REVIEW_V3_ASTRA_SONNET === 'true'
          ? { 'security-logic': 'gpt-6.1-sol', architecture: 'gpt-6.2-astra' }
          : env.REVIEW_V3_AGENT_MODELS,
        pricing: env.REVIEW_V3_ASTRA_SONNET === 'true'
          ? { 'gpt-6.1-sol': { input: 2, output: 10 }, 'gpt-6.2-astra': { input: 8, output: 40 }, ...env.REVIEW_V3_MODEL_PRICING }
          : env.REVIEW_V3_MODEL_PRICING,
        agentInputTokens: env.REVIEW_V3_AGENT_INPUT_TOKENS,
        agentOutputTokens: env.REVIEW_V3_AGENT_OUTPUT_TOKENS,
        agentCostMicros: env.REVIEW_V3_AGENT_COST_MICROS,
        prCostMicros: env.REVIEW_V3_PR_COST_MICROS,
        monthlyCostMicros: env.REVIEW_V3_MONTHLY_COST_MICROS,
        testBudgetBypass: env.REVIEW_V3_TEST_BUDGET_BYPASS === 'true',
        timeoutMs: env.REVIEW_V3_TIMEOUT_MS,
      },
    },
  };
}
