export async function recordMetrics(store, id, repositoryId, headSha, values) {
  // Explicit fields only; caller-provided errors/prompts/source never reach telemetry.
  const metric = Object.fromEntries(['stage', 'role', 'model', 'status', 'durationMs', 'inputTokens', 'outputTokens',
    'tokens', 'costMicros', 'reservedCostMicros', 'usageKnown', 'indexedFiles', 'unindexedFiles', 'edges',
    'candidates', 'accepted', 'rejected', 'partial', 'apiReads', 'dbOperations'].filter((key) =>
    typeof values[key] === 'number' || typeof values[key] === 'boolean' || typeof values[key] === 'string' && /^[a-zA-Z0-9._:/ -]{1,100}$/.test(values[key]))
    .map((key) => [key, values[key]]));
  await store.recordAnalysisMetrics(id, repositoryId, headSha, metric);
  return metric;
}
