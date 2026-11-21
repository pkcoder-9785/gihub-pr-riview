import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

import { createInngestClient } from './inngest/client.js';
import { createReviewFunction } from './inngest/function/index.js';
import { createWebhookHandler } from './github/webhook.js';
import { installationClient } from './github/client.js';
import { createPublicationRecoveryFunction } from './inngest/function/recover-publications.js';
import { Store } from './review/store.js';

let config;

try {
  config = loadConfig();
} catch (error) {
  // loadConfig reports field names only, without printing secret values.
  console.error(error.message);
  process.exitCode = 1;
}

if (config) {
  const store = new Store(config.databaseUrl);
  const inngestClient = createInngestClient(config.inngest);
  const reviewFunctions = [
    createReviewFunction(inngestClient, config, store),
    createPublicationRecoveryFunction(inngestClient, config, store),
  ];
  const githubWebhookHandler = createWebhookHandler({
    secret: config.github.webhookSecret,
    repositories: config.github.repositoryAllowlist,
    botAuthorAllowlist: config.github.botAuthorAllowlist,
    send: (event) => inngestClient.send(event),
    fetchPullRequest: async (data) => {
      const client = installationClient(config.github, data.installationId);
      return (await client.rest.pulls.get({ owner: data.owner, repo: data.repo, pull_number: data.prNumber })).data;
    },
  });
  const app = createApp({ githubWebhookHandler, inngestClient, reviewFunctions });
  const server = app.listen(config.port, () => {
    console.log(`Server running on http://localhost:${config.port}`);
  });

  server.once("error", (error) => {
    console.error(`Server could not start (${error.code ?? "UNKNOWN"})`);
    process.exitCode = 1;
  });

  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log("Stopping server...");

    const timeout = setTimeout(() => {
      console.error("Server shutdown timed out");
      process.exit(1);
    }, 30000);

    timeout.unref();

    server.close(async (error) => {
      await store.close().catch(() => { process.exitCode = 1; });
      clearTimeout(timeout);

      if (error) {
        console.error("Server shutdown failed");
        process.exitCode = 1;
      }
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
