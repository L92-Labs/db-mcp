#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { loadRuntimeConfig } from "@db-mcp/core";
import { closePools } from "./adapters.js";
import { startHttp, startStdio } from "./server.js";

const envFile = process.env.DB_ENV_FILE?.trim();
loadDotenv(envFile ? { path: resolve(envFile), quiet: true } : { quiet: true });

const config = loadRuntimeConfig(process.env);
const transport = (process.env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();

async function shutdown(): Promise<void> {
  await closePools();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

if (transport === "http" || transport === "streamable-http") {
  if (!config.mcpBearerToken) {
    console.error("MCP_BEARER_TOKEN is required for HTTP transport");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? "8787") || 8787;
  await startHttp(config, port);
} else {
  await startStdio(config);
}
