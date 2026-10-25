import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, ScanCommandInput } from "@aws-sdk/lib-dynamodb";
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

/**
 * Exécute un scan complet paginé en suivant LastEvaluatedKey jusqu'à épuisement (Section C-06).
 */
export async function scanAll<T = Record<string, unknown>>(
  params: ScanCommandInput,
  clientOverride?: DynamoDBDocumentClient,
): Promise<T[]> {
  const docClient = clientOverride || getDocClient();
  const allItems: T[] = [];
  let exclusiveStartKey = params.ExclusiveStartKey;

  do {
    const currentParams: ScanCommandInput = {
      ...params,
      ExclusiveStartKey: exclusiveStartKey,
    };
    const res = await docClient.send(new ScanCommand(currentParams));
    if (res.Items && res.Items.length > 0) {
      allItems.push(...(res.Items as T[]));
    }
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);

  return allItems;
}
