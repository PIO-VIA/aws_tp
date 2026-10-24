import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { getDocClient, getDynamoDBClient, resetDynamoClients } from "../../src/shared/aws/dynamodb";
import { resetConfig, tableName, ALL_TABLES } from "../../src/shared/config";
import { resetMailer } from "../../src/shared/aws/mailer";
import { createDocument } from "../../src/shared/docs/documents";
import { createLink } from "../../src/shared/links/links";
import { handleDownloadRequest } from "../../src/shared/links/reservations";
import { handleLinkChange } from "../../src/shared/notify/notifier";
import { reconcileNotifications } from "../../src/shared/reconcile/reconciler";
import { handler as notifierLambdaHandler } from "../../lambdas/notifier";
import { NotificationRecord } from "../../src/shared/links/types";
import { initDynamoDBTables, initS3Bucket, initSQSQueues } from "../../scripts/local-init";

describe("SC05 — Notification du dernier exemplaire et Reconciler (F11, D07, Section 11 & 12)", () => {
  const testId = randomUUID().slice(0, 8);
  const testTablePrefix = `test-sc05-${testId}-`;

  const creator = {
    writerId: `creator-${testId}`,
    email: `presidence-${testId}@asso.fr`,
    name: "Président Asso",
  };

  let docId = "";
  let linkId = "";

  beforeAll(async () => {
    process.env.TABLE_PREFIX = testTablePrefix;
    process.env.APP_ENV = "local";
    process.env.DDB_ENDPOINT = "http://localhost:8000";
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.S3_FORCE_PATH_STYLE = "true";
    process.env.S3_BUCKET = "editeur-local-data";
    process.env.SQS_ENDPOINT = "http://localhost:9324";
    process.env.PDF_QUEUE_URL = "http://localhost:9324/000000000000/pdf-jobs";
    process.env.PDF_DLQ_URL = "http://localhost:9324/000000000000/pdf-jobs-dlq";
    process.env.MAIL_DRIVER = "smtp";
    process.env.SMTP_HOST = "localhost";
    process.env.SMTP_PORT = "1025";
    process.env.SESSION_SECRET = "dev-session-secret-change-in-prod-at-least-32-chars";
    process.env.INTERNAL_TOKEN = "dev-internal-token-change-in-prod";
    process.env.ADMIN_TOKEN = "dev-admin-token-change-in-prod";
    resetConfig();
    resetDynamoClients();
    resetMailer();

    // Nettoyage préalable de Mailpit
    try {
      await fetch("http://localhost:8025/api/v1/messages", { method: "DELETE" });
    } catch {
      // Ignorer
    }

    // Création des tables DynamoDB de test
    await initDynamoDBTables(testTablePrefix);
    await initS3Bucket();
    await initSQSQueues();

    // Création du document et d'un lien à 1 seul exemplaire
    const doc = await createDocument("Rapport Annuel 2026", creator);
    docId = doc.docId;

    const link = await createLink({
      docId,
      maxDownloads: 1,
      creatorId: creator.writerId,
      creatorEmail: creator.email,
      creatorName: creator.name,
    });
    linkId = link.linkId;
  });

  afterAll(async () => {
    // Nettoyage Mailpit
    try {
      await fetch("http://localhost:8025/api/v1/messages", { method: "DELETE" });
    } catch {
      // Ignorer
    }
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
    resetMailer();
  });

  it("1. Mailpit indisponible au dernier exemplaire : la notification reste 'pending' avec attempts = 1", async () => {
    // Simulation panne SMTP en pointant vers un port non desservi
    process.env.SMTP_PORT = "1026";
    resetConfig();
    resetMailer();

    // Réservation du dernier (et unique) exemplaire
    const reqId = randomUUID();
    const res = await handleDownloadRequest(linkId, reqId);
    expect(["preparing", "granted"]).toContain(res.body.state);

    // Vérification dans la table notifications
    const docClient = getDocClient();
    const notifRes = await docClient.send(
      new GetCommand({
        TableName: tableName("notifications"),
        Key: { linkId },
      }),
    );

    const notif = notifRes.Item as NotificationRecord | undefined;
    expect(notif).toBeDefined();
    expect(notif?.status).toBe("pending");
    expect(notif?.attempts).toBe(1);
    expect(notif?.lastError).toBeDefined();

    // Vérification que Mailpit n'a reçu aucun mail
    const mailpitRes = await fetch("http://localhost:8025/api/v1/messages");
    const mailpitData = await mailpitRes.json();
    expect(mailpitData.total).toBe(0);
  });

  it("2. Rétablissement de Mailpit + exécution du reconciler : un seul e-mail envoyé, statut 'sent'", async () => {
    // Rétablissement de la configuration SMTP valide
    process.env.SMTP_PORT = "1025";
    resetConfig();
    resetMailer();

    // Exécution du cycle de réconciliation des notifications
    const reconcileRes = await reconcileNotifications();
    expect(reconcileRes.sent).toBe(1);

    // Vérification dans la table notifications
    const docClient = getDocClient();
    const notifRes = await docClient.send(
      new GetCommand({
        TableName: tableName("notifications"),
        Key: { linkId },
      }),
    );

    const notif = notifRes.Item as NotificationRecord | undefined;
    expect(notif?.status).toBe("sent");
    expect(notif?.sentAt).toBeDefined();

    // Vérification dans Mailpit : exactement 1 message reçu pour ce créateur
    const mailpitRes = await fetch("http://localhost:8025/api/v1/messages");
    const mailpitData = (await mailpitRes.json()) as { messages?: Array<{ To: Array<{ Address: string }>; Subject: string }> };
    const sc05Messages = (mailpitData.messages || []).filter(
      (m) => m.To && m.To.some((t) => t.Address === creator.email),
    );
    expect(sc05Messages.length).toBe(1);

    const msg = sc05Messages[0];
    expect(msg.To[0].Address).toBe(creator.email);
    expect(msg.Subject).toContain("Dernier exemplaire téléchargé");
  });

  it("3. Rejeu de l'événement stream ou handleLinkChange : aucun e-mail supplémentaire (idempotence absolue)", async () => {
    // 1. Rejeu direct de handleLinkChange
    const directRes = await handleLinkChange(
      { linkId, issued: 0, maxDownloads: 1 },
      {
        linkId,
        docId,
        creatorId: creator.writerId,
        creatorEmail: creator.email,
        creatorName: creator.name,
        maxDownloads: 1,
        issued: 1,
        status: "active",
        createdAt: Math.floor(Date.now() / 1000),
      },
      "Rapport Annuel 2026",
    );

    expect(directRes.notified).toBe(false);

    // 2. Rejeu via le handler Lambda DynamoDB Streams
    const lambdaRes = await notifierLambdaHandler({
      Records: [
        {
          eventName: "MODIFY",
          dynamodb: {
            OldImage: {
              linkId: { S: linkId },
              issued: { N: "0" },
              maxDownloads: { N: "1" },
            },
            NewImage: {
              linkId: { S: linkId },
              docId: { S: docId },
              creatorId: { S: creator.writerId },
              creatorEmail: { S: creator.email },
              creatorName: { S: creator.name },
              maxDownloads: { N: "1" },
              issued: { N: "1" },
              status: { S: "active" },
              createdAt: { N: "1234567890" },
            },
          },
        },
      ],
    });

    expect(lambdaRes.processed).toBe(0);

    // Vérification que Mailpit contient TOUJOURS exactement 1 seul mail pour ce créateur
    const mailpitRes = await fetch("http://localhost:8025/api/v1/messages");
    const mailpitData = (await mailpitRes.json()) as { messages?: Array<{ To: Array<{ Address: string }> }> };
    const sc05Messages = (mailpitData.messages || []).filter(
      (m) => m.To && m.To.some((t) => t.Address === creator.email),
    );
    expect(sc05Messages.length).toBe(1);
  });
});
