import {
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomBytes } from "crypto";
import { getDocClient } from "../aws/dynamodb";
import { tableName } from "../config";
import { LinkRecord } from "./types";
import { log } from "../log";

// Cache mémoire court (1 s) pour les liens épuisés sous pic (Section 10.2.c)
const exhaustedMemoryCache = new Map<string, number>();

export function markLinkExhaustedInMemory(linkId: string): void {
  exhaustedMemoryCache.set(linkId, Date.now());
}

export function isLinkExhaustedInMemory(linkId: string): boolean {
  const cachedAt = exhaustedMemoryCache.get(linkId);
  if (!cachedAt) return false;
  if (Date.now() - cachedAt < 1000) return true;
  exhaustedMemoryCache.delete(linkId);
  return false;
}

export function resetExhaustedCache(): void {
  exhaustedMemoryCache.clear();
}

/**
 * Génère un identifiant linkId de 128 bits aléatoires en base64url (>= 22 caractères).
 */
export function generateLinkId(): string {
  return randomBytes(16).toString("base64url");
}

export async function createLink(params: {
  docId: string;
  creatorId: string;
  creatorEmail: string;
  creatorName: string;
  maxDownloads: number;
}): Promise<LinkRecord> {
  const docClient = getDocClient();
  const tName = tableName("links");
  const linkId = generateLinkId();
  const now = Math.floor(Date.now() / 1000);

  const link: LinkRecord = {
    linkId,
    docId: params.docId,
    creatorId: params.creatorId,
    creatorEmail: params.creatorEmail,
    creatorName: params.creatorName,
    maxDownloads: params.maxDownloads,
    issued: 0,
    status: "active",
    createdAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: tName,
      Item: link,
      ConditionExpression: "attribute_not_exists(linkId)",
    }),
  );

  log.info("links.created", { linkId, docId: params.docId, maxDownloads: params.maxDownloads });
  return link;
}

export async function getLink(linkId: string): Promise<LinkRecord | null> {
  const docClient = getDocClient();
  const tName = tableName("links");

  const res = await docClient.send(
    new GetCommand({
      TableName: tName,
      Key: { linkId },
    }),
  );

  return (res.Item as LinkRecord) ?? null;
}

export async function revokeLink(linkId: string, creatorId: string): Promise<boolean> {
  const docClient = getDocClient();
  const tName = tableName("links");

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tName,
        Key: { linkId },
        UpdateExpression: "SET #status = :revoked",
        ConditionExpression: "creatorId = :creatorId AND #status = :active",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":revoked": "revoked",
          ":creatorId": creatorId,
          ":active": "active",
        },
      }),
    );
    return true;
  } catch (err: unknown) {
    const error = err as { name?: string };
    if (error.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}
