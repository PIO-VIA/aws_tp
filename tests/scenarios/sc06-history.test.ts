import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import http from "http";
import * as Y from "yjs";
import { Server as HocuspocusServer } from "@hocuspocus/server";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { getDynamoDBClient, resetDynamoClients } from "../../src/shared/aws/dynamodb";
import { resetConfig, ALL_TABLES } from "../../src/shared/config";
import { createCollabToken } from "../../src/shared/auth/jwt";
import { upsertWriter } from "../../src/shared/auth/session";
import { createDocument } from "../../src/shared/docs/documents";
import { getWriterQuota } from "../../src/shared/quota/quota";
import {
  listDocumentSnapshots,
  getSnapshotContent,
  requestSnapshot,
  requestRestore,
} from "../../src/shared/docs/history";
import { createCollabServer } from "../../collab/server";
import { initDynamoDBTables, initS3Bucket, initSQSQueues } from "../../scripts/local-init";

describe("SC06 — Historique des versions, restauration et limite de fréquence (F05, I08, Section 7.5 & 7.6)", () => {
  const testId = randomUUID().slice(0, 8);
  const testTablePrefix = `test-sc06-${testId}-`;

  const collabPort = 1238;
  const internalPort = 1239;

  let collabServer: HocuspocusServer;
  let internalHttp: http.Server;

  const writerAlice = {
    writerId: `alice-sc06-${testId}`,
    email: `alice-sc06-${testId}@asso.fr`,
    name: "Alice Rédactrice",
  };

  let docId = "";
  let snapV1Id = "";
  let snapV2Id = "";
  let snapV3Id = "";

  beforeAll(async () => {
    process.env.TABLE_PREFIX = testTablePrefix;
    process.env.APP_ENV = "local";
    process.env.DDB_ENDPOINT = "http://localhost:8000";
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.S3_FORCE_PATH_STYLE = "true";
    process.env.S3_BUCKET = "editeur-local-data";
    process.env.SQS_ENDPOINT = "http://localhost:9324";
    process.env.PDF_QUEUE_URL = "http://localhost:9324/000000000000/pdf-jobs";
    process.env.SESSION_SECRET = "dev-session-secret-change-in-prod-at-least-32-chars";
    process.env.INTERNAL_TOKEN = "dev-internal-token-change-in-prod";
    process.env.ADMIN_TOKEN = "dev-admin-token-change-in-prod";
    process.env.COLLAB_PORT = String(collabPort);
    process.env.COLLAB_INTERNAL_PORT = String(internalPort);
    process.env.COLLAB_INTERNAL_HOST = "127.0.0.1";
    resetConfig();
    resetDynamoClients();

    // Création des tables DynamoDB
    await initDynamoDBTables(testTablePrefix);
    await initS3Bucket();
    await initSQSQueues();

    // Démarrage du serveur collab et serveur HTTP interne sur ports dédiés
    const servers = createCollabServer();
    collabServer = servers.server;
    internalHttp = servers.internalHttp;

    await collabServer.listen();
    await new Promise<void>((resolve) => internalHttp.listen(internalPort, "127.0.0.1", () => resolve()));

    // Enregistrement du rédacteur Alice dans la table writers
    const record = await upsertWriter(writerAlice.name, writerAlice.email);
    writerAlice.writerId = record.writerId;

    // Création du document d'Alice
    const doc = await createDocument("Charte associative", writerAlice);
    docId = doc.docId;
  });

  afterAll(async () => {
    if (collabServer) await collabServer.destroy();
    if (internalHttp) internalHttp.close();

    const ddb = getDynamoDBClient();
    for (const key of ALL_TABLES) {
      try {
        await ddb.send(new DeleteTableCommand({ TableName: `${testTablePrefix}${key}` }));
      } catch {
        // Ignorer
      }
    }
    delete process.env.TABLE_PREFIX;
    resetConfig();
  });

  it("1. Création de versions successives (V1, V2, V3) et persistance des snapshots immuables (F05)", async () => {
    const token = await createCollabToken({ writerId: writerAlice.writerId, docId });
    const ydoc = new Y.Doc();

    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docId,
      document: ydoc,
      token,
    });

    await new Promise<void>((resolve) => provider.on("synced", () => resolve()));

    // Version 1
    const textV1 = "Version 1 : Le texte initial.";
    ydoc.getText("content").insert(0, textV1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const snap1 = await requestSnapshot(docId, "manual", writerAlice.writerId);
    snapV1Id = snap1.snapshotId;

    // Version 2
    const textV2 = "Version 2 : Ajout d'articles importants.";
    ydoc.getText("content").delete(0, ydoc.getText("content").length);
    ydoc.getText("content").insert(0, textV2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const snap2 = await requestSnapshot(docId, "manual", writerAlice.writerId);
    snapV2Id = snap2.snapshotId;

    // Version 3
    const textV3 = "Version 3 : Version finale en discussion.";
    ydoc.getText("content").delete(0, ydoc.getText("content").length);
    ydoc.getText("content").insert(0, textV3);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const snap3 = await requestSnapshot(docId, "manual", writerAlice.writerId);
    snapV3Id = snap3.snapshotId;

    provider.destroy();

    // Vérification de la liste ordonnée des snapshots
    const snapshots = await listDocumentSnapshots(docId);
    expect(snapshots.length).toBeGreaterThanOrEqual(3);

    const snapshotIds = snapshots.map((s) => s.snapshotId);
    expect(snapshotIds).toContain(snapV1Id);
    expect(snapshotIds).toContain(snapV2Id);
    expect(snapshotIds).toContain(snapV3Id);

    // Vérification du contenu textuel de l'aperçu V1
    const previewV1 = await getSnapshotContent(docId, snapV1Id);
    expect(previewV1?.text).toBe(textV1);
  });

  it("2. Restauration de V1 : crée une NOUVELLE évolution, les versions postérieures restent listées (I08)", async () => {
    // Mesure du crédit avant restauration
    const quotaBefore = await getWriterQuota(writerAlice.writerId);

    // Restauration de la version 1
    const restoreRes = await requestRestore(docId, snapV1Id, writerAlice.writerId);
    expect(restoreRes.success).toBe(true);

    // Vérification que les versions postérieures (V2 et V3) restent bien listées (I08)
    const snapshotsAfter = await listDocumentSnapshots(docId);
    const snapIdsAfter = snapshotsAfter.map((s) => s.snapshotId);

    expect(snapIdsAfter).toContain(snapV1Id);
    expect(snapIdsAfter).toContain(snapV2Id);
    expect(snapIdsAfter).toContain(snapV3Id);
    expect(snapIdsAfter).toContain(restoreRes.snapshotId);

    const restoreSnap = snapshotsAfter.find((s) => s.snapshotId === restoreRes.snapshotId);
    expect(restoreSnap?.reason).toBe("restore");

    // Connexion d'un client pour vérifier le texte actif du document
    const token = await createCollabToken({ writerId: writerAlice.writerId, docId });
    const ydocRestored = new Y.Doc();
    const providerRestored = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docId,
      document: ydocRestored,
      token,
    });

    await new Promise<void>((resolve) => providerRestored.on("synced", () => resolve()));
    const activeText = ydocRestored.getText("content").toString();
    expect(activeText).toBe("Version 1 : Le texte initial.");

    providerRestored.destroy();

    // 3. Vérification : la restauration ne consomme PAS de crédit quotidien (billedChars = 0)
    const quotaAfter = await getWriterQuota(writerAlice.writerId);
    expect(quotaAfter.used).toBe(quotaBefore.used);
  });

  it("3. Limite de fréquence des restaurations : maximum 10 par heure par rédacteur (Section 7.6)", async () => {
    // 1 restauration a déjà été effectuée dans le test 2.
    // On effectue 9 restaurations supplémentaires (total = 10) -> doivent réussir
    for (let i = 0; i < 9; i++) {
      const res = await requestRestore(docId, snapV1Id, writerAlice.writerId);
      expect(res.success).toBe(true);
    }

    // La 11e restauration doit être strictement refusée par la limite de fréquence
    await expect(requestRestore(docId, snapV1Id, writerAlice.writerId)).rejects.toThrow(
      /Limite de fréquence atteinte/,
    );
  });
});
