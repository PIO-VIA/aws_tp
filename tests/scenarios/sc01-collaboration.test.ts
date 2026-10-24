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
import { createDocument, shareDocument } from "@shared/docs/documents";
import { createCollabToken } from "@shared/auth/jwt";
import { createCollabServer } from "../../collab/server";

describe("SC01 — Collaboration, convergence CRDT et persistance (C2, I03, I04, I06)", () => {
  const testPrefix = `test-sc01-${randomBytes(4).toString("hex")}-`;
  const collabPort = 12390;
  const internalPort = 12391;

  let collabServer: Server;
  let internalHttp: http.Server;

  let alice: { writerId: string; name: string; email: string };
  let bob: { writerId: string; name: string; email: string };
  let charlie: { writerId: string; name: string; email: string };
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

    resetConfig();
    resetDynamoClients();
    resetS3Clients();

    await initDynamoDBTables(testPrefix);
    await initS3Bucket();
    await initSQSQueues();

    // Création des rédacteurs
    const a = await upsertWriter("Alice", "alice-sc01@asso.fr");
    alice = { writerId: a.writerId, name: a.name, email: a.email };

    const b = await upsertWriter("Bob", "bob-sc01@asso.fr");
    bob = { writerId: b.writerId, name: b.name, email: b.email };

    const c = await upsertWriter("Charlie", "charlie-sc01@asso.fr");
    charlie = { writerId: c.writerId, name: c.name, email: c.email };

    // Alice crée le document
    const created = await createDocument("Document SC01", alice);
    docId = created.docId;

    // Alice partage avec Bob (editor) et Charlie (viewer)
    await shareDocument({
      docId,
      ownerId: alice.writerId,
      targetEmail: bob.email,
      targetName: bob.name,
      role: "editor",
    });

    await shareDocument({
      docId,
      ownerId: alice.writerId,
      targetEmail: charlie.email,
      targetName: charlie.name,
      role: "viewer",
    });

    // Démarrage du serveur collab
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

  it("1. Deux clients insèrent simultanément au même endroit et convergent vers le même texte sans perte (I03, I04)", async () => {
    const tokenAlice = await createCollabToken({ writerId: alice.writerId, docId });
    const tokenBob = await createCollabToken({ writerId: bob.writerId, docId });

    const ydocAlice = new Y.Doc();
    const ydocBob = new Y.Doc();

    const providerAlice = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docId,
      document: ydocAlice,
      token: tokenAlice,
    });

    const providerBob = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docId,
      document: ydocBob,
      token: tokenBob,
    });

    // Attente de la connexion et synchronisation initiale
    await Promise.all([
      new Promise<void>((resolve) => providerAlice.on("synced", () => resolve())),
      new Promise<void>((resolve) => providerBob.on("synced", () => resolve())),
    ]);

    // Insertions simultanées à la position 0
    ydocAlice.getText("content").insert(0, "ABC");
    ydocBob.getText("content").insert(0, "XYZ");

    // Attente de convergence (propagation WebSocket via serveur)
    await new Promise((resolve) => setTimeout(resolve, 800));

    const textAlice = ydocAlice.getText("content").toString();
    const textBob = ydocBob.getText("content").toString();

    // 1. Textes rigoureusement identiques (convergence C2)
    expect(textAlice).toBe(textBob);
    // 2. Longueur exacte : 6 caractères (aucune perte d'édition I03, I04)
    expect(textAlice.length).toBe(6);
    expect(textAlice).toMatch(/ABC/);
    expect(textAlice).toMatch(/XYZ/);

    providerAlice.destroy();
    providerBob.destroy();
  });

  it("2. La présence et l'awareness sont correctement diffusées entre rédacteurs", async () => {
    const tokenAlice = await createCollabToken({ writerId: alice.writerId, docId });
    const tokenBob = await createCollabToken({ writerId: bob.writerId, docId });

    const ydocAlice = new Y.Doc();
    const ydocBob = new Y.Doc();

    const providerAlice = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docId,
      document: ydocAlice,
      token: tokenAlice,
    });

    const providerBob = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docId,
      document: ydocBob,
      token: tokenBob,
    });

    await Promise.all([
      new Promise<void>((resolve) => providerAlice.on("synced", () => resolve())),
      new Promise<void>((resolve) => providerBob.on("synced", () => resolve())),
    ]);

    // Alice définit son statut de présence
    providerAlice.awareness?.setLocalStateField("user", {
      name: "Alice Dupont",
      color: "#6366f1",
    });

    // Attente de propagation de l'awareness
    await new Promise((resolve) => setTimeout(resolve, 500));

    const bobAwarenessStates = providerBob.awareness?.getStates();
    expect(bobAwarenessStates).toBeDefined();

    let foundAlice = false;
    bobAwarenessStates?.forEach((val) => {
      const u = val.user as { name?: string; color?: string } | undefined;
      if (u?.name === "Alice Dupont") {
        foundAlice = true;
      }
    });

    expect(foundAlice).toBe(true);

    providerAlice.destroy();
    providerBob.destroy();
  });

  it("3. Un lecteur (viewer) est placé en lecture seule et ses écritures sont refusées (Section 7.3.1)", async () => {
    const tokenCharlie = await createCollabToken({ writerId: charlie.writerId, docId });
    const ydocCharlie = new Y.Doc();

    let writeRefusedReceived = false;

    const providerCharlie = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docId,
      document: ydocCharlie,
      token: tokenCharlie,
      onStateless(payload) {
        try {
          const data = JSON.parse(payload.payload);
          if (data.type === "write_refused" && data.reason === "read_only") {
            writeRefusedReceived = true;
          }
        } catch {
          // Ignorer
        }
      },
    });

    await new Promise<void>((resolve) => providerCharlie.on("synced", () => resolve()));

    // Charlie tente d'insérer du texte
    ydocCharlie.getText("content").insert(0, "HACK");

    // Attente du traitement du message
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Le message write_refused a été reçu
    expect(writeRefusedReceived).toBe(true);

    providerCharlie.destroy();
  });

  it("4. Redémarrage du serveur collab : le contenu est intégralement restauré depuis le journal et les snapshots (C2, D-12)", async () => {
    // 1. Déconnexion et destruction propre du serveur actuel
    await collabServer.destroy();
    internalHttp.close();

    // 2. Démarrage d'une NOUVELLE instance de serveur de collaboration
    const newServers = createCollabServer();
    collabServer = newServers.server;
    internalHttp = newServers.internalHttp;

    await collabServer.listen();
    await new Promise<void>((resolve) => internalHttp.listen(internalPort, "127.0.0.1", () => resolve()));

    // 3. Connexion d'un nouveau client sur le document
    const tokenAlice = await createCollabToken({ writerId: alice.writerId, docId });
    const ydocNew = new Y.Doc();

    const providerNew = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docId,
      document: ydocNew,
      token: tokenAlice,
    });

    await new Promise<void>((resolve) => providerNew.on("synced", () => resolve()));

    const recoveredText = ydocNew.getText("content").toString();

    // Le texte avant redémarrage ("ABC" + "XYZ") doit être entièrement présent sans aucune perte
    expect(recoveredText.length).toBe(6);
    expect(recoveredText).toMatch(/ABC/);
    expect(recoveredText).toMatch(/XYZ/);

    providerNew.destroy();
  });
});
