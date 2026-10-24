import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";
import http from "http";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Server } from "@hocuspocus/server";
import { DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { initDynamoDBTables, initS3Bucket, initSQSQueues } from "../../scripts/local-init";
import { resetConfig, ALL_TABLES } from "@shared/config";
import { getDynamoDBClient, resetDynamoClients } from "@shared/aws/dynamodb";
import { resetS3Clients } from "@shared/aws/s3";
import { upsertWriter } from "@shared/auth/session";
import { createDocument } from "@shared/docs/documents";
import { createCollabToken } from "@shared/auth/jwt";
import { consumeQuota, recordAbuseEvent, getWriterQuota, formatQuotaKey } from "@shared/quota/quota";
import { createCollabServer } from "../../collab/server";

describe("SC04 — Crédit d'écriture, abus et protocole de refus (C4, I02, I06, I07)", () => {
  const testPrefix = `test-sc04-${randomBytes(4).toString("hex")}-`;
  const collabPort = 12392;
  const internalPort = 12393;

  let collabServer: Server;
  let internalHttp: http.Server;

  let writerAlice: { writerId: string; name: string; email: string };
  let docId: string;

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
    process.env.STREAM_MODE = "inline";
    process.env.SESSION_SECRET = "local-secret-for-jwt-signing-1234567890123456";
    process.env.INTERNAL_TOKEN = "local-internal-token-123456";
    process.env.ADMIN_TOKEN = "local-admin-token-123456";
    process.env.COLLAB_PORT = String(collabPort);
    process.env.COLLAB_INTERNAL_PORT = String(internalPort);
    process.env.NEXT_PUBLIC_COLLAB_URL = `ws://127.0.0.1:${collabPort}`;
    process.env.DAILY_CREDIT = "500"; // Crédit configuré à 500 pour ce scénario
    process.env.ABUSE_THRESHOLD = "5"; // 5 événements pour déclencher le blocage
    process.env.ABUSE_WINDOW_SEC = "60";
    process.env.BLOCK_DURATION_SEC = "900";

    resetConfig();
    resetDynamoClients();
    resetS3Clients();

    await initDynamoDBTables(testPrefix);
    await initS3Bucket();
    await initSQSQueues();

    const w = await upsertWriter("Alice Sc04", "alice-sc04@asso.fr");
    writerAlice = { writerId: w.writerId, name: w.name, email: w.email };

    const created = await createDocument("Document SC04", writerAlice);
    docId = created.docId;

    const servers = createCollabServer();
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

  it("1. Deux sessions simultanées : insertions de 300 et 400 pour crédit 500 => une seule acceptée (I02, I07)", async () => {
    // Les deux requêtes de consommation partent simultanément
    const [res1, res2] = await Promise.all([
      consumeQuota(writerAlice.writerId, 300),
      consumeQuota(writerAlice.writerId, 400),
    ]);

    // L'une doit être acceptée, l'autre refusée
    const grantedCount = (res1.granted ? 1 : 0) + (res2.granted ? 1 : 0);
    const refusedCount = (!res1.granted ? 1 : 0) + (!res2.granted ? 1 : 0);

    expect(grantedCount).toBe(1);
    expect(refusedCount).toBe(1);

    // Le quota total consommé ne doit jamais dépasser 500
    const quota = await getWriterQuota(writerAlice.writerId);
    expect(quota.used).toBeLessThanOrEqual(500);
    expect(quota.remaining).toBe(500 - quota.used);
  });

  it("2. Protocole write_refused et fermeture de connexion (Section 7.4) quand le serveur collab rejette le quota", async () => {
    const token = await createCollabToken({ writerId: writerAlice.writerId, docId });
    const ydoc = new Y.Doc();

    let refusedPayload: { type: string; reason: string; remaining: number } | null = null;
    let connectionClosed = false;
    let closeReason = "";

    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docId,
      document: ydoc,
      token,
      onStateless(payload) {
        try {
          const parsed = JSON.parse(payload.payload);
          if (parsed.type === "write_refused") {
            refusedPayload = parsed;
          }
        } catch {
          // Ignorer
        }
      },
    });

    provider.on("close", (e: unknown) => {
      connectionClosed = true;
      const evt = (e as { event?: { code?: number; reason?: string } })?.event;
      if (evt?.reason) closeReason = evt.reason;
    });

    await new Promise<void>((resolve) => provider.on("synced", () => resolve()));

    // Alice a déjà consommé 300 ou 400 car. Il reste <= 200.
    // Elle tente d'insérer 350 caractères -> DÉPASSEMENT !
    const largeString = "A".repeat(350);
    ydoc.getText("content").insert(0, largeString);

    // Attente de traitement et notification
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(refusedPayload).not.toBeNull();
    expect((refusedPayload as { reason?: string } | null)?.reason).toBe("quota");
    expect(connectionClosed).toBe(true);
    expect(closeReason).toBe("Quota quotidien dépassé");

    provider.destroy();
  });

  it("3. L'update refusé n'est ni appliqué ni persisté dans le document serveur (C2, D-12)", async () => {
    // Vérification que les 350 caractères "A" ne sont pas dans le document
    const token = await createCollabToken({ writerId: writerAlice.writerId, docId });
    const ydocFresh = new Y.Doc();

    const providerFresh = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docId,
      document: ydocFresh,
      token,
    });

    await new Promise<void>((resolve) => providerFresh.on("synced", () => resolve()));

    const text = ydocFresh.getText("content").toString();
    expect(text).not.toContain("A".repeat(350));
    expect(text.length).toBeLessThan(350);

    providerFresh.destroy();
  });

  it("4. Détection d'abus et blocage temporaire (Section 8.2)", async () => {
    const eve = await upsertWriter("Eve Abuse", "eve-abuse@asso.fr");

    // 5 événements d'abus successifs pour dépasser ABUSE_THRESHOLD = 5
    for (let i = 0; i < 4; i++) {
      const res = await recordAbuseEvent(eve.writerId, "quota_refused");
      expect(res.blocked).toBe(false);
    }

    // Le 5e événement déclenche le blocage
    const finalRes = await recordAbuseEvent(eve.writerId, "quota_refused");
    expect(finalRes.blocked).toBe(true);
    expect(finalRes.blockedUntil).toBeDefined();
    expect(finalRes.blockedUntil!).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("5. Changement de jour UTC : partitionnement strict et remise à zéro à minuit (D-08)", async () => {
    const today = new Date("2026-10-24T23:59:00Z");
    const tomorrow = new Date("2026-10-25T00:01:00Z");

    const keyToday = formatQuotaKey("writer-utc-test", today);
    const keyTomorrow = formatQuotaKey("writer-utc-test", tomorrow);

    expect(keyToday).toBe("writer-utc-test#2026-10-24");
    expect(keyTomorrow).toBe("writer-utc-test#2026-10-25");
    expect(keyToday).not.toBe(keyTomorrow);
  });
});
