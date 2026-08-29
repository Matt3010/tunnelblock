import Fastify from "fastify";

const app = Fastify({
  logger: true,
  bodyLimit: 10 * 1024 * 1024,
});

const token = process.env.DEBUG_TOKEN;

app.post("/events", async (request, reply) => {
  if (token) {
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      return reply.code(401).send({ ok: false });
    }
  }

  app.log.info({ event: request.body }, "vpn-debug-event");
  return { ok: true };
});

app.get("/health", async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

await app.listen({ port, host });
