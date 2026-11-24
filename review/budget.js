import { countRequestTokens } from './tokenizer.js';

export const AGENT_ROLES = Object.freeze(['context-dependency', 'security-logic', 'architecture']);
const unlimited = Number.MAX_SAFE_INTEGER;
export function agentReservation({ config, data, role, model, request, now = new Date() }) {
  if (!AGENT_ROLES.includes(role)) throw new Error('Unknown review agent');
  const options = config.review.v3;
  const price = options.pricing?.[model];
  if (!price || ![price.input, price.output].every((n) => Number.isFinite(n) && n >= 0)) return { allowed: false, reason: 'model_pricing_missing' };
  const input = countRequestTokens(model, request);
  if (input > options.agentInputTokens) return { allowed: false, reason: 'agent_input_limit' };
  const tokens = input + request.max_output_tokens;
  // USD / million tokens equals micro-USD / token. Round reservations upwards.
  const costMicros = Math.ceil(input * price.input + request.max_output_tokens * price.output);
  if (!Number.isSafeInteger(costMicros) || costMicros > options.agentCostMicros) return { allowed: false, reason: 'agent_cost_limit' };
  const day = now.toISOString().slice(0, 10), month = day.slice(0, 7);
  const repo = String(data.repositoryId), pr = `pr:${repo}:${data.prNumber}`;
  const scopes = [
    { period: day, name: 'global', tokens: config.review.globalDailyTokenLimit, costMicros: unlimited, legacyScope: 'global' },
    { period: day, name: repo, tokens: config.review.dailyTokenLimit, costMicros: unlimited, legacyScope: repo },
    { period: day, name: pr, tokens: config.review.prDailyTokenLimit, costMicros: options.prCostMicros, legacyScope: pr },
    { period: day, name: `${pr}:${role}`, tokens: options.agentInputTokens + options.agentOutputTokens, costMicros: options.agentCostMicros },
    { period: month, name: 'global-monthly', tokens: unlimited, costMicros: options.monthlyCostMicros },
  ];
  return { allowed: true, tokens, costMicros, scopes, price };
}

export function actualAgentUsage(response, price) {
  const input = response.usage?.input_tokens, output = response.usage?.output_tokens;
  if (![input, output].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
  const costMicros = Math.ceil(input * price.input + output * price.output);
  if (!Number.isSafeInteger(input + output) || !Number.isSafeInteger(costMicros)) return null;
  return { inputTokens: input, outputTokens: output, tokens: input + output, costMicros };
}
