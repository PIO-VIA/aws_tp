import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient } from "../aws/dynamodb";
import { tableName } from "../config";

interface CacheEntry {
  blockedUntil: number | null;
  fetchedAt: number;
}

const writerBlockedCache = new Map<string, CacheEntry>();

export function resetBlockedCache(): void {
  writerBlockedCache.clear();
}

export function updateBlockedCache(writerId: string, blockedUntil: number | null): void {
  writerBlockedCache.set(writerId, {
    blockedUntil,
    fetchedAt: Date.now(),
  });
}

export async function getWriterBlockedUntil(writerId: string): Promise<number | null> {
  const nowMs = Date.now();
  const cached = writerBlockedCache.get(writerId);
  if (cached && nowMs - cached.fetchedAt < 5000) {
    return cached.blockedUntil;
  }

  const docClient = getDocClient();
  const writersTable = tableName("writers");
  const res = await docClient.send(
    new GetCommand({
      TableName: writersTable,
      Key: { writerId },
      ConsistentRead: true,
    }),
  );

  const blockedUntil = (res.Item?.blockedUntil as number) || null;
  writerBlockedCache.set(writerId, {
    blockedUntil,
    fetchedAt: nowMs,
  });
  return blockedUntil;
}
