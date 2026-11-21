import { installationClient } from '../../github/client.js';
import { recoverPublication } from '../../review/publish.js';

export function createPublicationRecoveryFunction(inngest, config, store, dependencies = {}) {
  const getClient = dependencies.installationClient || installationClient;

  return inngest.createFunction({
    id: 'recover-review-publications',
    triggers: { cron: '*/1 * * * *' },
    retries: 3,
    concurrency: { limit: 1 },
  }, async ({ step, runId }) => {
    const candidates = await step.run('load-publications-due-for-recovery', () => store.listRecoverablePublications(15, 50));
    const outcomes = [];

    for (const record of candidates) {
      const client = getClient(config.github, Number(record.installation_id));
      const status = await step.run(`recover-${record.id}`, () => recoverPublication({
        client,
        store,
        record,
        config,
        claimId: `${runId}:${record.id}`,
      }));
      outcomes.push({ id: record.id, status });
    }

    const unresolved = await step.run('load-unresolved-publication-alerts', () => store.listUnresolvedPublications(50));
    for (const record of unresolved) {
      console.error(JSON.stringify({ category: 'publication_recovery_unresolved', publicationId: record.id, runId }));
      await step.run(`mark-alerted-${record.id}`, () => store.markAlerted(record.id));
    }

    console.info(JSON.stringify({ category: 'publication_recovery_run', runId, checked: candidates.length, unresolved: unresolved.length }));
    return { checked: candidates.length, unresolved: unresolved.length, outcomes };
  });
}
