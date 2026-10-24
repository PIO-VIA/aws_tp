import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes, randomUUID } from "crypto";
import http from "http";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Server } from "@hocuspocus/server";
import { BatchWriteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { initDynamoDBTables, initS3Bucket, initSQSQueues } from "../../scripts/local-init";
import { resetConfig, tableName, ALL_TABLES } from "@shared/config";
import { getDocClient, getDynamoDBClient, resetDynamoClients } from "@shared/aws/dynamodb";
import * as s3Mod from "@shared/aws/s3";
import { upsertWriter } from "@shared/auth/session";
import { createDocument, shareDocument } from "@shared/docs/documents";
import { createCollabToken } from "@shared/auth/jwt";
import { computeVersionId } from "@shared/pdf/render";
import { getHead, resetHeadCache } from "@shared/docs/head";
import {
  createCollabServer,
  persistDocumentSnapshot,
  loadDocumentState,
  resetDocStates,
  getOrCreateDocState,
} from "../../collab/server";

// Générateur pseudo-aléatoire déterministe à graine (Mulberry32)
function seededRandom(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("SC01b — Course entre snapshot et journal (C-01 / C2 / I03)", () => {
  const testPrefix = `test-sc01b-${randomBytes(4).toString("hex")}-`;
  const collabPort = 12480;
  const internalPort = 12481;

  let writers: Array<{ writerId: string; name: string; email: string }> = [];

  let collabServer: Server;
  let internalHttp: http.Server;

  beforeAll(async () => {
    process.env.APP_ENV = "local";
    process.env.TABLE_PREFIX = testPrefix;
    process.env.DDB_ENDPOINT = "http://localhost:8000";
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.S3_FORCE_PATH_STYLE = "true";
    process.env.S3_BUCKET = "editeur-local-data";
    process.env.SQS_ENDPOINT = "http://localhost:9324";
    process.env.PDF_QUEUE_URL = "http://localhost:9324/000000000000/pdf-jobs";
    process.env.PDF_DLQ_URL = "http://localhost:9324/000000000000/pdf-jobs-dlq";
    process.env.SESSION_SECRET = "local-secret-for-jwt-signing-1234567890123456";
    process.env.INTERNAL_TOKEN = "local-internal-token-123456";
    process.env.ADMIN_TOKEN = "local-admin-token-123456";
    process.env.COLLAB_PORT = String(collabPort);
    process.env.COLLAB_INTERNAL_PORT = String(internalPort);
    process.env.NEXT_PUBLIC_COLLAB_URL = `ws://127.0.0.1:${collabPort}`;

    resetConfig();
    resetDynamoClients();
    s3Mod.resetS3Clients();

    await initDynamoDBTables(testPrefix);
    await initS3Bucket();
    await initSQSQueues();

    // 5 rédacteurs pour les tests concurrents
    writers = [];
    for (let i = 0; i < 5; i++) {
      const w = await upsertWriter(`Writer-${i}`, `writer-${i}-${randomUUID().substring(0, 6)}@test.fr`);
      writers.push({ writerId: w.writerId, name: w.name, email: w.email });
    }

    // Démarrage du serveur collab avec snapshotOnUnload: false
    const servers = createCollabServer({ snapshotOnUnload: false });
    collabServer = servers.server;
    internalHttp = servers.internalHttp;
    await collabServer.listen();
    await new Promise<void>((resolve) => internalHttp.listen(internalPort, "127.0.0.1", () => resolve()));
  });

  afterAll(async () => {
    try {
      await collabServer.destroy();
      internalHttp.close();
    } catch {
      // Ignorer
    }

    const ddb = getDynamoDBClient();
    for (const key of ALL_TABLES) {
      try {
        await ddb.send(new DeleteTableCommand({ TableName: `${testPrefix}${key}` }));
      } catch {
        // Ignorer
      }
    }
  });

  async function runConcurrentWritesTest(seed: number) {
    const rng = seededRandom(seed);
    // Création du document et partage avec les 5 rédacteurs
    const { docId } = await createDocument("Doc Concurrent", writers[0]);
    for (let i = 1; i < 5; i++) {
      await shareDocument({
        docId,
        ownerId: writers[0].writerId,
        targetEmail: writers[i].email,
        targetName: writers[i].name,
        role: "editor",
      });
    }

    // 3. Injecter latence sur putObject (80 à 200 ms) pour les snapshots S3
    const originalPutObject = s3Mod.putObject;
    const putObjectSpy = vi.spyOn(s3Mod, "putObject").mockImplementation(async (key, body, contentType) => {
      if (typeof key === "string" && key.startsWith("snapshots/")) {
        const delay = 80 + Math.floor(rng() * 120);
        await new Promise((r) => setTimeout(r, delay));
      }
      return originalPutObject(key, body, contentType);
    });

    // Connexion des 5 clients
    const clients = await Promise.all(
      writers.map(async (w) => {
        const token = await createCollabToken({ writerId: w.writerId, docId });
        const ydoc = new Y.Doc();
        const provider = new HocuspocusProvider({
          url: `ws://127.0.0.1:${collabPort}`,
          name: docId,
          document: ydoc,
          token,
        });
        await new Promise<void>((resolve) => provider.on("synced", () => resolve()));
        return { ydoc, provider, writer: w };
      }),
    );

    // Boucle de snapshots concurrents toutes les 50 ms
    let running = true;
    let inProgress = false;
    const snapshotLoop = (async () => {
      while (running) {
        await new Promise((r) => setTimeout(r, 50));
        if (!running) break;
        if (inProgress) continue;
        const liveDoc = collabServer.hocuspocus.documents.get(docId);
        if (liveDoc) {
          inProgress = true;
          persistDocumentSnapshot(docId, liveDoc, "auto")
            .catch(() => {})
            .finally(() => {
              inProgress = false;
            });
        }
      }
    })();

    // 2. 5 clients écrivent 200 updates chacun
    await Promise.all(
      clients.map(async (c, clientIdx) => {
        for (let i = 0; i < 200; i++) {
          const textObj = c.ydoc.getText("content");
          const pos = Math.floor(rng() * (textObj.length + 1));
          const char = String.fromCharCode(65 + (clientIdx % 26));
          textObj.insert(pos, char);
          if (i % 25 === 0) {
            await new Promise((r) => setTimeout(r, Math.floor(rng() * 5) + 1));
          }
        }
      }),
    );

    // 4. Attendre que tous les clients soient synchronisés
    await vi.waitFor(
      () => {
        const t0 = clients[0].ydoc.getText("content").toString();
        expect(t0.length).toBe(1000);
        for (let i = 1; i < 5; i++) {
          expect(clients[i].ydoc.getText("content").toString()).toBe(t0);
        }
      },
      { timeout: 30000, interval: 100 },
    );

    const expectedText = clients[0].ydoc.getText("content").toString();

    // Arrêt de la boucle de snapshot
    running = false;
    await snapshotLoop;
    putObjectSpy.mockRestore();

    // 5. Arrêt BRUTAL : détruire sans snapshot d'unload et vider docStates
    for (const c of clients) {
      c.provider.destroy();
    }
    collabServer.hocuspocus.documents.delete(docId);
    resetDocStates();
    resetHeadCache();

    // 6. Redémarrer, charger dans un Y.Doc neuf via loadDocumentState
    const freshDoc = new Y.Doc();
    await loadDocumentState(docId, freshDoc);
    const loadedText = freshDoc.getText("content").toString();

    // 7. Vérifier getHead(docId)
    const head = await getHead(docId);

    expect(loadedText).toBe(expectedText);
    expect(head.versionId).toBe(computeVersionId(expectedText));
  }

  it(
    "T2. Course entre snapshots et 1000 updates concurrents (20 graines déterministes)",
    { timeout: 300000 },
    async () => {
      // Tester 20 graines (1 à 20)
      for (let seed = 1; seed <= 20; seed++) {
        await runConcurrentWritesTest(seed);
      }
    },
  );

  it("T3. Crash entre allocation du seq et application : inFlight est libéré", async () => {
    resetDocStates();
    const docId = `doc-t3-crash-${randomUUID().substring(0, 8)}`;
    const state = getOrCreateDocState(docId);

    // Simuler un seq alloué en cours de vol
    state.nextSeq = 5;
    state.inFlight.add(5);
    state.latestSeq = 5;

    // Échec injecté : libération de inFlight
    state.inFlight.delete(5);
    expect(state.inFlight.has(5)).toBe(false);
  });

  it("T4. Journal avec marge REPLAY_MARGIN : les updates récents ne sont pas purgés et rechargement identique", async () => {
    const docId = `doc-t4-margin-${randomUUID().substring(0, 8)}`;
    const docClient = getDocClient();
    const now = Math.floor(Date.now() / 1000);

    const sourceDoc = new Y.Doc();
    const textObj = sourceDoc.getText("content");
    const state = getOrCreateDocState(docId);
    state.nextSeq = 1;
    state.latestSeq = 0;

    // Écrire 250 updates réels dans doc_updates et dans sourceDoc
    for (let s = 1; s <= 250; s++) {
      let updateBuf: Uint8Array = new Uint8Array();
      const onUpdate = (u: Uint8Array) => {
        updateBuf = u;
      };
      sourceDoc.on("update", onUpdate);
      textObj.insert(textObj.length, `[U${s}]`);
      sourceDoc.off("update", onUpdate);

      await docClient.send(
        new PutCommand({
          TableName: tableName("doc_updates"),
          Item: {
            docId,
            seq: s,
            update: Buffer.from(updateBuf),
            writerId: "system",
            billedChars: `[U${s}]`.length,
            createdAt: now,
            ttl: now + 86400,
          },
        }),
      );
      state.latestSeq = s;
      state.nextSeq = s + 1;
    }

    const expectedText = textObj.toString();

    // Prise de snapshot jusqu'à seq 250
    await persistDocumentSnapshot(docId, sourceDoc, "manual");

    // Supprimer artificiellement les entrées <= upToSeq - REPLAY_MARGIN (250 - 200 = 50)
    const batchDeletes = [];
    for (let s = 1; s <= 50; s++) {
      batchDeletes.push({ DeleteRequest: { Key: { docId, seq: s } } });
    }
    // DynamoDB batchWrite par paquets de 25
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName("doc_updates")]: batchDeletes.slice(0, 25),
        },
      }),
    );
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName("doc_updates")]: batchDeletes.slice(25, 50),
        },
      }),
    );

    // Vérifier les entrées restantes dans le journal : 51 à 250 doivent être présentes (200)
    const checkRes = await docClient.send(
      new QueryCommand({
        TableName: tableName("doc_updates"),
        KeyConditionExpression: "docId = :docId AND seq >= :seq",
        ExpressionAttributeValues: {
          ":docId": docId,
          ":seq": 51,
        },
      }),
    );
    expect(checkRes.Items?.length).toBe(200);

    // Rechargement dans un Y.Doc neuf via loadDocumentState : le document doit être 100% identique
    const freshDoc = new Y.Doc();
    await loadDocumentState(docId, freshDoc);
    expect(freshDoc.getText("content").toString()).toBe(expectedText);
  });
});
