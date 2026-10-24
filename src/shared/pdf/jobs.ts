import {
  PutCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getDocClient } from "../aws/dynamodb";
import { tableName } from "../config";
import { PdfJobRecord } from "../links/types";
import { log } from "../log";

export function formatJobId(docId: string, versionId: string): string {
  return `${docId}#${versionId}`;
}

/**
 * Crée un job PDF en mode single-flight :
 * PutItem avec attribute_not_exists(jobId).
 * Retourne `true` si le job a été créé par cet appelant (qui doit alors publier dans SQS).
 * Retourne `false` si un job existe déjà pour cette version.
 */
export async function createPdfJobIfNotExists(
  docId: string,
  versionId: string,
): Promise<{ created: boolean; job?: PdfJobRecord }> {
  const docClient = getDocClient();
  const tName = tableName("pdf_jobs");
  const jobId = formatJobId(docId, versionId);
  const now = Math.floor(Date.now() / 1000);

  const job: PdfJobRecord = {
    jobId,
    docId,
    versionId,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: tName,
        Item: job,
        ConditionExpression: "attribute_not_exists(jobId)",
      }),
    );
    log.info("pdf_job.created", { jobId, docId, versionId });
    return { created: true, job };
  } catch (err: unknown) {
    const error = err as { name?: string };
    if (error.name === "ConditionalCheckFailedException") {
      log.debug("pdf_job.already_exists", { jobId });
      const existing = await getPdfJob(docId, versionId);
      return { created: false, job: existing ?? undefined };
    }
    throw err;
  }
}

export async function getPdfJob(
  docId: string,
  versionId: string,
): Promise<PdfJobRecord | null> {
  const docClient = getDocClient();
  const tName = tableName("pdf_jobs");
  const jobId = formatJobId(docId, versionId);

  const res = await docClient.send(
    new GetCommand({
      TableName: tName,
      Key: { jobId },
    }),
  );

  return (res.Item as PdfJobRecord) ?? null;
}

/**
 * Transition atomique d'état d'un job (ex: pending -> running, running -> done).
 */
export async function transitionPdfJob(
  docId: string,
  versionId: string,
  fromStatus: "pending" | "running",
  toStatus: "running" | "done" | "failed",
  error?: string,
): Promise<boolean> {
  const docClient = getDocClient();
  const tName = tableName("pdf_jobs");
  const jobId = formatJobId(docId, versionId);
  const now = Math.floor(Date.now() / 1000);

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tName,
        Key: { jobId },
        UpdateExpression:
          "SET #status = :toStatus, attempts = attempts + :one, updatedAt = :now, #err = :err",
        ConditionExpression: "#status = :fromStatus",
        ExpressionAttributeNames: {
          "#status": "status",
          "#err": "error",
        },
        ExpressionAttributeValues: {
          ":fromStatus": fromStatus,
          ":toStatus": toStatus,
          ":one": toStatus === "running" ? 1 : 0,
          ":now": now,
          ":err": error ?? null,
        },
      }),
    );
    return true;
  } catch (err: unknown) {
    const e = err as { name?: string };
    if (e.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw err;
  }
}
