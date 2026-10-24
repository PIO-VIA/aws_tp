import { QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import * as Y from "yjs";
import { getDocClient } from "../aws/dynamodb";
import { getObjectBuffer } from "../aws/s3";
import { tableName, getConfig } from "../config";
import { log } from "../log";

export interface SnapshotRecord {
  docId: string;
  snapshotId: string;
  s3Key: string;
  upToSeq: number;
  textHash: string;
  chars: number;
  reason: "auto" | "idle" | "manual" | "restore" | "unload";
  createdBy: string;
  createdAt: number;
}

/**
 * Liste les versions / snapshots enregistrés pour un document, du plus récent au plus ancien (F05).
 */
export async function listDocumentSnapshots(docId: string): Promise<SnapshotRecord[]> {
  const docClient = getDocClient();
  const snapTable = tableName("doc_snapshots");

  const res = await docClient.send(
    new QueryCommand({
      TableName: snapTable,
      KeyConditionExpression: "docId = :docId",
      ExpressionAttributeValues: { ":docId": docId },
      ScanIndexForward: false, // Plus récent d'abord
    }),
  );

  return (res.Items as SnapshotRecord[]) ?? [];
}

/**
 * Récupère le texte brut d'un snapshot donné depuis S3.
 */
export async function getSnapshotContent(
  docId: string,
  snapshotId: string,
): Promise<{ text: string; snapshot: SnapshotRecord } | null> {
  const docClient = getDocClient();
  const snapTable = tableName("doc_snapshots");

  const res = await docClient.send(
    new GetCommand({
      TableName: snapTable,
      Key: { docId, snapshotId },
    }),
  );

  const snapshot = res.Item as SnapshotRecord | undefined;
  if (!snapshot) return null;

  const buf = await getObjectBuffer(snapshot.s3Key);
  if (!buf) {
    log.error("history.snapshot_buffer_missing", { s3Key: snapshot.s3Key });
    return null;
  }

  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, new Uint8Array(buf));
  const text = ydoc.getText("content").toString();

  return { text, snapshot };
}

/**
 * Vérifie et consomme atomiquement la limite de fréquence de restauration (Section 7.6 : max 10/h).
 */
export async function checkAndIncrementRestoreRateLimit(
  writerId: string,
): Promise<{ allowed: boolean; remaining: number }> {
  const docClient = getDocClient();
  const quotaTable = tableName("quota");
  const MAX_PER_HOUR = 10;

  const now = new Date();
  const hourKey = `${now.toISOString().substring(0, 13)}`; // YYYY-MM-DDTHH
  const partitionKey = `${writerId}#restore#${hourKey}`;
  const ttl = Math.floor(now.getTime() / 1000) + 7200; // 2h TTL

  try {
    const res = await docClient.send(
      new UpdateCommand({
        TableName: quotaTable,
        Key: { key: partitionKey },
        UpdateExpression: "SET used = if_not_exists(used, :zero) + :one, #ttl = :ttl",
        ConditionExpression: "attribute_not_exists(used) OR used < :max",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: {
          ":zero": 0,
          ":one": 1,
          ":max": MAX_PER_HOUR,
          ":ttl": ttl,
        },
        ReturnValues: "ALL_NEW",
      }),
    );

    const used = (res.Attributes?.used as number) ?? 1;
    return { allowed: true, remaining: Math.max(0, MAX_PER_HOUR - used) };
  } catch (err: unknown) {
    const error = err as { name?: string };
    if (error.name === "ConditionalCheckFailedException") {
      log.warn("history.restore_rate_limit_exceeded", { writerId });
      return { allowed: false, remaining: 0 };
    }
    throw err;
  }
}

/**
 * Déclenche une restauration de version via l'API interne du serveur collab (Section 7.6, I08).
 * La restauration crée une nouvelle évolution sans écraser les versions antérieures et ne consomme pas de crédit quotidien.
 */
export async function requestRestore(
  docId: string,
  snapshotId: string,
  writerId: string,
): Promise<{ success: boolean; snapshotId: string; versionId: string }> {
  // 1. Limite de fréquence : max 10 restaurations par heure
  const rateLimit = await checkAndIncrementRestoreRateLimit(writerId);
  if (!rateLimit.allowed) {
    throw new Error("Limite de fréquence atteinte : maximum 10 restaurations par heure");
  }

  // 2. Récupérer le contenu du snapshot demandé
  const snapshotData = await getSnapshotContent(docId, snapshotId);
  if (!snapshotData) {
    throw new Error("Version introuvable");
  }

  const config = getConfig();
  const collabUrl = `http://${config.COLLAB_INTERNAL_HOST}:${config.COLLAB_INTERNAL_PORT}/internal/documents/${docId}/restore`;

  const res = await fetch(collabUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-token": config.INTERNAL_TOKEN,
    },
    body: JSON.stringify({
      targetText: snapshotData.text,
      snapshotId,
      byWriterId: writerId,
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: "Erreur serveur collab" }));
    throw new Error(errBody.error || `Erreur serveur collab (${res.status})`);
  }

  const data = (await res.json()) as { snapshotId: string; versionId: string };
  return { success: true, snapshotId: data.snapshotId, versionId: data.versionId };
}

/**
 * Déclenche la création d'un snapshot manuel sur le serveur collab.
 */
export async function requestSnapshot(
  docId: string,
  reason = "manual",
  writerId?: string,
): Promise<{ snapshotId: string; versionId: string }> {
  const config = getConfig();
  const collabUrl = `http://${config.COLLAB_INTERNAL_HOST}:${config.COLLAB_INTERNAL_PORT}/internal/documents/${docId}/snapshot`;

  const res = await fetch(collabUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-token": config.INTERNAL_TOKEN,
    },
    body: JSON.stringify({
      reason,
      byWriterId: writerId,
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: "Erreur serveur collab" }));
    throw new Error(errBody.error || `Erreur serveur collab (${res.status})`);
  }

  return (await res.json()) as { snapshotId: string; versionId: string };
}
