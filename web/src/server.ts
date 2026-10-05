import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";

const password = process.env.WEB_PASSWORD ?? "";
const adminToken = process.env.ADMIN_API_TOKEN;

if (password.length < 12) throw new Error("WEB_PASSWORD must be at least 12 characters");
if (!adminToken) throw new Error("ADMIN_API_TOKEN is required");

const app = buildApp({
  user: process.env.WEB_USER || "admin",
  password,
  adminToken,
  adminBase: process.env.ADMIN_API_BASE ?? "http://doh-a:8053",
  updaterBase: process.env.UPDATER_API_BASE ?? "http://updater:8090",
  publicDir: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public"),
  logger: true,
  trustProxy: process.env.TRUST_PROXY === "1",
});

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
