import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import * as Y from "yjs";
import { getDocClient } from "../aws/dynamodb";
import { tableName, getConfig } from "../config";
import { putObjectIfNotExist, getObjectBuffer } from "../aws/s3";
import { computeVersionId } from "../pdf/render";
import { log } from "../log";

export interface DocHead {
  docId: string;
  versionId: string;
  textHash: string;
  textKey: string;
  upToSeq: number;
  chars: number;
  updatedAt: number;
  text: string;
}

interface CoalesceCacheEntry {
  head: DocHead;
  cachedAt: number;
}

const coalesceCache = new Map<string, CoalesceCacheEntry>();

export function resetHeadCache(): void {
  coalesceCache.clear();
}

/**
 * Récupère ou reconstruit la version courante (Head) d'un document.
 * Exécutée UNIQUEMENT pour un gagnant de réservation (<= N fois par lien).
 */
export async function getHead(docId: string): Promise<DocHead> {
  const config = getConfig();
  const now = Date.now();

  // 4. Coalescence en cache mémoire par processus
  if (config.HEAD_COALESCE_MS > 0) {
    const cached = coalesceCache.get(docId);
    if (cached && now - cached.cachedAt < config.HEAD_COALESCE_MS) {
      log.debug("head.cache_hit", { docId, versionId: cached.head.versionId });
      return cached.head;
    }
  }

  const docClient = getDocClient();
  const headsTable = tableName("doc_heads");
  const updatesTable = tableName("doc_updates");

  // 1. GetItem doc_heads + Query doc_updates (dernier seq)
  const [headRes, updatesRes] = await Promise.all([
    docClient.send(
      new GetCommand({
        TableName: headsTable,
        Key: { docId },
        ConsistentRead: true,
      }),
    ),
    docClient.send(
      new QueryCommand({
        TableName: updatesTable,
        KeyConditionExpression: "docId = :docId",
        ExpressionAttributeValues: { ":docId": docId },
        ScanIndexForward: false,
        Limit: 1,
        ConsistentRead: true,
      }),
    ),
  ]);

  const existingHead = headRes.Item as (DocHead & { textHash?: string }) | undefined;
  const latestSeq = updatesRes.Items?.[0]?.seq as number | undefined;

  // 2. Si le head enregistré correspond au dernier seq du journal
  if (existingHead && latestSeq !== undefined && existingHead.upToSeq === latestSeq) {
    // Si le texte n'était pas stocké en mémoire, on le charge depuis S3
    let text = existingHead.text;
    if (!text && existingHead.textKey) {
      const buf = await getObjectBuffer(existingHead.textKey);
      text = buf ? buf.toString("utf-8") : "";
    }
    const fullHead: DocHead = {
      ...existingHead,
      versionId: existingHead.versionId || existingHead.textHash || computeVersionId(text || ""),
      text: text || "",
    };
    coalesceCache.set(docId, { head: fullHead, cachedAt: now });
    return fullHead;
  }

  // Si pas d'updates et pas de head, mais peut-être un snapshot existant ou document vierge
  if (!existingHead && latestSeq === undefined) {
    // Document vierge par défaut
    const defaultText = "";
    const versionId = computeVersionId(defaultText);
    const textKey = `texts/${docId}/${versionId}.txt`;
    await putObjectIfNotExist(textKey, defaultText, "text/plain; charset=utf-8");

    const head: DocHead = {
      docId,
      versionId,
      textHash: versionId,
      textKey,
      upToSeq: 0,
      chars: 0,
      updatedAt: Math.floor(now / 1000),
      text: defaultText,
    };

    coalesceCache.set(docId, { head, cachedAt: now });
    return head;
  }

  // 3. Reconstruire (dernier snapshot + journal > upToSeq) dans un Y.Doc
  const ydoc = new Y.Doc();
  let baseSeq = 0;

  // Charger le dernier snapshot s'il existe
  const snapshotsTable = tableName("doc_snapshots");
  const snapRes = await docClient.send(
    new QueryCommand({
      TableName: snapshotsTable,
      KeyConditionExpression: "docId = :docId",
      ExpressionAttributeValues: { ":docId": docId },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );

  const latestSnap = snapRes.Items?.[0];
  if (latestSnap?.s3Key) {
    const snapBuf = await getObjectBuffer(latestSnap.s3Key);
    if (snapBuf) {
      Y.applyUpdate(ydoc, new Uint8Array(snapBuf));
      baseSeq = (latestSnap.upToSeq as number) || 0;
    }
  }

  // Rejouer le journal d'updates > baseSeq
  let startSeq = baseSeq;
  let hasMore = true;
  let maxSeqEncountered = baseSeq;

  while (hasMore) {
    const journalRes = await docClient.send(
      new QueryCommand({
        TableName: updatesTable,
        KeyConditionExpression: "docId = :docId AND seq > :seq",
        ExpressionAttributeValues: {
          ":docId": docId,
          ":seq": startSeq,
        },
        ScanIndexForward: true,
        Limit: 100,
        ConsistentRead: true,
      }),
    );

    const items = journalRes.Items ?? [];
    for (const item of items) {
      const u = item.update as Uint8Array | Buffer;
      if (u) {
        Y.applyUpdate(ydoc, new Uint8Array(u));
      }
      if (typeof item.seq === "number" && item.seq > maxSeqEncountered) {
        maxSeqEncountered = item.seq;
      }
    }

    if (items.length < 100) {
      hasMore = false;
    } else {
      startSeq = maxSeqEncountered;
    }
  }

  // Extraire le texte du Y.Text "content"
  const text = ydoc.getText("content").toString();
  const versionId = computeVersionId(text);
  const textKey = `texts/${docId}/${versionId}.txt`;

  // Écrire texts/<docId>/<versionId>.txt avec If-None-Match: *
  await putObjectIfNotExist(textKey, text, "text/plain; charset=utf-8");

  const head: DocHead = {
    docId,
    versionId,
    textHash: versionId,
    textKey,
    upToSeq: maxSeqEncountered,
    chars: text.length,
    updatedAt: Math.floor(now / 1000),
    text,
  };

  // Mettre à jour doc_heads (en best-effort conditionnel upToSeq < nouveau seq)
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: headsTable,
        Key: { docId },
        UpdateExpression:
          "SET versionId = :v, textHash = :v, textKey = :tk, upToSeq = :seq, #chars = :ch, updatedAt = :up",
        ConditionExpression: "attribute_not_exists(upToSeq) OR upToSeq <= :seq",
        ExpressionAttributeNames: { "#chars": "chars" },
        ExpressionAttributeValues: {
          ":v": versionId,
          ":tk": textKey,
          ":seq": maxSeqEncountered,
          ":ch": text.length,
          ":up": Math.floor(now / 1000),
        },
      }),
    );
  } catch {
    // Conflit concurrent acceptable si un autre process a écrit un head plus récent
    log.debug("head.update_conflict", { docId, maxSeqEncountered });
  }

  coalesceCache.set(docId, { head, cachedAt: now });
  return head;
}
