import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import esbuild from "esbuild";
import * as Y from "yjs";
import { DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { initDynamoDBTables, initS3Bucket, initSQSQueues } from "../../scripts/local-init";
import { resetConfig, tableName, ALL_TABLES } from "@shared/config";
import { getDocClient, getDynamoDBClient, resetDynamoClients } from "@shared/aws/dynamodb";
import { resetS3Clients } from "@shared/aws/s3";
import { upsertWriter } from "@shared/auth/session";
import { createDocument } from "@shared/docs/documents";
import { createLink } from "@shared/links/links";
import { handleDownloadRequest, handleGetReservation } from "@shared/links/reservations";
import { getPdfJob } from "@shared/pdf/jobs";
import * as renderMod from "@shared/pdf/render";
import { persistDocumentSnapshot, resetDocStates } from "../../collab/server";

describe("C-04 — Rendu PDF hors du PDF-Worker", () => {
  const testPrefix = `test-c04-${randomBytes(4).toString("hex")}-`;

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

  it("T1. Poller SQS arrêté, réservation sans PDF : GET reservation renvoie 202 'preparing', renderPdfBuffer : 0 appel, job 'pending' existe", async () => {
    const writer = await upsertWriter("Author C04", "author-c04@test.fr");
    const { docId } = await createDocument("Doc C04 Isolation", writer);
    const link = await createLink({
      docId,
      creatorId: writer.writerId,
      creatorEmail: writer.email,
      creatorName: writer.name,
      maxDownloads: 10,
    });

    const requestId = randomUUID();
    // 1. Première requête de téléchargement : crée la réservation et le job SQS
    const postRes = await handleDownloadRequest(link.linkId, requestId);
    expect(postRes.status).toBe(202);
    expect(postRes.body.state).toBe("preparing");

    // 2. Espion sur renderPdfBuffer : ne doit JAMAIS être appelé dans handleGetReservation
    const renderSpy = vi.spyOn(renderMod, "renderPdfBuffer");

    // 3. Polling GET reservation
    const getRes = await handleGetReservation(link.linkId, requestId);

    expect(renderSpy).toHaveBeenCalledTimes(0);
    expect(getRes.status).toBe(202);
    expect(getRes.body.state).toBe("preparing");

    // 4. Vérifier qu'un job pdf_jobs existe bien avec le statut "pending"
    const docClient = getDocClient();
    const resItem = await docClient.send(
      new GetCommand({
        TableName: tableName("reservations"),
        Key: { linkId: link.linkId, reservationId: requestId },
      }),
    );
    const versionId = resItem.Item?.versionId as string;
    expect(versionId).toBeDefined();
    const job = await getPdfJob(docId, versionId);
    expect(job).toBeDefined();
    expect(job?.status).toBe("pending");

    renderSpy.mockRestore();
  });

  it("T2. Test de bundle : metafile sans pdfkit pour download-api et taille zip < 3 Mo", async () => {
    const rootDir = path.resolve(__dirname, "../..");
    const entryPoint = path.resolve(rootDir, "lambdas/download-api.ts");
    const tempOut = path.resolve(rootDir, "dist/lambdas/test-download-api-meta.js");

    const result = await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      outfile: tempOut,
      metafile: true,
      external: [],
    });

    if (fs.existsSync(tempOut)) {
      fs.unlinkSync(tempOut);
    }

    const inputs = Object.keys(result.metafile.inputs);
    const hasPdfKit = inputs.some((inp) => inp.includes("node_modules/pdfkit"));
    expect(hasPdfKit).toBe(false);

    const zipPath = path.resolve(rootDir, "dist/lambdas/download-api.zip");
    if (fs.existsSync(zipPath)) {
      const stats = fs.statSync(zipPath);
      expect(stats.size).toBeLessThan(3 * 1024 * 1024);
    }
  });

  it("T3. Snapshot : espion sur renderPdfBuffer : 0 appel lors de persistDocumentSnapshot", async () => {
    resetDocStates();
    const docId = `doc-snap-${randomBytes(4).toString("hex")}`;
    const ydoc = new Y.Doc();
    ydoc.getText("content").insert(0, "Texte sans rendu direct PDF.");

    const renderSpy = vi.spyOn(renderMod, "renderPdfBuffer");

    await persistDocumentSnapshot(docId, ydoc, "auto");

    expect(renderSpy).toHaveBeenCalledTimes(0);
    renderSpy.mockRestore();
  });
});
