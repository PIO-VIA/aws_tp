import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getConfig } from "../config";

let clientInstance: DynamoDBClient | null = null;
let docClientInstance: DynamoDBDocumentClient | null = null;

export function getDynamoDBClient(): DynamoDBClient {
  if (clientInstance) return clientInstance;
  const config = getConfig();
  clientInstance = new DynamoDBClient({
    region: config.AWS_REGION,
    endpoint: config.DDB_ENDPOINT,
    credentials:
      config.APP_ENV === "local"
        ? { accessKeyId: "local", secretAccessKey: "local" }
        : undefined,
  });
  return clientInstance;
}

export function getDocClient(): DynamoDBDocumentClient {
  if (docClientInstance) return docClientInstance;
  const client = getDynamoDBClient();
  docClientInstance = DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      removeUndefinedValues: true,
      convertEmptyValues: false,
    },
    unmarshallOptions: {
      wrapNumbers: false,
    },
  });
  return docClientInstance;
}

/** Réinitialise les clients (utile pour tests avec configuration différente) */
export function resetDynamoClients(): void {
  clientInstance = null;
  docClientInstance = null;
}
