import mysql from "mysql2/promise";
import pg from "pg";
import {
  createBigQueryAdapter,
  createMySqlAdapter,
  createPostgresAdapter,
  mysqlClientOptions,
  pgClientConfig,
  type AdapterFactory,
} from "@db-mcp/core";

const pools: Array<{ end(): Promise<void> }> = [];
const poolMax = () => Number(process.env.DB_POOL_MAX ?? "5") || 5;

/** One pg.Pool per Postgres connection; BigQuery uses fetch + WebCrypto. */
export const nodeAdapterFactory: AdapterFactory = (connection, config) => {
  if (connection.engine === "bigquery") return createBigQueryAdapter(connection);

  if (connection.engine === "mysql") {
    if (!connection.url) {
      throw new Error(
        `connection "${connection.name}" uses Hyperdrive, which only exists on Workers; set url for Node/Docker`,
      );
    }
    const pool = mysql.createPool({
      ...mysqlClientOptions(connection, { uri: connection.url }),
      connectionLimit: poolMax(),
      idleTimeout: 30_000,
    });
    pools.push(pool);
    return createMySqlAdapter(connection, {
      async connect() {
        const conn = await pool.getConnection();
        return {
          client: conn,
          release: (error) => (error && isConnectionError(error) ? conn.destroy() : conn.release()),
        };
      },
    });
  }

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
    max: poolMax(),
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

function isConnectionError(error: Error): boolean {
  const code = (error as { code?: string; fatal?: boolean }).code ?? "";
  return Boolean((error as { fatal?: boolean }).fatal) || /^(ECONN|EPIPE|PROTOCOL_)/.test(code);
}

export async function closePools(): Promise<void> {
  await Promise.allSettled(pools.map((p) => p.end()));
}
