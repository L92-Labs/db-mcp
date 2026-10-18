import pg from "pg";
import {
  createBigQueryAdapter,
  createPostgresAdapter,
  pgClientConfig,
  type AdapterFactory,
} from "@db-mcp/core";

const pools: pg.Pool[] = [];

/** One pg.Pool per Postgres connection; BigQuery uses fetch + WebCrypto. */
export const nodeAdapterFactory: AdapterFactory = (connection, config) => {
  if (connection.engine === "bigquery") return createBigQueryAdapter(connection);

  if (!connection.url) {
    throw new Error(
      `connection "${connection.name}" uses Hyperdrive, which only exists on Workers; set url for Node/Docker`,
    );
  }
  const pool = new pg.Pool({
    ...pgClientConfig(connection, connection.url, {
      statementTimeoutMs: config.statementTimeoutMs,
      queryTimeoutMs: config.statementTimeoutMs + 5_000,
    }),
    max: Number(process.env.DB_POOL_MAX ?? "5") || 5,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", (err) => console.error(`[db-mcp] pool "${connection.name}": ${err.message}`));
  pools.push(pool);

  return createPostgresAdapter(connection, {
    async connect() {
      const client = await pool.connect();
      return { client, release: (error) => client.release(error) };
    },
  });
};

export async function closePools(): Promise<void> {
  await Promise.allSettled(pools.map((p) => p.end()));
}
