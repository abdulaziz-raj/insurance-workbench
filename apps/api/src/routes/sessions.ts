import type { FastifyInstance } from "fastify";
import { getSession, listSessions } from "../lib/storage.js";

export async function registerSessionRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get("/sessions", async (_request, reply) => {
    const sessions = await listSessions();
    return reply.send(sessions);
  });

  app.get<{ Params: { id: string } }>(
    "/sessions/:id",
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (!session) {
        return reply.status(404).send({ error: "Session not found" });
      }
      return reply.send(session);
    }
  );
}
