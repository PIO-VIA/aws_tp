import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes, randomUUID } from "crypto";
import { DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import * as Y from "yjs";
import { initDynamoDBTables, initS3Bucket, initSQSQueues } from "../../scripts/local-init";
import { resetConfig, ALL_TABLES, tableName } from "@shared/config";
import { getDynamoDBClient, resetDynamoClients, getDocClient } from "@shared/aws/dynamodb";
import { resetS3Clients, putObjectIfNotExist } from "@shared/aws/s3";
import { createLink, getLink } from "@shared/links/links";
import {
  handleDownloadRequest,
  handleGetReservation,
  advanceReservation,
} from "@shared/links/reservations";
import { ReservationRecord } from "@shared/links/types";
import { reconcilePdfJobs } from "@shared/reconcile/reconciler";
import { processPdfJob } from "@shared/pdf/worker";
import { getPdfJob } from "@shared/pdf/jobs";
import * as headMod from "@shared/docs/head";
import * as sqsMod from "@shared/aws/sqs";
import { renderPdfBuffer } from "@shared/pdf/render";

describe("C-05 — Réservation orpheline et reprise (advanceReservation)", () => {
  const testPrefix = `test-c05-${randomBytes(4).toString("hex")}-`;

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
    process.env.HEAD_COALESCE_MS = "0";

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
        // Ignorer
      }
    }
  });

  it("T1. getHead échoue au premier appel : réponse 202 avec reservationId ; 2ème appel (même requestId) aboutit ; links.issued n'augmente que de 1", async () => {
    const docId = `doc-c05-t1-${randomUUID().substring(0, 8)}`;
    const link = await createLink({
      docId,
      creatorId: "creator-c05",
      creatorEmail: "creator@example.org",
      creatorName: "Creator C05",
      maxDownloads: 5,
    });

    // Écrire un update dans doc_updates pour que getHead trouve du contenu
    const ydoc = new Y.Doc();
    const initialText = "Contenu pour le test C05 T1";
    ydoc.getText("content").insert(0, initialText);
    const updateBytes = Y.encodeStateAsUpdate(ydoc);
    const docClient = getDocClient();
    await docClient.send(
      new PutCommand({
        TableName: tableName("doc_updates"),
        Item: {
          docId,
          seq: 1,
          update: Buffer.from(updateBytes),
          writerId: "w-c05",
          billedChars: initialText.length,
          createdAt: Math.floor(Date.now() / 1000),
          ttl: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    );

    const requestId = randomUUID();

    // Injecter un échec sur getHead lors du premier appel
    const getHeadSpy = vi.spyOn(headMod, "getHead").mockRejectedValueOnce(
      new Error("Injection panne transitoire getHead"),
    );

    // 1er appel : handleDownloadRequest ne doit JAMAIS renvoyer 500, mais 202 preparing avec reservationId
    const res1 = await handleDownloadRequest(link.linkId, requestId);
    expect(res1.status).toBe(202);
    expect(res1.body.state).toBe("preparing");
    if (res1.body.state === "preparing") {
      expect(res1.body.reservationId).toBe(requestId);
    }

    // Vérifier que links.issued a été incrémenté exactement de 1
    const linkAfter1 = await getLink(link.linkId);
    expect(linkAfter1?.issued).toBe(1);

    // Vérifier que la réservation existe dans DynamoDB avec status 'reserved' mais sans versionId
    const ddbRes1 = await docClient.send(
      new GetCommand({
        TableName: tableName("reservations"),
        Key: { linkId: link.linkId, reservationId: requestId },
      }),
    );
    expect(ddbRes1.Item).toBeDefined();
    expect(ddbRes1.Item?.status).toBe("reserved");
    expect(ddbRes1.Item?.versionId).toBeUndefined();

    // Restaurer le spy
    getHeadSpy.mockRestore();

    // 2ème appel avec le MÊME requestId : doit reprendre la réservation orpheline
    const res2 = await handleDownloadRequest(link.linkId, requestId);
    expect(res2.status).toBe(202);
    expect(res2.body.state).toBe("preparing");
    if (res2.body.state === "preparing") {
      expect(res2.body.reservationId).toBe(requestId);
    }

    // links.issued ne doit PAS avoir été réincrémenté : toujours 1 !
    const linkAfter2 = await getLink(link.linkId);
    expect(linkAfter2?.issued).toBe(1);

    // Vérifier que la réservation a maintenant un versionId
    const ddbRes2 = await docClient.send(
      new GetCommand({
        TableName: tableName("reservations"),
        Key: { linkId: link.linkId, reservationId: requestId },
      }),
    );
    expect(ddbRes2.Item?.versionId).toBeDefined();
    const versionId = ddbRes2.Item!.versionId;

    // Traiter le job PDF généré
    await processPdfJob({ docId, versionId });

    // Le polling GET ou un nouvel appel doit retourner "granted"
    const pollRes = await handleGetReservation(link.linkId, requestId);
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.state).toBe("granted");
    if (pollRes.body.state === "granted") {
      expect(pollRes.body.url).toBeDefined();
    }

    // links.issued toujours 1
    const linkFinal = await getLink(link.linkId);
    expect(linkFinal?.issued).toBe(1);
  });

  it("T2. Échec de l'envoi SQS : job créé 'pending' ; le reconciler republie ; la réservation aboutit", async () => {
    const docId = `doc-c05-t2-${randomUUID().substring(0, 8)}`;
    const link = await createLink({
      docId,
      creatorId: "creator-c05-t2",
      creatorEmail: "creator2@example.org",
      creatorName: "Creator C05 T2",
      maxDownloads: 5,
    });

    const ydoc = new Y.Doc();
    const initialText = "Contenu pour le test C05 T2";
    ydoc.getText("content").insert(0, initialText);
    const updateBytes = Y.encodeStateAsUpdate(ydoc);
    const docClient = getDocClient();
    await docClient.send(
      new PutCommand({
        TableName: tableName("doc_updates"),
        Item: {
          docId,
          seq: 1,
          update: Buffer.from(updateBytes),
          writerId: "w-c05-t2",
          billedChars: initialText.length,
          createdAt: Math.floor(Date.now() / 1000),
          ttl: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    );

    const requestId = randomUUID();

    // Espionner SQS sendPdfJob pour simuler une panne SQS
    const sqsSpy = vi.spyOn(sqsMod, "sendPdfJob").mockRejectedValueOnce(
      new Error("Panne réseau SQS"),
    );

    const res = await handleDownloadRequest(link.linkId, requestId);
    expect(res.status).toBe(202);
    expect(res.body.state).toBe("preparing");

    sqsSpy.mockRestore();

    // Vérifier la réservation
    const ddbRes = await docClient.send(
      new GetCommand({
        TableName: tableName("reservations"),
        Key: { linkId: link.linkId, reservationId: requestId },
      }),
    );
    expect(ddbRes.Item?.versionId).toBeDefined();
    const versionId = ddbRes.Item!.versionId;

    // Vérifier que le job existe dans pdf_jobs avec status 'pending'
    const job = await getPdfJob(docId, versionId);
    expect(job).toBeDefined();
    expect(job?.status).toBe("pending");

    // Simuler le vieillissement du job pour que le reconciler le prenne en compte (> 120s)
    await docClient.send(
      new UpdateCommand({
        TableName: tableName("pdf_jobs"),
        Key: { jobId: `${docId}#${versionId}` },
        UpdateExpression: "SET updatedAt = :past",
        ExpressionAttributeValues: {
          ":past": Math.floor(Date.now() / 1000) - 150,
        },
      }),
    );

    // Lancer la réconciliation
    const recStats = await reconcilePdfJobs();
    expect(recStats.republished).toBeGreaterThanOrEqual(1);

    // Traiter le job republié
    await processPdfJob({ docId, versionId });

    // La réservation doit maintenant aboutir à 'granted'
    const finalRes = await handleGetReservation(link.linkId, requestId);
    expect(finalRes.status).toBe(200);
    expect(finalRes.body.state).toBe("granted");
    if (finalRes.body.state === "granted") {
      expect(finalRes.body.url).toBeDefined();
    }
  });

  it("T3. Deux advanceReservation concurrents sur la même réservation : un seul versionId écrit, une seule URL émise", async () => {
    const docId = `doc-c05-t3-${randomUUID().substring(0, 8)}`;
    const link = await createLink({
      docId,
      creatorId: "creator-c05-t3",
      creatorEmail: "creator3@example.org",
      creatorName: "Creator C05 T3",
      maxDownloads: 5,
    });

    const ydoc = new Y.Doc();
    const initialText = "Contenu pour le test C05 T3";
    ydoc.getText("content").insert(0, initialText);
    const updateBytes = Y.encodeStateAsUpdate(ydoc);
    const docClient = getDocClient();
    await docClient.send(
      new PutCommand({
        TableName: tableName("doc_updates"),
        Item: {
          docId,
          seq: 1,
          update: Buffer.from(updateBytes),
          writerId: "w-c05-t3",
          billedChars: initialText.length,
          createdAt: Math.floor(Date.now() / 1000),
          ttl: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    );

    const head = await headMod.getHead(docId);
    const versionId = head.versionId;

    // Pré-générer et stocker le PDF dans S3 pour que headObject retourne true
    const pdfBuf = await renderPdfBuffer("Doc C05 T3", initialText, versionId);
    await putObjectIfNotExist(`pdfs/${docId}/${versionId}.pdf`, pdfBuf, "application/pdf");

    // Créer une réservation orpheline 'reserved' sans versionId
    const reservationId = randomUUID();
    const nowSec = Math.floor(Date.now() / 1000);
    const resRecord: ReservationRecord = {
      linkId: link.linkId,
      reservationId,
      status: "reserved",
      docId,
      createdAt: nowSec,
      ttl: nowSec + 86400,
    };

    await docClient.send(
      new PutCommand({
        TableName: tableName("reservations"),
        Item: resRecord,
      }),
    );

    // Exécuter 2 advanceReservation en concurrence stricte sur la même réservation
    const [resA, resB] = await Promise.all([
      advanceReservation(resRecord),
      advanceReservation(resRecord),
    ]);

    expect(resA.status).toBe(200);
    expect(resA.body.state).toBe("granted");
    expect(resB.status).toBe(200);
    expect(resB.body.state).toBe("granted");

    if (resA.body.state === "granted" && resB.body.state === "granted") {
      // Les deux doivent retourner la même URL et le même nom de fichier
      expect(resA.body.url).toBe(resB.body.url);
      expect(resA.body.filename).toBe(resB.body.filename);
    }

    // Vérifier dans DynamoDB : status 'url_issued', versionId unique et URL unique
    const ddbRes = await docClient.send(
      new GetCommand({
        TableName: tableName("reservations"),
        Key: { linkId: link.linkId, reservationId },
        ConsistentRead: true,
      }),
    );
    expect(ddbRes.Item?.status).toBe("url_issued");
    expect(ddbRes.Item?.versionId).toBe(versionId);
    if (resA.body.state === "granted") {
      expect(ddbRes.Item?.url).toBe(resA.body.url);
    }
  });
});
