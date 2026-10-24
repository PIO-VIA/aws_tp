import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "crypto";
import { PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { initDynamoDBTables, initS3Bucket, initSQSQueues } from "../../scripts/local-init";
import { resetConfig, tableName, ALL_TABLES } from "@shared/config";
import { getDocClient, getDynamoDBClient, resetDynamoClients } from "@shared/aws/dynamodb";
import { createLink, getLink, resetExhaustedCache } from "@shared/links/links";
import { handleDownloadRequest } from "@shared/links/reservations";
import { refundReservation } from "@shared/links/refund";
import { transitionPdfJob } from "@shared/pdf/jobs";
import { putObject, resetS3Clients } from "@shared/aws/s3";
import { renderPdfBuffer } from "@shared/pdf/render";

describe("SC02 — Réservation atomique et limite de téléchargements (C1, I01, I06, I07)", () => {
  const testPrefix = `test-sc02-${randomBytes(4).toString("hex")}-`;

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

    resetConfig();
    resetDynamoClients();
    resetS3Clients();

    await initDynamoDBTables(testPrefix);
    await initS3Bucket();
    await initSQSQueues();
  });

  afterAll(async () => {
    // Nettoyage des tables de test
    const ddb = getDynamoDBClient();
    for (const key of ALL_TABLES) {
      try {
        await ddb.send(new DeleteTableCommand({ TableName: `${testPrefix}${key}` }));
      } catch {
        // Ignorer si déjà supprimée
      }
    }
  });

  it("100 requêtes simultanées pour 1 seule copie restante : exactement 1 réservation accordée (I01, I07)", async () => {
    resetExhaustedCache();
    const docId = `doc-sc02-1-${randomUUID().substring(0, 8)}`;
    const link = await createLink({
      docId,
      creatorId: "creator-alice",
      creatorEmail: "alice@example.org",
      creatorName: "Alice",
      maxDownloads: 50,
    });

    // Simuler 49 téléchargements déjà consommés
    const docClient = getDocClient();
    await docClient.send(
      new PutCommand({
        TableName: tableName("links"),
        Item: {
          ...link,
          issued: 49,
        },
      }),
    );

    // 100 requêtes simultanées avec des UUID v4 distincts
    const requestIds = Array.from({ length: 100 }, () => randomUUID());

    const responses = await Promise.all(
      requestIds.map((reqId) => handleDownloadRequest(link.linkId, reqId)),
    );

    // Comptage des réponses
    let grantedOrPreparing = 0;
    let exhaustedCount = 0;
    let retryCount = 0;

    for (const r of responses) {
      if (r.body.state === "granted" || r.body.state === "preparing") {
        grantedOrPreparing++;
      } else if (r.body.state === "exhausted") {
        exhaustedCount++;
      } else if (r.body.state === "retry") {
        retryCount++;
      }
    }

    // Si certaines requêtes ont reçu un état transitoire "retry", on les relance pour obtenir leur état final
    if (retryCount > 0) {
      const retryReqs = responses
        .map((r, i) => ({ res: r, reqId: requestIds[i] }))
        .filter((x) => x.res.body.state === "retry");

      for (const item of retryReqs) {
        const followUp = await handleDownloadRequest(link.linkId, item.reqId);
        if (followUp.body.state === "granted" || followUp.body.state === "preparing") {
          grantedOrPreparing++;
        } else if (followUp.body.state === "exhausted") {
          exhaustedCount++;
        }
      }
    }

    // Invariant I01 : Exactement 1 réservation accordée
    expect(grantedOrPreparing).toBe(1);
    expect(exhaustedCount + grantedOrPreparing).toBe(100);

    // Vérifier l'état en base du lien
    const finalLink = await getLink(link.linkId);
    expect(finalLink).not.toBeNull();
    expect(finalLink?.issued).toBe(50);
    expect(finalLink?.issued).toBeLessThanOrEqual(finalLink!.maxDownloads);

    // Invariant D07 / I07 : Vérifier l'événement de notification unique
    const notifRes = await docClient.send(
      new GetCommand({
        TableName: tableName("notifications"),
        Key: { linkId: link.linkId },
      }),
    );
    expect(notifRes.Item).toBeDefined();
    expect(notifRes.Item?.linkId).toBe(link.linkId);
  });

  it("Idempotence stricte : répéter la même requête ne consomme pas de copie supplémentaire (I06)", async () => {
    resetExhaustedCache();
    const docId = `doc-idempotence-${randomUUID().substring(0, 8)}`;
    const link = await createLink({
      docId,
      creatorId: "creator-bob",
      creatorEmail: "bob@example.org",
      creatorName: "Bob",
      maxDownloads: 5,
    });

    const fixedRequestId = randomUUID();

    // 1ère tentative
    const res1 = await handleDownloadRequest(link.linkId, fixedRequestId);
    expect(["granted", "preparing"]).toContain(res1.body.state);

    const linkAfterFirst = await getLink(link.linkId);
    expect(linkAfterFirst?.issued).toBe(1);

    // Répétition avec exactement le même requestId
    const res2 = await handleDownloadRequest(link.linkId, fixedRequestId);
    expect(res2.body.state).toBe(res1.body.state);

    const linkAfterSecond = await getLink(link.linkId);
    // Le compteur issued ne doit pas avoir augmenté
    expect(linkAfterSecond?.issued).toBe(1);
  });

  it("600 requêtes pour 500 copies autorisées : exactement 500 réservations accordées et 100 refusées (C1, I01)", async () => {
    resetExhaustedCache();
    const docId = `doc-burst-500-${randomUUID().substring(0, 8)}`;
    const link = await createLink({
      docId,
      creatorId: "creator-charlie",
      creatorEmail: "charlie@example.org",
      creatorName: "Charlie",
      maxDownloads: 500,
    });

    // Pré-générer un PDF factice valide pour cette version afin de valider le chemin granted
    const pdfBuf = await renderPdfBuffer("Titre SC02", "Contenu de test pour 500 copies", "v-initial");
    await putObject(`pdfs/${docId}/v-initial.pdf`, pdfBuf, "application/pdf");

    // 600 visiteurs concurrents
    const visitors = Array.from({ length: 600 }, () => randomUUID());

    // Envoi par lots de 100 pour respecter la capacité locale tout en simulant une forte contention
    let accepted = 0;
    let exhausted = 0;
    const retryPool: string[] = [];

    const batchSize = 100;
    for (let b = 0; b < visitors.length; b += batchSize) {
      const slice = visitors.slice(b, b + batchSize);
      const batchRes = await Promise.all(
        slice.map((id) => handleDownloadRequest(link.linkId, id)),
      );

      for (let i = 0; i < batchRes.length; i++) {
        const r = batchRes[i];
        if (r.body.state === "granted" || r.body.state === "preparing") {
          accepted++;
        } else if (r.body.state === "exhausted") {
          exhausted++;
        } else if (r.body.state === "retry") {
          retryPool.push(slice[i]);
        }
      }
    }

    // Traitement des réessais éventuels
    for (const reqId of retryPool) {
      const r = await handleDownloadRequest(link.linkId, reqId);
      if (r.body.state === "granted" || r.body.state === "preparing") {
        accepted++;
      } else if (r.body.state === "exhausted") {
        exhausted++;
      }
    }

    // Vérification de la limite stricte C1
    expect(accepted).toBe(500);
    expect(exhausted).toBe(100);

    const finalLink = await getLink(link.linkId);
    expect(finalLink?.issued).toBe(500);
  });

  it("Remboursement sur échec de génération PDF (D-05, 10.5) et réattribution", async () => {
    resetExhaustedCache();
    const docId = `doc-refund-${randomUUID().substring(0, 8)}`;
    const link = await createLink({
      docId,
      creatorId: "creator-dave",
      creatorEmail: "dave@example.org",
      creatorName: "Dave",
      maxDownloads: 1,
    });

    const visitor1 = randomUUID();
    const req1 = await handleDownloadRequest(link.linkId, visitor1);
    expect(req1.body.state).toBe("preparing");

    // Le lien est maintenant à 1/1 (épuisé pour les nouveaux visiteurs)
    const linkMid = await getLink(link.linkId);
    expect(linkMid?.issued).toBe(1);

    const visitor2 = randomUUID();
    const req2Denied = await handleDownloadRequest(link.linkId, visitor2);
    expect(req2Denied.body.state).toBe("exhausted");

    // Échec de génération PDF injecté
    const versionId = "v-failed-test";
    await transitionPdfJob(docId, versionId, "pending", "failed", "Simulated fatal rendering error");

    // Polling du visiteur 1 constatant l'échec et déclenchant le remboursement
    // Ou appel direct de refundReservation
    const refundRes = await refundReservation(link.linkId, visitor1);
    expect(refundRes.refunded).toBe(true);

    // Après remboursement : issued repasse à 0
    const linkAfterRefund = await getLink(link.linkId);
    expect(linkAfterRefund?.issued).toBe(0);

    // Une nouvelle demande d'un autre visiteur peut maintenant obtenir l'exemplaire !
    resetExhaustedCache();
    const visitor3 = randomUUID();
    const req3 = await handleDownloadRequest(link.linkId, visitor3);
    expect(["granted", "preparing"]).toContain(req3.body.state);

    const linkFinal = await getLink(link.linkId);
    expect(linkFinal?.issued).toBe(1);
  });
});
