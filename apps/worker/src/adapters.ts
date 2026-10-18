import mysql from "mysql2/promise";
import pg from "pg";
import {
  createBigQueryAdapter,
  createMySqlAdapter,
  createPostgresAdapter,
  mysqlClientOptions,
  pgClientConfig,
  type AdapterFactory,
  type ConnectionConfig,
  type MySqlClient,
} from "@db-mcp/core";
import { isHyperdrive, type WorkerEnv } from "./env.js";

function hyperdriveFor(
  env: WorkerEnv,
  connection: ConnectionConfig & { hyperdrive?: string },
): Hyperdrive | undefined {
  if (!connection.hyperdrive) return undefined;
  const binding = env[connection.hyperdrive];
  if (!isHyperdrive(binding)) {
    throw new Error(`connection "${connection.name}": no Hyperdrive binding named ${connection.hyperdrive}`);
  }
  return binding;
}

/** Workers: a fresh client per operation (Hyperdrive pools for us); BigQuery over fetch. */
export function workerAdapterFactory(env: WorkerEnv): AdapterFactory {
  return (connection, config) => {
    if (connection.engine === "bigquery") return createBigQueryAdapter(connection);

    const hd = hyperdriveFor(env, connection);

    if (connection.engine === "mysql") {
      const target = hd
        ? { host: hd.host, port: hd.port, user: hd.user, password: hd.password, database: hd.database }
        : { uri: connection.url! };
      const options = mysqlClientOptions(connection, target, { disableEval: true });
      return createMySqlAdapter(connection, {
        async connect() {
          const conn = await mysql.createConnection(options);
          // mysql2/promise exposes the callback connection at runtime; its typings omit it.
          return { client: conn as unknown as MySqlClient, release: () => conn.end().catch(() => undefined) };
        },
      });
    }

    const connectionString = hd?.connectionString ?? connection.url;
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
