import {
  GetCommand,
  UpdateCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { getDocClient } from "../aws/dynamodb";
import { tableName, getConfig } from "../config";
import { log } from "../log";

export interface QuotaStatus {
  used: number;
  remaining: number;
  dailyLimit: number;
  resetAt: number; // Epoch seconds (prochain 00:00 UTC)
  quotaKey: string;
}

export interface ConsumeQuotaResult {
  granted: boolean;
  used: number;
  remaining: number;
  resetAt: number;
}

export function getUtcDateString(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatQuotaKey(writerId: string, date: Date = new Date()): string {
  return `${writerId}#${getUtcDateString(date)}`;
}

export function getNextUtcMidnightEpochSec(now: Date = new Date()): number {
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(0, 0, 0, 0);
  return Math.floor(next.getTime() / 1000);
}

/**
 * Récupère le crédit d'écriture consommé et restant pour un rédacteur à la date courante (UTC).
 */
export async function getWriterQuota(writerId: string): Promise<QuotaStatus> {
  const config = getConfig();
  const docClient = getDocClient();
  const tName = tableName("quota");
  const quotaKey = formatQuotaKey(writerId);
  const resetAt = getNextUtcMidnightEpochSec();

  const res = await docClient.send(
    new GetCommand({
      TableName: tName,
      Key: { key: quotaKey },
      ConsistentRead: true,
    }),
  );

  const used = (res.Item?.used as number) ?? 0;
  const remaining = Math.max(0, config.DAILY_CREDIT - used);

  return {
    used,
    remaining,
    dailyLimit: config.DAILY_CREDIT,
    resetAt,
    quotaKey,
  };
}

/**
 * Consommation atomique de n caractères UTF-16 (Section 8.1, Invariant C4).
 * Utilise une écriture conditionnelle DynamoDB (attribute_not_exists(used) OR used <= DAILY_CREDIT - n).
 */
export async function consumeQuota(writerId: string, n: number): Promise<ConsumeQuotaResult> {
  if (n <= 0) {
    const q = await getWriterQuota(writerId);
    return { granted: true, used: q.used, remaining: q.remaining, resetAt: q.resetAt };
  }

  const config = getConfig();
  const resetAt = getNextUtcMidnightEpochSec();

  // Si la demande unitaire dépasse le crédit quotidien total, refus immédiat
  if (n > config.DAILY_CREDIT) {
    const q = await getWriterQuota(writerId);
    return { granted: false, used: q.used, remaining: q.remaining, resetAt };
  }

  const docClient = getDocClient();
  const tName = tableName("quota");
  const quotaKey = formatQuotaKey(writerId);
  const limitMinusN = config.DAILY_CREDIT - n;
  // TTL de la ligne de quota : fin de la journée + 2 jours de marge
  const ttl = resetAt + 2 * 24 * 3600;

  try {
    const res = await docClient.send(
      new UpdateCommand({
        TableName: tName,
        Key: { key: quotaKey },
        UpdateExpression: "SET used = if_not_exists(used, :zero) + :n, #ttl = :ttl",
        ConditionExpression: "attribute_not_exists(used) OR used <= :limitMinusN",
        ExpressionAttributeNames: {
          "#ttl": "ttl",
        },
        ExpressionAttributeValues: {
          ":zero": 0,
          ":n": n,
          ":limitMinusN": limitMinusN,
          ":ttl": ttl,
        },
        ReturnValues: "ALL_NEW",
      }),
    );

    const newUsed = (res.Attributes?.used as number) ?? n;
    const remaining = Math.max(0, config.DAILY_CREDIT - newUsed);

    log.debug("quota.consumed", { writerId, n, newUsed, remaining });
    return {
      granted: true,
      used: newUsed,
      remaining,
      resetAt,
    };
  } catch (err: unknown) {
    // Échec de la condition : quota dépassé
    const name = (err as { name?: string })?.name;
    if (name === "ConditionalCheckFailedException") {
      const current = await getWriterQuota(writerId);
      log.warn("quota.exceeded", { writerId, requested: n, used: current.used, remaining: current.remaining });
      return {
        granted: false,
        used: current.used,
        remaining: current.remaining,
        resetAt,
      };
    }
    throw err;
  }
}

/**
 * Enregistre un événement d'abus et bloque le rédacteur si le seuil est dépassé (Section 8.2).
 */
export async function recordAbuseEvent(
  writerId: string,
  type: "quota_refused" | "invalid_update" | "too_large" | "rate_exceeded",
  details?: string,
): Promise<{ blocked: boolean; blockedUntil?: number }> {
  const config = getConfig();
  const docClient = getDocClient();
  const abuseTable = tableName("abuse_events");
  const writersTable = tableName("writers");
  const now = Math.floor(Date.now() / 1000);
  const createdAtRand = `${now}-${randomUUID().substring(0, 8)}`;
  const ttl = now + config.ABUSE_WINDOW_SEC;

  // 1. Enregistrement de l'événement
  await docClient.send(
    new PutCommand({
      TableName: abuseTable,
      Item: {
        writerId,
        createdAtRand,
        type,
        details: details || type,
        ttl,
      },
    }),
  );

  // 2. Requête de comptage des événements récents
  const windowStart = `${now - config.ABUSE_WINDOW_SEC}-`;
  const recentEvents = await docClient.send(
    new QueryCommand({
      TableName: abuseTable,
      KeyConditionExpression: "writerId = :w AND createdAtRand >= :ws",
      ExpressionAttributeValues: {
        ":w": writerId,
        ":ws": windowStart,
      },
      ConsistentRead: true,
    }),
  );

  const count = (recentEvents.Items?.length ?? 0);
  if (count >= config.ABUSE_THRESHOLD) {
    const blockedUntil = now + config.BLOCK_DURATION_SEC;
    await docClient.send(
      new UpdateCommand({
        TableName: writersTable,
        Key: { writerId },
        UpdateExpression: "SET blockedUntil = :bu, blockReason = :br",
        ExpressionAttributeValues: {
          ":bu": blockedUntil,
          ":br": `Abus détecté (${count} événements en ${config.ABUSE_WINDOW_SEC}s - dernier: ${type})`,
        },
      }),
    );

    log.warn("abuse.writer_blocked", { writerId, count, blockedUntil, reason: type });
    return { blocked: true, blockedUntil };
  }

  return { blocked: false };
}
