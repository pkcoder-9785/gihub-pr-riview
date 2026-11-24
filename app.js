import express from "express";
import { serve } from "inngest/express";
import { inngest } from "./inngest/client.js";
import { functions } from "./inngest/function/index.js";

export function createApp({ githubWebhookHandler, inngestClient = inngest, reviewFunctions = functions } = {}) {
  const app = express();

  app.disable("x-powered-by");

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "github-pr-review" });
  });

  // GitHub signatures must be checked against the original request bytes.
  // Keep this route before the JSON parser used by Inngest.
  app.post(
    "/api/github/webhooks",
    express.raw({ type: "application/json", limit: "1mb", inflate: false }),
    githubWebhookHandler ??
      ((_request, response) => {
        response.status(503).json({
          error: "GitHub webhook handler is not configured",
        });
      }),
  );

  app.use(
    "/api/inngest",
    express.json({ limit: "1mb" }),
    serve({ client: inngestClient, functions: reviewFunctions }),
  );

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found" });
  });

  app.use((error, _request, response, next) => {
    if (response.headersSent) {
      return next(error);
    }

    if (error.type === "entity.too.large") {
      return response.status(413).json({ error: "Request body too large" });
    }

    if (error.type === "entity.parse.failed") {
      return response.status(400).json({ error: "Invalid JSON body" });
    }

    if (error.status === 415) {
      return response.status(415).json({
        error: "Unsupported request encoding or charset",
      });
    }

    // Do not expose request bodies, credentials, or internal error messages.
    console.error("HTTP request failed");
    return response.status(500).json({ error: "Internal server error" });
  });

  return app;
  }
