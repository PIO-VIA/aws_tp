/**
 * Serveur de collaboration Hocuspocus (Section 7).
 * - Authentification par token JWT (5 min) avec vérification DynamoDB.
 * - Write-ahead logging dans doc_updates avant application et diffusion (C2, D-12).
 * - Facturation UTF-16 idempotente avec IntervalSet (D-07, I06, C4).
 * - Protocole de refus write_refused (Section 7.4).
 * - Snapshots périodiques dans S3 et maintien de doc_heads (Section 7.5).
 * - Serveur HTTP interne sur port 1235 (/health, /open-documents, /snapshot, /restore).
 */
import http from "http";
import { Server, Connection } from "@hocuspocus/server";
import * as Y from "yjs";
import { PutCommand, QueryCommand, BatchWriteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { randomBytes } from "crypto";
import { getConfig, tableName } from "../src/shared/config";
import { getDocClient } from "../src/shared/aws/dynamodb";
import { putObjectIfNotExist, putObject, getObjectBuffer } from "../src/shared/aws/s3";
import { verifyCollabToken, timingSafeCompare } from "../src/shared/auth/jwt";
import { getWriter } from "../src/shared/auth/session";
import { getDocumentPermission } from "../src/shared/docs/documents";
import { computeVersionId, renderPdfBuffer } from "../src/shared/pdf/render";
import { IntervalSet } from "../src/shared/yjs/interval-set";
import { parseAndValidateUpdate } from "../src/shared/yjs/message-parser";
import { consumeQuota, recordAbuseEvent } from "../src/shared/quota/quota";
import { log } from "../src/shared/log";

export interface DocState {
  nextSeq: number;
  intervalSet: IntervalSet;
  updatesSinceSnapshot: number;
  lastSnapshotAt: number;
  latestSeq: number;
  inFlight: Set<number>;
}

interface CollabContext {
  writerId: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  isReadOnly: boolean;
}

const docStates = new Map<string, DocState>();

export function safeUpToSeq(state: { latestSeq: number; inFlight: Set<number> }): number {
  if (!state.inFlight || state.inFlight.size === 0) {
    return state.latestSeq;
  }
  let min = Infinity;
  for (const s of state.inFlight) {
    if (s < min) min = s;
  }
  return min - 1;
}

export function resetDocStates(): void {
  docStates.clear();
}

export function getOrCreateDocState(docId: string): DocState {
  let state = docStates.get(docId);
  if (!state) {
    state = {
      nextSeq: 1,
      intervalSet: new IntervalSet(),
      updatesSinceSnapshot: 0,
      lastSnapshotAt: Date.now(),
      latestSeq: 0,
      inFlight: new Set<number>(),
    };
    docStates.set(docId, state);
  }
  return state;
}

/**
 * Enregistre un snapshot complet du document dans S3 et DynamoDB (Section 7.5).
 */
export async function persistDocumentSnapshot(
  docId: string,
  ydoc: Y.Doc,
  reason: "auto" | "idle" | "manual" | "restore" | "unload",
  byWriterId?: string,
): Promise<{ snapshotId: string; versionId: string }> {
  const docClient = getDocClient();
  const config = getConfig();
  const state = getOrCreateDocState(docId);
  const now = Math.floor(Date.now() / 1000);

  // Synchronously capture upToSeq and snapshotBytes in the same tick before ANY await
  const upToSeq = safeUpToSeq(state);
  const snapshotBytes = Y.encodeStateAsUpdate(ydoc);
  const text = ydoc.getText("content").toString();
  const versionId = computeVersionId(text);

  const datePrefix = new Date().toISOString().replace(/[-:T.Z]/g, "").substring(0, 17);
  const rand = randomBytes(4).toString("hex");
  const snapshotId = `${datePrefix}-${rand}`;
  const s3Key = `snapshots/${docId}/${snapshotId}.ydoc`;

  await putObject(s3Key, Buffer.from(snapshotBytes), "application/octet-stream");

  const textKey = `texts/${docId}/${versionId}.txt`;
  await putObjectIfNotExist(textKey, text, "text/plain; charset=utf-8");

  // 2b. Génération proactive immédiate du PDF dans S3 (disponible instantanément pour les liens)
  const pdfKey = `pdfs/${docId}/${versionId}.pdf`;
  try {
    const docRes = await docClient.send(
      new GetCommand({
        TableName: tableName("documents"),
        Key: { docId },
      }),
    );
    const title = (docRes.Item?.title as string) || "Document";
    const pdfBuffer = await renderPdfBuffer(title, text, versionId);
    await putObjectIfNotExist(pdfKey, pdfBuffer, "application/pdf");
    log.info("collab.snapshot.pdf_prerendered", { docId, versionId });
  } catch (pdfErr) {
    log.warn("collab.snapshot.pdf_prerender_error", { docId, versionId, error: pdfErr });
  }

  // 3. Enregistrement dans doc_snapshots
  await docClient.send(
    new PutCommand({
      TableName: tableName("doc_snapshots"),
      Item: {
        docId,
        snapshotId,
        s3Key,
        upToSeq,
        textHash: versionId,
        chars: text.length,
        reason,
        createdBy: byWriterId || "system",
        createdAt: now,
      },
    }),
  );

  // 4. Mise à jour de doc_heads
  await docClient.send(
    new PutCommand({
      TableName: tableName("doc_heads"),
      Item: {
        docId,
        versionId,
        textHash: versionId,
        textKey,
        upToSeq,
        chars: text.length,
        updatedAt: now,
      },
    }),
  );

  state.updatesSinceSnapshot = 0;
  state.lastSnapshotAt = Date.now();

  log.info("collab.snapshot.created", {
    docId,
    snapshotId,
    versionId,
    upToSeq,
    reason,
  });

  // 5. Best-effort : suppression des updates journalisés <= upToSeq - config.REPLAY_MARGIN
  pruneJournalBestEffort(docId, upToSeq - config.REPLAY_MARGIN).catch((err) => {
    log.debug("collab.journal.prune_error", { docId, error: err });
  });

  return { snapshotId, versionId };
}

async function pruneJournalBestEffort(docId: string, upToSeq: number): Promise<void> {
  if (upToSeq <= 0) return;
  const docClient = getDocClient();
  const updatesTable = tableName("doc_updates");

  const res = await docClient.send(
    new QueryCommand({
      TableName: updatesTable,
      KeyConditionExpression: "docId = :docId AND seq <= :seq",
      ExpressionAttributeValues: {
        ":docId": docId,
        ":seq": upToSeq,
      },
      ProjectionExpression: "docId, seq",
      Limit: 25,
    }),
  );

  const items = res.Items;
  if (!items || items.length === 0) return;

  const deleteRequests = items.map((it) => ({
    DeleteRequest: {
      Key: { docId: it.docId, seq: it.seq },
    },
  }));

  await docClient.send(
    new BatchWriteCommand({
      RequestItems: {
        [updatesTable]: deleteRequests,
      },
    }),
  );
}

/**
 * Charge l'état complet d'un document depuis doc_snapshots / S3 et doc_updates (Section 7.2).
 */
export async function loadDocumentState(
  docId: string,
  ydoc: Y.Doc,
): Promise<{ baseSeq: number; maxSeq: number }> {
  const docClient = getDocClient();
  const config = getConfig();
  let baseSeq = 0;

  // 1. Dernier snapshot depuis doc_snapshots / S3
  const snapRes = await docClient.send(
    new QueryCommand({
      TableName: tableName("doc_snapshots"),
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

  // 2. Rejeu des updates depuis doc_updates avec seq > max(0, baseSeq - REPLAY_MARGIN)
  const replayStartSeq = Math.max(0, baseSeq - config.REPLAY_MARGIN);
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  let maxSeq = baseSeq;

  do {
    const updatesRes = await docClient.send(
      new QueryCommand({
        TableName: tableName("doc_updates"),
        KeyConditionExpression: "docId = :docId AND seq > :startSeq",
        ExpressionAttributeValues: {
          ":docId": docId,
          ":startSeq": replayStartSeq,
        },
        ScanIndexForward: true,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    if (updatesRes.Items) {
      for (const item of updatesRes.Items) {
        const updateBuf = item.update as Uint8Array | Buffer;
        if (updateBuf) {
          Y.applyUpdate(ydoc, new Uint8Array(updateBuf));
        }
        if (item.seq > maxSeq) {
          maxSeq = item.seq;
        }
      }
    }
    lastEvaluatedKey = updatesRes.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  // S'assurer que le type Y.Text "content" existe
  ydoc.getText("content");

  return { baseSeq, maxSeq };
}

export interface CollabServerOptions {
  snapshotOnUnload?: boolean;
}

export function createCollabServer(options?: CollabServerOptions): { server: Server; internalHttp: http.Server } {
  const config = getConfig();

  const server = new Server({
    port: config.COLLAB_PORT,
    quiet: true,
    debounce: 10000,
    maxDebounce: 60000,

    async onAuthenticate(data) {
      const token = data.token;
      if (!token) {
        throw new Error("Token d'authentification manquant");
      }

      const payload = await verifyCollabToken(token);
      if (!payload) {
        throw new Error("Token de collaboration invalide ou expiré");
      }

      if (payload.docId !== data.documentName) {
        throw new Error("Le token ne correspond pas au document demandé");
      }

      // Vérification en base de données (Section 7.1)
      const [writer, perm] = await Promise.all([
        getWriter(payload.writerId),
        getDocumentPermission(payload.docId, payload.writerId),
      ]);

      if (!writer) {
        throw new Error("Rédacteur introuvable");
      }
      if (!perm) {
        throw new Error("Accès refusé au document");
      }

      const now = Math.floor(Date.now() / 1000);
      const isBlocked = !!(writer.blockedUntil && writer.blockedUntil > now);
      const isViewer = perm.role === "viewer";
      const isReadOnly = isBlocked || isViewer;

      // Connexion en lecture seule si viewer ou rédacteur bloqué
      if (isReadOnly) {
        data.connectionConfig.readOnly = true;
      }

      const context: CollabContext = {
        writerId: writer.writerId,
        name: writer.name,
        role: perm.role,
        isReadOnly,
      };

      return context;
    },

    async onLoadDocument(data) {
      const docId = data.documentName;
      const state = getOrCreateDocState(docId);

      const { baseSeq, maxSeq } = await loadDocumentState(docId, data.document);

      // Initialisation de l'état en mémoire
      state.nextSeq = maxSeq + 1;
      state.latestSeq = maxSeq;
      state.intervalSet = IntervalSet.fromYDoc(data.document);
      state.updatesSinceSnapshot = 0;
      state.lastSnapshotAt = Date.now();

      log.info("collab.document.loaded", {
        docId,
        baseSeq,
        maxSeq,
        charCount: data.document.getText("content").length,
      });

      return data.document;
    },

    async beforeSync(data) {
      // data: { connection, document, documentName, type, payload }
      const syncType = data.type; // 0 = SyncStep1, 1 = SyncStep2, 2 = Update
      const rawUpdate = data.payload;

      // Seuls les messages d'écriture (SyncStep2 = 1 ou Update = 2) sont interceptés
      if (syncType !== 1 && syncType !== 2) {
        return;
      }

      const connection = data.connection as Connection<CollabContext> | undefined;
      const context = connection?.context;
      const docId = data.documentName;
      const state = getOrCreateDocState(docId);

      // 1. Taille maximale de l'update
      if (rawUpdate.byteLength > config.MAX_UPDATE_BYTES) {
        if (context) {
          await recordAbuseEvent(context.writerId, "too_large");
        }
        connection?.sendStateless(
          JSON.stringify({
            type: "write_refused",
            reason: "too_large",
          }),
        );
        throw new Error("too_large");
      }

      // 2. Décodage et validation stricte (message-parser.ts)
      const parseResult = parseAndValidateUpdate(rawUpdate, state.intervalSet, false);
      if (!parseResult.valid) {
        if (context) {
          await recordAbuseEvent(context.writerId, "invalid_update");
        }
        connection?.sendStateless(
          JSON.stringify({
            type: "write_refused",
            reason: "invalid_update",
          }),
        );
        throw new Error("invalid_update");
      }

      // Si le message ne contient aucune modification (ex: handshake initial SyncStep2 vide),
      // il ne s'agit pas d'une tentative d'écriture : on laisse la synchronisation s'achever.
      if (parseResult.isEmpty) {
        return;
      }

      // 3. Rôle lecture seule ou rédacteur bloqué => refus direct de toute écriture réelle (Section 7.3.1)
      if (context?.isReadOnly) {
        connection?.sendStateless(
          JSON.stringify({
            type: "write_refused",
            reason: "read_only",
          }),
        );
        throw new Error("read_only");
      }

      // 4. Facturation atomique du crédit si n > 0 nouvelles unités UTF-16
      if (parseResult.newChars > 0 && context) {
        const quotaRes = await consumeQuota(context.writerId, parseResult.newChars);
        if (!quotaRes.granted) {
          await recordAbuseEvent(context.writerId, "quota_refused");
          connection?.sendStateless(
            JSON.stringify({
              type: "write_refused",
              reason: "quota",
              remaining: quotaRes.remaining,
              resetAt: quotaRes.resetAt,
            }),
          );
          // Fermeture 4403 par Section 7.4
          const quotaErr = new Error("quota_refused");
          Object.assign(quotaErr, { code: 4403, reason: "Quota quotidien dépassé" });
          throw quotaErr;
        }
      }

      // 5. Journal Write-Ahead : PutItem doc_updates (seq = nextSeq++)
      const seq = state.nextSeq++;
      state.inFlight.add(seq);
      const docClient = getDocClient();
      const now = Math.floor(Date.now() / 1000);

      try {
        await docClient.send(
          new PutCommand({
            TableName: tableName("doc_updates"),
            Item: {
              docId,
              seq,
              update: Buffer.from(rawUpdate),
              writerId: context?.writerId || "anonymous",
              billedChars: parseResult.newChars,
              createdAt: now,
              ttl: now + config.JOURNAL_TTL_DAYS * 24 * 3600,
            },
            ConditionExpression: "attribute_not_exists(seq)",
          }),
        );

        // 6. Marquer les intervalles comme facturés
        parseAndValidateUpdate(rawUpdate, state.intervalSet, true);

        // 7. Compteur pour snapshot automatique
        state.updatesSinceSnapshot++;
        if (state.updatesSinceSnapshot >= config.SNAPSHOT_EVERY_UPDATES) {
          persistDocumentSnapshot(docId, data.document, "auto", context?.writerId).catch((err) => {
            log.warn("collab.auto_snapshot_failed", { docId, error: err });
          });
        }

        setImmediate(() => {
          state.inFlight.delete(seq);
          state.latestSeq = Math.max(state.latestSeq, seq);
        });
      } catch (err: unknown) {
        state.inFlight.delete(seq);
        log.error("collab.persist.failed", { docId, seq, error: err });
        connection?.sendStateless(
          JSON.stringify({
            type: "write_refused",
            reason: "persist_failed",
          }),
        );
        throw new Error("persist_failed");
      }
    },

    async onStoreDocument(data) {
      // Déclenché après debounce
      await persistDocumentSnapshot(data.documentName, data.document, "idle");
    },

    async beforeUnloadDocument(data) {
      if (options?.snapshotOnUnload !== false) {
        await persistDocumentSnapshot(data.documentName, data.document, "unload");
      }
    },
  });

  // Fonction de lecture de corps JSON pour les requêtes HTTP internes
  function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
        if (data.length > 5 * 1024 * 1024) reject(new Error("Corps trop volumineux"));
      });
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : ({} as T));
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  }

  // Serveur HTTP interne (Section 6.6, port 1235)
  const internalHttp = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/internal/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Vérification du token interne à temps constant (Section 6.6)
    const internalToken = req.headers["x-internal-token"];
    if (!timingSafeCompare(String(internalToken || ""), config.INTERNAL_TOKEN)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Token interne invalide ou non autorisé" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/internal/open-documents") {
      // Liste des documents avec au moins une connexion active (Section 6.5)
      const openDocs: Array<{ docId: string; connections: number; lastActivityAt: number }> = [];
      for (const [name, doc] of server.hocuspocus.documents.entries()) {
        const count = doc.getConnectionsCount();
        if (count > 0) {
          const state = docStates.get(name);
          openDocs.push({
            docId: name,
            connections: count,
            lastActivityAt: Math.floor((state?.lastSnapshotAt || Date.now()) / 1000),
          });
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ openDocuments: openDocs }));
      return;
    }

    // POST /internal/documents/:docId/snapshot (Section 6.6)
    if (req.method === "POST" && url.pathname.startsWith("/internal/documents/") && url.pathname.endsWith("/snapshot")) {
      const parts = url.pathname.split("/");
      const docId = parts[3];
      try {
        const body = await parseJsonBody<{ reason?: "manual" | "auto" | "idle" | "restore" | "unload"; byWriterId?: string }>(req);
        const liveDoc = server.hocuspocus.documents.get(docId);
        if (liveDoc) {
          const result = await persistDocumentSnapshot(docId, liveDoc, body.reason || "manual", body.byWriterId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } else {
          const tempDoc = new Y.Doc();
          await loadDocumentState(docId, tempDoc);
          const result = await persistDocumentSnapshot(docId, tempDoc, body.reason || "manual", body.byWriterId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        }
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Erreur snapshot" }));
      }
      return;
    }

    // POST /internal/documents/:docId/restore (Section 6.6 & 7.6)
    if (req.method === "POST" && url.pathname.startsWith("/internal/documents/") && url.pathname.endsWith("/restore")) {
      const parts = url.pathname.split("/");
      const docId = parts[3];
      try {
        const body = await parseJsonBody<{ targetText: string; snapshotId?: string; byWriterId?: string }>(req);
        if (typeof body.targetText !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "targetText requis" }));
          return;
        }

        const state = getOrCreateDocState(docId);
        const liveDoc = server.hocuspocus.documents.get(docId);
        const targetDoc = liveDoc || new Y.Doc();

        if (!liveDoc) {
          await loadDocumentState(docId, targetDoc);
        }

        const currentContent = targetDoc.getText("content");
        let deltaUpdate: Uint8Array | null = null;
        const onUpdate = (u: Uint8Array) => {
          deltaUpdate = u;
        };
        targetDoc.on("update", onUpdate);
        targetDoc.transact(() => {
          currentContent.delete(0, currentContent.length);
          currentContent.insert(0, body.targetText);
        });
        targetDoc.off("update", onUpdate);

        // Journalisation de la mise à jour sans facturation de crédit (billedChars = 0, I08)
        if (deltaUpdate) {
          const seq = state.nextSeq++;
          state.inFlight.add(seq);
          const now = Math.floor(Date.now() / 1000);
          const docClient = getDocClient();
          try {
            await docClient.send(
              new PutCommand({
                TableName: tableName("doc_updates"),
                Item: {
                  docId,
                  seq,
                  update: Buffer.from(deltaUpdate),
                  writerId: body.byWriterId || "system",
                  billedChars: 0,
                  createdAt: now,
                  ttl: now + config.JOURNAL_TTL_DAYS * 24 * 3600,
                },
                ConditionExpression: "attribute_not_exists(seq)",
              }),
            );
            state.latestSeq = Math.max(state.latestSeq, seq);
          } finally {
            state.inFlight.delete(seq);
          }
        }

        const result = await persistDocumentSnapshot(docId, targetDoc, "restore", body.byWriterId);
        log.info("collab.document.restored", {
          docId,
          snapshotId: result.snapshotId,
          byWriterId: body.byWriterId,
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: unknown) {
        log.error("collab.restore.failed", { docId, error: err });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Erreur restauration" }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  return { server, internalHttp };
}

// Démarrage autonome si exécuté directement
if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const { server, internalHttp } = createCollabServer();
  const config = getConfig();

  server.listen().then(() => {
    log.info("collab.hocuspocus.listening", { port: config.COLLAB_PORT });
  });

  internalHttp.listen(config.COLLAB_INTERNAL_PORT, config.COLLAB_INTERNAL_HOST, () => {
    log.info("collab.internal_http.listening", {
      host: config.COLLAB_INTERNAL_HOST,
      port: config.COLLAB_INTERNAL_PORT,
    });
  });

  const shutdown = async () => {
    log.info("collab.shutdown.started");
    for (const [name, doc] of server.hocuspocus.documents.entries()) {
      try {
        await persistDocumentSnapshot(name, doc, "unload");
      } catch (e) {
        log.warn("collab.shutdown.snapshot_failed", { docId: name, error: e });
      }
    }
    await server.destroy();
    internalHttp.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
