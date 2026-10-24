/**
 * Script d'initialisation locale :
 * - Crée les 12 tables DynamoDB avec clés, GSI, TTL et Stream
 * - Crée le bucket MinIO
 * - Vérifie ou crée les files SQS dans ElasticMQ
 */
import {
  CreateTableCommand,
  DescribeTableCommand,
  UpdateTimeToLiveCommand,
  CreateTableCommandInput,
} from "@aws-sdk/client-dynamodb";
import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { CreateQueueCommand, GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import { getConfig, tableName, TableKey } from "../src/shared/config";
import { getDynamoDBClient } from "../src/shared/aws/dynamodb";
import { getS3Client } from "../src/shared/aws/s3";
import { getSQSClient } from "../src/shared/aws/sqs";

async function createTableIfNotExists(params: CreateTableCommandInput, ttlAttr?: string) {
  const ddb = getDynamoDBClient();
  const name = params.TableName!;

  try {
    await ddb.send(new DescribeTableCommand({ TableName: name }));
    console.log(`[DynamoDB] Table ${name} existe déjà.`);
  } catch (err: unknown) {
    const error = err as { name?: string };
    if (error.name === "ResourceNotFoundException") {
      console.log(`[DynamoDB] Création de la table ${name}...`);
      await ddb.send(new CreateTableCommand(params));
      console.log(`[DynamoDB] Table ${name} créée avec succès.`);

      if (ttlAttr) {
        try {
          await ddb.send(
            new UpdateTimeToLiveCommand({
              TableName: name,
              TimeToLiveSpecification: {
                Enabled: true,
                AttributeName: ttlAttr,
              },
            }),
          );
          console.log(`[DynamoDB] TTL activé sur ${name} (${ttlAttr}).`);
        } catch (ttlErr) {
          console.warn(`[DynamoDB] Avertissement TTL sur ${name}:`, ttlErr);
        }
      }
    } else {
      throw err;
    }
  }
}

export async function initDynamoDBTables(prefix?: string) {
  const getTName = (k: TableKey) => (prefix ? `${prefix}${k}` : tableName(k));

  // 1. writers
  await createTableIfNotExists({
    TableName: getTName("writers"),
    KeySchema: [{ AttributeName: "writerId", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "writerId", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
  });

  // 2. documents
  await createTableIfNotExists({
    TableName: getTName("documents"),
    KeySchema: [{ AttributeName: "docId", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "docId", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
  });

  // 3. doc_permissions (avec GSI by_writer)
  await createTableIfNotExists({
    TableName: getTName("doc_permissions"),
    KeySchema: [
      { AttributeName: "docId", KeyType: "HASH" },
      { AttributeName: "writerId", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "docId", AttributeType: "S" },
      { AttributeName: "writerId", AttributeType: "S" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "by_writer",
        KeySchema: [
          { AttributeName: "writerId", KeyType: "HASH" },
          { AttributeName: "docId", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
    BillingMode: "PAY_PER_REQUEST",
  });

  // 4. doc_updates (seq = N)
  await createTableIfNotExists(
    {
      TableName: getTName("doc_updates"),
      KeySchema: [
        { AttributeName: "docId", KeyType: "HASH" },
        { AttributeName: "seq", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "docId", AttributeType: "S" },
        { AttributeName: "seq", AttributeType: "N" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    },
    "ttl",
  );

  // 5. doc_snapshots
  await createTableIfNotExists({
    TableName: getTName("doc_snapshots"),
    KeySchema: [
      { AttributeName: "docId", KeyType: "HASH" },
      { AttributeName: "snapshotId", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "docId", AttributeType: "S" },
      { AttributeName: "snapshotId", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  });

  // 6. doc_heads
  await createTableIfNotExists({
    TableName: getTName("doc_heads"),
    KeySchema: [{ AttributeName: "docId", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "docId", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
  });

  // 7. quota
  await createTableIfNotExists(
    {
      TableName: getTName("quota"),
      KeySchema: [{ AttributeName: "key", KeyType: "HASH" }],
      AttributeDefinitions: [{ AttributeName: "key", AttributeType: "S" }],
      BillingMode: "PAY_PER_REQUEST",
    },
    "ttl",
  );

  // 8. abuse_events
  await createTableIfNotExists(
    {
      TableName: getTName("abuse_events"),
      KeySchema: [
        { AttributeName: "writerId", KeyType: "HASH" },
        { AttributeName: "createdAtRand", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "writerId", AttributeType: "S" },
        { AttributeName: "createdAtRand", AttributeType: "S" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    },
    "ttl",
  );

  // 9. links (Stream activé : NEW_AND_OLD_IMAGES)
  await createTableIfNotExists({
    TableName: getTName("links"),
    KeySchema: [{ AttributeName: "linkId", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "linkId", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
    StreamSpecification: {
      StreamEnabled: true,
      StreamViewType: "NEW_AND_OLD_IMAGES",
    },
  });

  // 10. reservations
  await createTableIfNotExists(
    {
      TableName: getTName("reservations"),
      KeySchema: [
        { AttributeName: "linkId", KeyType: "HASH" },
        { AttributeName: "reservationId", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "linkId", AttributeType: "S" },
        { AttributeName: "reservationId", AttributeType: "S" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    },
    "ttl",
  );

  // 11. pdf_jobs
  await createTableIfNotExists({
    TableName: getTName("pdf_jobs"),
    KeySchema: [{ AttributeName: "jobId", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "jobId", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
  });

  // 12. notifications
  await createTableIfNotExists({
    TableName: getTName("notifications"),
    KeySchema: [{ AttributeName: "linkId", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "linkId", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
  });
}

export async function initS3Bucket() {
  const config = getConfig();
  const s3 = getS3Client();

  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
    console.log(`[S3] Bucket ${config.S3_BUCKET} existe déjà.`);
  } catch {
    console.log(`[S3] Création du bucket ${config.S3_BUCKET}...`);
    try {
      await s3.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
      console.log(`[S3] Bucket ${config.S3_BUCKET} créé avec succès.`);
    } catch (createErr) {
      console.warn(`[S3] Note création bucket:`, createErr);
    }
  }
}

export async function initSQSQueues() {
  const sqs = getSQSClient();

  // 1. DLQ d'abord
  try {
    await sqs.send(new GetQueueUrlCommand({ QueueName: "pdf-jobs-dlq" }));
    console.log(`[SQS] File pdf-jobs-dlq disponible.`);
  } catch {
    try {
      await sqs.send(new CreateQueueCommand({ QueueName: "pdf-jobs-dlq" }));
      console.log(`[SQS] File pdf-jobs-dlq créée.`);
    } catch (err) {
      console.warn(`[SQS] Note création DLQ:`, err);
    }
  }

  // 2. Main queue
  try {
    await sqs.send(new GetQueueUrlCommand({ QueueName: "pdf-jobs" }));
    console.log(`[SQS] File pdf-jobs disponible.`);
  } catch {
    try {
      await sqs.send(new CreateQueueCommand({ QueueName: "pdf-jobs" }));
      console.log(`[SQS] File pdf-jobs créée.`);
    } catch (err) {
      console.warn(`[SQS] Note création queue:`, err);
    }
  }
}

async function main() {
  console.log("=== Initialisation de l'environnement local ===");
  await initDynamoDBTables();
  await initS3Bucket();
  await initSQSQueues();
  console.log("=== Initialisation terminée avec succès ===");
}

if (require.main === module || process.argv[1]?.endsWith("local-init.ts")) {
  main().catch((err) => {
    console.error("Échec de l'initialisation locale :", err);
    process.exit(1);
  });
}
