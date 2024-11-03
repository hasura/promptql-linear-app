// From original index.ts
import { start } from "@hasura/ndc-duckduckapi";
import { makeConnector, duckduckapi } from "@hasura/ndc-duckduckapi";
import * as path from "path";
import { LinearSyncManager, LinearSyncSchema } from "./functions";

const connectorConfig: duckduckapi = {
  dbSchema: `

    -- Add your SQL schema here.
    -- This SQL will be run on startup every time.
    -- CREATE TABLE TABLE_NAME (.....);
    SELECT 1;

  ` + LinearSyncSchema,
  functionsFilePath: path.resolve(__dirname, "./functions.ts"),
};

(async () => {
  const connector = await makeConnector(connectorConfig);
  start(connector);
  const manager = new LinearSyncManager();
  if (!process.env.LINEAR_API_KEY) {
    throw new Error('LINEAR_API_KEY environment variable is required');
  }
  await manager.initialize(process.env.LINEAR_API_KEY);
})();
