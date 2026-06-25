import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env from the monorepo root regardless of cwd (npm workspaces sets cwd to apps/api)
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerRuleRoutes } from "./routes/rules.js";
import { registerPublishRoutes } from "./routes/publish.js";
import { registerSchemaRoutes } from "./routes/schema.js";
import { registerInterviewRoutes } from "./routes/interview.js";
import { migrateRulesetFilenames } from "./lib/ruleset-storage.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: ["http://localhost:5173"],
});

await app.register(multipart);

app.get("/health", async () => {
  return { status: "ok" };
});

app.get("/hello", async () => {
  return {
    message: "Rules Workbench API is live",
    timestamp: new Date().toISOString(),
  };
});

await migrateRulesetFilenames();

await registerIngestRoutes(app);
await registerRuleRoutes(app);
await registerPublishRoutes(app);
await registerSchemaRoutes(app);
await registerInterviewRoutes(app);

const port = Number(process.env.PORT) || 3001;

try {
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`API server listening on http://localhost:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
