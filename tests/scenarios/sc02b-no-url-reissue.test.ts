import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { initDynamoDBTables, initS3Bucket, initSQSQueues } from "../../scripts/local-init";
import { resetConfig, tableName, ALL_TABLES } from "@shared/config";
import { getDocClient, getDynamoDBClient, resetDynamoClients } from "@shared/aws/dynamodb";
import { createLink, resetExhaustedCache } from "@shared/links/links";
import { handleDownloadRequest, handleGetReservation } from "@shared/links/reservations";
import { putObject, resetS3Clients } from "@shared/aws/s3";
import { renderPdfBuffer, computeVersionId } from "@shared/pdf/render";

type DlBody = { state: string; url?: string };

describe("SC02b — Pas de réémission d'URL pré-signée après expiration (C-02 / C1)", () => {
  const testPrefix = `test-sc02b-${randomBytes(4).toString("hex")}-`;

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
    process.env.PRESIGN_TTL_SEC = "1"; // TTL court pour les tests d'expiration

    resetConfig();
    resetDynamoClients();
    resetS3Clients();

    await initDynamoDBTables(testPrefix);
    await initS3Bucket();
    await initSQSQueues();
  });

  afterAll(async () => {
    const ddb = getDynamoDBClient();
    for (const key of ALL_TABLES) {
      try {
        await ddb.send(new DeleteTableCommand({ TableName: `${testPrefix}${key}` }));
      } catch {
        // Ignorer si déjà supprimée
      }
    }
  });

  it("T1. PRESIGN_TTL_SEC=1 : Réserver, obtenir granted (u1), attendre 2s -> 10 appels GET retournent expired et u1 reste l'unique URL", async () => {
    resetExhaustedCache();
    const docId = `doc-t1-${randomUUID().substring(0, 8)}`;
    const versionId = computeVersionId("");
    const pdfBuf = await renderPdfBuffer("Doc T1", "Contenu T1", versionId);
    await putObject(`pdfs/${docId}/${versionId}.pdf`, pdfBuf, "application/pdf");

    const link = await createLink({
      docId,
      creatorId: "creator-t1",
      creatorEmail: "t1@example.org",
      creatorName: "T1",
      maxDownloads: 5,
    });

    const visitorId = randomUUID();
    const initRes = await handleDownloadRequest(link.linkId, visitorId);
    expect(initRes.body.state).toBe("granted");
    const u1 = (initRes.body as { state: "granted"; url: string }).url;
    expect(u1).toBeDefined();

    // Attendre 2 secondes pour dépasser le TTL de 1s
    await new Promise((r) => setTimeout(r, 2000));

    // Appeler 10 fois GET /reservations/:id
    const distinctUrls = new Set<string>([u1]);
    for (let i = 0; i < 10; i++) {
      const getRes = await handleGetReservation(link.linkId, visitorId);
      expect(getRes.body.state).toBe("expired");
      const maybeUrl = (getRes.body as DlBody).url;
      if (maybeUrl) {
        distinctUrls.add(maybeUrl);
      }
    }

    // L'ensemble des URL distinctes obtenues pendant tout le test est exactement {u1}
    expect(Array.from(distinctUrls)).toEqual([u1]);
  });

  it("T2. Idempotence : avant expiration, 5 appels successifs renvoient la MÊME url u1", async () => {
    resetExhaustedCache();
    const docId = `doc-t2-${randomUUID().substring(0, 8)}`;
    const versionId = computeVersionId("");
    const pdfBuf = await renderPdfBuffer("Doc T2", "Contenu T2", versionId);
    await putObject(`pdfs/${docId}/${versionId}.pdf`, pdfBuf, "application/pdf");

    // Augmenter temporairement le TTL pour ce test d'idempotence
    process.env.PRESIGN_TTL_SEC = "60";
    resetConfig();

    const link = await createLink({
      docId,
      creatorId: "creator-t2",
      creatorEmail: "t2@example.org",
      creatorName: "T2",
      maxDownloads: 5,
    });

    const visitorId = randomUUID();
    const req1 = await handleDownloadRequest(link.linkId, visitorId);
    expect(req1.body.state).toBe("granted");
    const u1 = (req1.body as { state: "granted"; url: string }).url;
    expect(u1).toBeDefined();

    // 5 appels successifs (mélange de POST idempotent et GET)
    for (let i = 0; i < 5; i++) {
      const postDup = await handleDownloadRequest(link.linkId, visitorId);
      expect(postDup.body.state).toBe("granted");
      expect((postDup.body as DlBody).url).toBe(u1);

      const getRes = await handleGetReservation(link.linkId, visitorId);
      expect(getRes.body.state).toBe("granted");
      expect((getRes.body as DlBody).url).toBe(u1);
    }

    // Remettre PRESIGN_TTL_SEC à 1
    process.env.PRESIGN_TTL_SEC = "1";
    resetConfig();
  });

  it(
    "T3. Invariant global : 50 exemplaires, 200 visiteurs, polling répété sur 3xTTL -> nombre d'URL distinctes <= 50",
    { timeout: 30000 },
    async () => {
      resetExhaustedCache();
      const docId = `doc-t3-${randomUUID().substring(0, 8)}`;
      const versionId = computeVersionId("");
      const pdfBuf = await renderPdfBuffer("Doc T3", "Contenu T3", versionId);
      await putObject(`pdfs/${docId}/${versionId}.pdf`, pdfBuf, "application/pdf");

      process.env.PRESIGN_TTL_SEC = "1";
      resetConfig();

      const link = await createLink({
        docId,
        creatorId: "creator-t3",
        creatorEmail: "t3@example.org",
        creatorName: "T3",
        maxDownloads: 50,
      });

      const visitors = Array.from({ length: 200 }, () => randomUUID());

      // 1. Première passe : acquérir les 50 exemplaires autorisés
      const emittedUrls = new Set<string>();
      const admittedVisitors: string[] = [];
      const perVisitorUrls = new Map<string, Set<string>>();

      for (const v of visitors) {
        if (admittedVisitors.length >= 50) break;
        const res = await handleDownloadRequest(link.linkId, v);
        if (res.body.state === "granted" || res.body.state === "preparing") {
          perVisitorUrls.set(v, new Set());
          const maybeUrl = (res.body as DlBody).url;
          if (maybeUrl) {
            emittedUrls.add(maybeUrl);
            perVisitorUrls.get(v)!.add(maybeUrl);
          }
          admittedVisitors.push(v);
        }
      }
      expect(admittedVisitors.length).toBe(50);

      // Obtenir l'URL initiale pour chacun des 50 visiteurs admis (avant expiration)
      for (const v of admittedVisitors) {
        const r = await handleGetReservation(link.linkId, v);
        const rUrl = (r.body as DlBody).url;
        if (r.body.state === "granted" && rUrl) {
          emittedUrls.add(rUrl);
          perVisitorUrls.get(v)!.add(rUrl);
        }
      }

      // Attendre 2 secondes (> 1x TTL de 1 seconde pour que les URLs initiales expirent)
      await new Promise((r) => setTimeout(r, 2000));

      // 2. Polling répété sur les visiteurs admis pendant 3x TTL (3 rounds x 1.2s = 3.6s > 3s)
      // Avant correctif : chaque round régénère de nouvelles URLs pré-signées pour chaque visiteur
      // Après correctif : les réservations expirées renvoient "expired" sans générer d'URL
      for (let round = 0; round < 3; round++) {
        const roundResponses = await Promise.all(
          admittedVisitors.map(async (v) => {
            const res = await handleGetReservation(link.linkId, v);
            return { v, res };
          }),
        );

        for (const { v, res: r } of roundResponses) {
          const pollUrl = (r.body as DlBody).url;
          if (r.body.state === "granted" && pollUrl) {
            emittedUrls.add(pollUrl);
            perVisitorUrls.get(v)!.add(pollUrl);
          }
        }

        await new Promise((r) => setTimeout(r, 1200));
      }

      // Avant correctif : chaque visiteur reçoit de nouvelles URL à chaque round (urls.size > 1)
      // Après correctif : aucun visiteur ne reçoit plus de 1 URL
      for (const v of admittedVisitors) {
        expect(perVisitorUrls.get(v)!.size).toBe(1);
      }

      // Invariant fondamental C1 : JAMAIS plus d'URL pré-signées distinctes que maxDownloads (50)
      expect(emittedUrls.size).toBeLessThanOrEqual(50);
    },
  );

  it("T4. Table reservations : au plus UNE transition vers url_issued par réservation", async () => {
    resetExhaustedCache();
    const docId = `doc-t4-${randomUUID().substring(0, 8)}`;
    const versionId = computeVersionId("");
    const pdfBuf = await renderPdfBuffer("Doc T4", "Contenu T4", versionId);
    await putObject(`pdfs/${docId}/${versionId}.pdf`, pdfBuf, "application/pdf");

    process.env.PRESIGN_TTL_SEC = "1";
    resetConfig();

    const link = await createLink({
      docId,
      creatorId: "creator-t4",
      creatorEmail: "t4@example.org",
      creatorName: "T4",
      maxDownloads: 1,
    });

    const visitorId = randomUUID();
    const res1 = await handleDownloadRequest(link.linkId, visitorId);
    expect(res1.body.state).toBe("granted");

    // Attendre l'expiration
    await new Promise((r) => setTimeout(r, 1500));

    // Plusieurs interrogations
    await handleGetReservation(link.linkId, visitorId);
    await handleGetReservation(link.linkId, visitorId);

    // Vérifier l'enregistrement DynamoDB
    const docClient = getDocClient();
    const dbRes = await docClient.send(
      new GetCommand({
        TableName: tableName("reservations"),
        Key: { linkId: link.linkId, reservationId: visitorId },
      }),
    );

    const item = dbRes.Item;
    expect(item).toBeDefined();
    expect(item?.status).toBe("url_issued");
    // L'URL en base doit être celle de la première émission (pas d'écrasement ni de regénération)
    expect(item?.url).toBe((res1.body as DlBody).url);
  });
});
