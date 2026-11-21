import { createHmac, timingSafeEqual } from 'node:crypto';

export const REVIEW_EVENT = 'github/pullrequest.review';
export const CANCEL_REVIEW_EVENT = 'github/pullrequest.review.cancel';

export function pullRequestKey(data) {
  return `${data.installationId}:${data.repositoryId}:${data.prNumber}`;
}

export function optedOut(pr, botAuthorAllowlist = []) {
  const allowedBots = new Set(botAuthorAllowlist.map((name) => name.toLowerCase()));
  const botAuthor = pr.user?.type === 'Bot' && !allowedBots.has(pr.user?.login?.toLowerCase());
  const skipLabel = pr.labels?.some((label) => label.name?.toLowerCase() === 'skip-ai-review');
  return pr.state !== 'open' || pr.draft === true || botAuthor ||
    /\[skip review\]/i.test(pr.title || '') || Boolean(skipLabel);
}

function relevantAction(payload) {
  const action = payload.action;
  if (['opened', 'synchronize', 'reopened', 'ready_for_review', 'closed', 'converted_to_draft'].includes(action)) {
    return true;
  }
  if (action === 'edited') return Boolean(payload.changes?.base || payload.changes?.title);
  if (action === 'labeled' || action === 'unlabeled') {
    return payload.label?.name?.toLowerCase() === 'skip-ai-review';
  }
  return false;
}

function validMetadata(payload, deliveryId) {
  const data = {
    installationId: payload.installation?.id,
    repositoryId: payload.repository?.id,
    owner: payload.repository?.owner?.login,
    repo: payload.repository?.name,
    prNumber: payload.pull_request?.number,
    deliveryId,
  };

  if (![data.installationId, data.repositoryId, data.prNumber].every((value) => Number.isSafeInteger(value) && value > 0)) return null;
  if (![data.owner, data.repo, data.deliveryId].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 256)) return null;
  return data;
}

function safeSignature(req, secret) {
  const signature = req.get('x-hub-signature-256');
  if (!Buffer.isBuffer(req.body) || !/^sha256=[a-f0-9]{64}$/i.test(signature || '')) return false;
  const expected = createHmac('sha256', secret).update(req.body).digest();
  const supplied = Buffer.from(signature.slice(7), 'hex');
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}

export function createWebhookHandler({
  secret,
  repositories,
  botAuthorAllowlist = [],
  send,
  fetchPullRequest,
}) {
  const allowlist = new Set(repositories.map((repository) => repository.toLowerCase()));

  return async (req, res) => {
    if (!safeSignature(req, secret)) return res.status(401).json({ error: 'Invalid signature' });

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const ignore = () => res.status(202).json({ status: 'ignored' });
    if (req.get('x-github-event') !== 'pull_request' || !relevantAction(payload)) return ignore();

    const data = validMetadata(payload, req.get('x-github-delivery'));
    if (!data) return res.status(400).json({ error: 'Invalid event metadata' });

    const repository = `${data.owner}/${data.repo}`.toLowerCase();
    if (!allowlist.has(repository)) return ignore();

    const prKey = pullRequestKey(data);
    try {
      let current;
      try {
        current = await fetchPullRequest(data);
      } catch (error) {
        if (error.status === 404) return res.status(202).json({ status: 'ignored' });
        throw error;
      }

      if (!current || typeof current !== 'object') throw new Error('GitHub PR lookup failed');
      const observedAt = typeof current.updated_at === 'string' ? current.updated_at : new Date().toISOString();

      if (optedOut(current, botAuthorAllowlist)) {
        await send({
          id: `${data.deliveryId}:cancel`,
          name: CANCEL_REVIEW_EVENT,
          data: { prKey, reason: 'ineligible', observedAt },
        });
        return res.status(202).json({ status: 'ignored' });
      }

      if (typeof current.head?.sha !== 'string' || typeof current.base?.sha !== 'string') {
        return res.status(400).json({ error: 'Invalid current pull request state' });
      }

      await send({
        id: data.deliveryId,
        name: REVIEW_EVENT,
        data: {
          ...data,
          prKey,
          observedHeadSha: current.head.sha,
          observedBaseSha: current.base.sha,
          observedAt,
          action: payload.action,
        },
      });
      return res.status(202).json({ status: 'accepted' });
    } catch {
      console.error(JSON.stringify({ category: 'github_webhook_enqueue_or_lookup_failed', deliveryId: data.deliveryId }));
      return res.status(503).json({ error: 'Webhook could not be queued' });
    }
  };
}
