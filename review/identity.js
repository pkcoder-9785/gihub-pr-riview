export const ANALYSIS_VERSION = 'v1';

export function buildReviewIdentityKey({
  installationId,
  repositoryId,
  prNumber,
  headSha,
  baseSha = '',
  configKey = '',
  version = ANALYSIS_VERSION,
}) {
  return `review:${installationId}:${repositoryId}:${prNumber}:${baseSha}:${headSha}:${version}:${configKey}`;
}
