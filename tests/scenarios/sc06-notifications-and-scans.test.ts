import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";
import { DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { PutCommand, GetCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { initDynamoDBTables, initS3Bucket, initSQSQueues } from "../../scripts/local-init";
import { resetConfig, ALL_TABLES, tableName } from "@shared/config";
import { getDynamoDBClient, resetDynamoClients, getDocClient } from "@shared/aws/dynamodb";
import { resetS3Clients } from "@shared/aws/s3";
import { upsertWriter } from "@shared/auth/session";
import { createDocument } from "@shared/docs/documents";
import { createLink } from "@shared/links/links";
import { handleLinkChange, sendLastCopyNotification } from "@shared/notify/notifier";
import { resetMailer } from "@shared/aws/mailer";
import { reconcileNotifications } from "@shared/reconcile/reconciler";
import { processPdfDlqMessage } from "@shared/pdf/dlq";
import { ReservationRecord } from "@shared/links/types";

describe("SC06 — Scans paginés et réservation conditionnelle de notification (C-06)", () => {
  const testPrefix = `test-sc06-${randomBytes(4).toString("hex")}-`;

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
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = "1025";
    process.env.SMTP_FROM = "noreply@journal.local";

    resetConfig();
    resetDynamoClients();
    resetS3Clients();

    await initDynamoDBTables(testPrefix);
    await initS3Bucket();
    await initSQSQueues();

    const w = await upsertWriter("Alice Sc06", "alice-sc06@asso.fr");
    writerAlice = { writerId: w.writerId, name: w.name, email: w.email };

    const doc = await createDocument("Gazette SC06", writerAlice);
    docId = doc.docId;
  });

  afterAll(async () => {
    const ddb = getDynamoDBClient();
    for (const key of ALL_TABLES) {
      try {
        await ddb.send(new DeleteTableCommand({ TableName: `${testPrefix}${key}` }));
      } catch {
        // Ignorer
      }
    }
  });

  it("T2. 10 appels simultanés du notifier + 10 du reconciler sur la même notification : exactement 1 e-mail dans Mailpit", async () => {
    // Vider Mailpit
    await fetch("http://localhost:8025/api/v1/messages", { method: "DELETE" });

    // Créer un lien
    const link = await createLink({
      docId,
      creatorId: writerAlice.writerId,
      creatorEmail: writerAlice.email,
      creatorName: writerAlice.name,
      maxDownloads: 10,
    });
    const linkFull = {
      ...link,
      issued: 10,
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    // 10 du notifier + 10 du reconciler simultanés
    const oldLink = { linkId: link.linkId, issued: 9, maxDownloads: 10 };
    const tasks: Promise<unknown>[] = [];

    for (let i = 0; i < 10; i++) {
      tasks.push(handleLinkChange(oldLink, linkFull, "Gazette SC06"));
      tasks.push(reconcileNotifications());
    }

    await Promise.all(tasks);

    // Attendre un peu que les éventuels retours asynchrones se terminent
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Vérifier Mailpit via l'API HTTP
    const res = await fetch("http://localhost:8025/api/v1/messages");
    const data = (await res.json()) as { total: number; messages: Array<{ ID: string; To: Array<{ Address: string }> }> };

    expect(data.total).toBe(1);
    expect(data.messages[0].To[0].Address).toBe(writerAlice.email);

    // Vérifier l'état en base
    const docClient = getDocClient();
    const notifRes = await docClient.send(
      new GetCommand({
        TableName: tableName("notifications"),
        Key: { linkId: link.linkId },
      }),
    );

    expect(notifRes.Item).toBeDefined();
    expect(notifRes.Item?.status).toBe("sent");
    expect(notifRes.Item?.sentAt).toBeDefined();
    expect(notifRes.Item?.claimedAt).toBeUndefined();
  });

  it("T3. Réservation périmée (claimedAt ancien) reprise ; échec d'envoi : status 'pending' et attempts+1 ; puis reconciler : 1 e-mail, status 'sent'", async () => {
    await fetch("http://localhost:8025/api/v1/messages", { method: "DELETE" });

    const link = await createLink({
      docId,
      creatorId: writerAlice.writerId,
      creatorEmail: writerAlice.email,
      creatorName: writerAlice.name,
      maxDownloads: 25,
    });
    const docClient = getDocClient();
    const now = Math.floor(Date.now() / 1000);

    // Notification périmée (claimedAt = now - 200, status "pending")
    await docClient.send(
      new PutCommand({
        TableName: tableName("notifications"),
        Item: {
          linkId: link.linkId,
          status: "pending",
          claimedAt: now - 200,
          attempts: 1,
          createdAt: now - 300,
        },
      }),
    );

    // Simuler panne SMTP en pointant temporairement vers un mauvais port
    process.env.SMTP_PORT = "9999";
    resetConfig();
    resetMailer();

    const failedRes = await sendLastCopyNotification(link.linkId);
    expect(failedRes.sent).toBe(false);

    // Vérifier que le statut est revenu à "pending", attempts incrémenté, claimedAt supprimé
    const checkFailed = await docClient.send(
      new GetCommand({
        TableName: tableName("notifications"),
        Key: { linkId: link.linkId },
      }),
    );
    expect(checkFailed.Item?.status).toBe("pending");
    expect(checkFailed.Item?.attempts).toBe(2);
    expect(checkFailed.Item?.claimedAt).toBeUndefined();
    expect(checkFailed.Item?.lastError).toBeDefined();

    // Rétablir SMTP valide
    process.env.SMTP_PORT = "1025";
    resetConfig();
    resetMailer();

    // Reconciler doit maintenant réussir l'envoi
    const recRes = await reconcileNotifications();
    expect(recRes.sent).toBeGreaterThanOrEqual(1);

    const checkSuccess = await docClient.send(
      new GetCommand({
        TableName: tableName("notifications"),
        Key: { linkId: link.linkId },
      }),
    );
    expect(checkSuccess.Item?.status).toBe("sent");
    expect(checkSuccess.Item?.sentAt).toBeDefined();

    // Exactement 1 e-mail dans Mailpit
    const mailpitRes = await fetch("http://localhost:8025/api/v1/messages");
    const mailData = (await mailpitRes.json()) as { total: number };
    expect(mailData.total).toBe(1);
  });

  it("T4. DLQ handler avec 1500 réservations (pagination) : toutes les 'reserved' de la version sont remboursées, aucune 'url_issued'", async () => {
    const link = await createLink({
      docId,
      creatorId: writerAlice.writerId,
      creatorEmail: writerAlice.email,
      creatorName: writerAlice.name,
      maxDownloads: 2000,
    });
    const docClient = getDocClient();
    const versionId = "version-dlq-test-123456";
    const resTable = tableName("reservations");

    // Créer un job en pending
    await docClient.send(
      new PutCommand({
        TableName: tableName("pdf_jobs"),
        Item: {
          jobId: `${docId}#${versionId}`,
          docId,
          versionId,
          status: "pending",
          attempts: 1,
          createdAt: Math.floor(Date.now() / 1000),
        },
      }),
    );

    // Mettre link.issued à 1510
    await docClient.send(
      new PutCommand({
        TableName: tableName("links"),
        Item: {
          ...link,
          issued: 1510,
          createdAt: Math.floor(Date.now() / 1000),
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    );

    // Insérer 1500 réservations "reserved" et 10 "url_issued" par batchs de 25
    const allRecords: ReservationRecord[] = [];
    for (let i = 0; i < 1500; i++) {
      allRecords.push({
        reservationId: `res-reserved-${i.toString().padStart(4, "0")}`,
        linkId: link.linkId,
        status: "reserved",
        docId,
        versionId,
        createdAt: Math.floor(Date.now() / 1000),
        ttl: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    for (let i = 0; i < 10; i++) {
      allRecords.push({
        reservationId: `res-issued-${i}`,
        linkId: link.linkId,
        status: "url_issued",
        docId,
        versionId,
        url: "http://example.com/pdf",
        urlExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        createdAt: Math.floor(Date.now() / 1000),
        ttl: Math.floor(Date.now() / 1000) + 3600,
      });
    }

    for (let i = 0; i < allRecords.length; i += 25) {
      const chunk = allRecords.slice(i, i + 25);
      await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [resTable]: chunk.map((it) => ({
              PutRequest: { Item: it },
            })),
          },
        }),
      );
    }

    // Exécuter processPdfDlqMessage
    const dlqRes = await processPdfDlqMessage({
      docId,
      versionId,
      error: "Render crash in DLQ test",
    });

    // 1500 réservations remboursées
    expect(dlqRes.refundedCount).toBe(1500);

    // Vérifier que link.issued a diminué de 1500 (1510 - 1500 = 10)
    const linkAfter = await docClient.send(
      new GetCommand({
        TableName: tableName("links"),
        Key: { linkId: link.linkId },
      }),
    );
    expect(linkAfter.Item?.issued).toBe(10);

    // Vérifier que les 10 réservations url_issued n'ont PAS été remboursées
    for (let i = 0; i < 10; i++) {
      const resItem = await docClient.send(
        new GetCommand({
          TableName: resTable,
          Key: { linkId: link.linkId, reservationId: `res-issued-${i}` },
        }),
      );
      expect(resItem.Item?.status).toBe("url_issued");
    }
  }, 120_000);
});
