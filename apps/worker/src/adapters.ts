import pg from "pg";
import {
  createBigQueryAdapter,
  createPostgresAdapter,
  pgClientConfig,
  type AdapterFactory,
} from "@db-mcp/core";
import { isHyperdrive, type WorkerEnv } from "./env.js";

/** Workers: a fresh pg.Client per operation (Hyperdrive pools for us); BigQuery over fetch. */
export function workerAdapterFactory(env: WorkerEnv): AdapterFactory {
  return (connection, config) => {
    if (connection.engine === "bigquery") return createBigQueryAdapter(connection);

    let connectionString = connection.url;
    if (connection.hyperdrive) {
      const binding = env[connection.hyperdrive];
      if (!isHyperdrive(binding)) {
        throw new Error(
          `connection "${connection.name}": no Hyperdrive binding named ${connection.hyperdrive}`,
        );
      }
      connectionString = binding.connectionString;
    }
    if (!connectionString) throw new Error(`connection "${connection.name}" has no url or hyperdrive`);
    const clientConfig = pgClientConfig(connection, connectionString, {
      queryTimeoutMs: config.statementTimeoutMs + 5_000,
    });

    return createPostgresAdapter(connection, {
      async connect() {
        const client = new pg.Client(clientConfig);
        await client.connect();
        return { client, release: () => client.end().catch(() => undefined) };
      },
    });
  };
}
