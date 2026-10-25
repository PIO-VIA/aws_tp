import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";
import http from "http";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Server } from "@hocuspocus/server";
import { DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { NextRequest } from "next/server";
import { initDynamoDBTables, initS3Bucket, initSQSQueues } from "../../scripts/local-init";
import { resetConfig, ALL_TABLES } from "@shared/config";
import { getDynamoDBClient, resetDynamoClients } from "@shared/aws/dynamodb";
import { resetS3Clients } from "@shared/aws/s3";
import { upsertWriter, getWriter } from "@shared/auth/session";
import { createDocument } from "@shared/docs/documents";
import { getHead } from "@shared/docs/head";
import { createCollabToken } from "@shared/auth/jwt";
import { recordAbuseEvent } from "@shared/quota/quota";
import { createCollabServer } from "../../collab/server";
import { POST as unblockPost } from "../../app/api/admin/unblock/route";

describe("SC04b — Détection de rafale et blocage en cours de session (C-03 / F09)", () => {
  const testPrefix = `test-sc04b-${randomBytes(4).toString("hex")}-`;
  const collabPort = 12402;
  const internalPort = 12403;

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
    process.env.STREAM_MODE = "inline";
    process.env.SESSION_SECRET = "local-secret-for-jwt-signing-1234567890123456";
    process.env.INTERNAL_TOKEN = "local-internal-token-123456";
    process.env.ADMIN_TOKEN = "local-admin-token-123456";
    process.env.COLLAB_PORT = String(collabPort);
    process.env.COLLAB_INTERNAL_PORT = String(internalPort);
    process.env.NEXT_PUBLIC_COLLAB_URL = `ws://127.0.0.1:${collabPort}`;
    process.env.DAILY_CREDIT = "100000"; // Crédit large pour isoler le limiteur de débit
    process.env.ABUSE_THRESHOLD = "5";
    process.env.ABUSE_WINDOW_SEC = "60";
    process.env.BLOCK_DURATION_SEC = "900";
    process.env.RATE_MAX_UPDATES_PER_SEC = "50"; // Seuil : 50/s => 250 dans fenêtre 5s

    resetConfig();
    resetDynamoClients();
    resetS3Clients();

    await initDynamoDBTables(testPrefix);
    await initS3Bucket();
    await initSQSQueues();

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

  it("T1. Rafale : un client envoie 400 updates en 2s -> refus rate_limited, blocage pour abus, document = updates acceptés", async () => {
    const wBob = await upsertWriter("Bob Burst", "bob-burst@asso.fr");
    const docBob = await createDocument("Doc Bob Burst", wBob);
    const token = await createCollabToken({ writerId: wBob.writerId, docId: docBob.docId });

    const ydoc = new Y.Doc();
    const refusedReasons: string[] = [];
    let connectionClosed = false;

    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docBob.docId,
      document: ydoc,
      token,
      onStateless(payload) {
        try {
          const parsed = JSON.parse(payload.payload);
          if (parsed.type === "write_refused") {
            refusedReasons.push(parsed.reason);
          }
        } catch {
          // Ignorer
        }
      },
    });

    provider.on("close", () => {
      connectionClosed = true;
    });

    await new Promise<void>((resolve) => provider.on("synced", () => resolve()));

    // Envoyer 400 updates distincts en moins de 2s
    for (let i = 0; i < 400; i++) {
      ydoc.getText("content").insert(i, "X");
    }

    // Attendre que les refus rate_limited et/ou la fermeture de connexion surviennent
    const start = Date.now();
    while ((refusedReasons.length === 0 || !connectionClosed) && Date.now() - start < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Des refus rate_limited doivent avoir été émis
    expect(refusedReasons.length).toBeGreaterThan(0);
    expect(refusedReasons).toContain("rate_limited");

    // Le rédacteur doit être bloqué après ABUSE_THRESHOLD (5) événements rate_exceeded
    const updatedBob = await getWriter(wBob.writerId);
    expect(updatedBob?.blockedUntil).toBeDefined();
    expect(updatedBob!.blockedUntil!).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // Vérifier sur le document serveur que seuls les updates acceptés (au plus RATE_MAX_UPDATES_PER_SEC * 5 = 250) figurent
    const headBob = await getHead(docBob.docId);
    const serverText = collabServer.hocuspocus.documents.get(docBob.docId)?.getText("content").toString() || headBob.text;
    expect(serverText.length).toBeLessThan(400);
    expect(serverText.length).toBeLessThanOrEqual(250);

    provider.destroy();
  });

  it("T2. Blocage en cours de session : rédacteur connecté et en écriture -> update valide suivant sur la MÊME connexion refusé ('blocked')", async () => {
    const wCharlie = await upsertWriter("Charlie MidSession", "charlie-mid@asso.fr");
    const docCharlie = await createDocument("Doc Charlie", wCharlie);
    const token = await createCollabToken({ writerId: wCharlie.writerId, docId: docCharlie.docId });

    const ydoc = new Y.Doc();
    const refusedMessages: Array<{ reason: string; blockedUntil?: number }> = [];
    let closeCode: number | undefined;

    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docCharlie.docId,
      document: ydoc,
      token,
      onStateless(payload) {
        try {
          const parsed = JSON.parse(payload.payload);
          if (parsed.type === "write_refused") {
            refusedMessages.push(parsed);
          }
        } catch {
          // Ignorer
        }
      },
    });

    provider.on("close", (e: unknown) => {
      const evt = (e as { event?: { code?: number } })?.event;
      closeCode = evt?.code;
    });

    await new Promise<void>((resolve) => provider.on("synced", () => resolve()));

    // 1er update valide accepté
    ydoc.getText("content").insert(0, "Première frappe");
    await new Promise((r) => setTimeout(r, 400));
    expect(refusedMessages.length).toBe(0);

    // Déclencher ABUSE_THRESHOLD (5) événements d'abus pour bloquer Charlie PENDANT sa session
    for (let i = 0; i < 5; i++) {
      await recordAbuseEvent(wCharlie.writerId, "invalid_update");
    }

    const charlieDdb = await getWriter(wCharlie.writerId);
    expect(charlieDdb?.blockedUntil).toBeDefined();

    // Tenter un update VALIDE sur la MÊME connexion ouverte
    ydoc.getText("content").insert(15, " Interdit");
    await new Promise((r) => setTimeout(r, 600));

    // L'update doit être refusé avec reason "blocked" et la connexion fermée avec 4403
    expect(refusedMessages.some((m) => m.reason === "blocked")).toBe(true);
    expect(closeCode).toBe(4403);

    // Vérifier que le texte n'a pas été modifié par l'update interdit
    const headCharlie = await getHead(docCharlie.docId);
    const serverTextCharlie =
      collabServer.hocuspocus.documents.get(docCharlie.docId)?.getText("content").toString() ||
      headCharlie.text;
    expect(serverTextCharlie).toBe("Première frappe");

    provider.destroy();
  });

  it("T3. Déblocage : POST admin unblock -> après expiration du cache (5s), reconnexion écrit normalement", async () => {
    const wDavid = await upsertWriter("David Unblock", "david-unblock@asso.fr");
    const docDavid = await createDocument("Doc David", wDavid);

    // Bloquer David
    for (let i = 0; i < 5; i++) {
      await recordAbuseEvent(wDavid.writerId, "quota_refused");
    }
    const ddbBlocked = await getWriter(wDavid.writerId);
    expect(ddbBlocked?.blockedUntil).toBeDefined();

    // Débloquer via l'API admin unblock
    const req = new NextRequest("http://127.0.0.1:3000/api/admin/unblock", {
      method: "POST",
      headers: {
        "x-admin-token": "local-admin-token-123456",
        "content-type": "application/json",
      },
      body: JSON.stringify({ writerId: wDavid.writerId }),
    });
    const res = await unblockPost(req);
    expect(res.status).toBe(200);

    // Attendre 5,1 s pour l'expiration du cache mémoire de blocage (5 s)
    await new Promise((resolve) => setTimeout(resolve, 5200));

    // Reconnexion avec nouveau token
    const token = await createCollabToken({ writerId: wDavid.writerId, docId: docDavid.docId });
    const ydoc = new Y.Doc();
    let refused = false;

    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docDavid.docId,
      document: ydoc,
      token,
      onStateless(payload) {
        try {
          const parsed = JSON.parse(payload.payload);
          if (parsed.type === "write_refused") refused = true;
        } catch {
          // Ignorer
        }
      },
    });

    await new Promise<void>((resolve) => provider.on("synced", () => resolve()));

    ydoc.getText("content").insert(0, "David écrit après déblocage");
    await new Promise((r) => setTimeout(r, 600));

    expect(refused).toBe(false);

    // Vérifier persistance sur le document serveur
    const serverTextDavid = collabServer.hocuspocus.documents.get(docDavid.docId)?.getText("content").toString();
    expect(serverTextDavid).toBe("David écrit après déblocage");

    provider.destroy();
  });

  it("T4. Frappe humaine normale (3 updates/s) n'est jamais refusée", async () => {
    const wEva = await upsertWriter("Eva Normal", "eva-normal@asso.fr");
    const docEva = await createDocument("Doc Eva", wEva);
    const token = await createCollabToken({ writerId: wEva.writerId, docId: docEva.docId });

    const ydoc = new Y.Doc();
    const refusedMessages: string[] = [];

    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${collabPort}`,
      name: docEva.docId,
      document: ydoc,
      token,
      onStateless(payload) {
        try {
          const parsed = JSON.parse(payload.payload);
          if (parsed.type === "write_refused") {
            refusedMessages.push(parsed.reason);
          }
        } catch {
          // Ignorer
        }
      },
    });

    await new Promise<void>((resolve) => provider.on("synced", () => resolve()));

    // Simuler frappe humaine : 6 updates espacés de 330ms (~3 updates/s)
    const textToType = "Bonjour !";
    for (let i = 0; i < textToType.length; i++) {
      ydoc.getText("content").insert(i, textToType[i]);
      await new Promise((r) => setTimeout(r, 330));
    }

    await new Promise((r) => setTimeout(r, 400));

    expect(refusedMessages.length).toBe(0);
    expect(ydoc.getText("content").toString()).toBe("Bonjour !");

    provider.destroy();
  });
});
