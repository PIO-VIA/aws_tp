import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client } from "../../src/shared/aws/s3";
import { getConfig, resetConfig } from "../../src/shared/config";
import { computeVersionId } from "../../src/shared/pdf/render";

// Fallbacks d'environnement pour exécution autonome
if (!process.env.S3_BUCKET) process.env.S3_BUCKET = "editeur-local-data";
if (!process.env.PDF_QUEUE_URL) process.env.PDF_QUEUE_URL = "http://127.0.0.1:9324/000000000000/pdf-jobs";
if (!process.env.APP_ENV) process.env.APP_ENV = "local";
if (!process.env.DDB_ENDPOINT) process.env.DDB_ENDPOINT = "http://127.0.0.1:8000";
if (!process.env.S3_ENDPOINT) process.env.S3_ENDPOINT = "http://127.0.0.1:9000";
if (!process.env.SQS_ENDPOINT) process.env.SQS_ENDPOINT = "http://127.0.0.1:9324";
resetConfig();

describe("Lambda Artefact Built Bundle (Section 20 Requirement)", () => {
  const workerDistPath = path.resolve(__dirname, "../../dist/lambdas/pdf-worker/index.js");

  beforeAll(() => {
    expect(fs.existsSync(workerDistPath)).toBe(true);
  });

  it("exécute le handler construit de pdf-worker et produit un PDF valide", async () => {
    // 1. Charger le handler exporté du bundle CJS
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const workerModule = require(workerDistPath);
    expect(typeof workerModule.handler).toBe("function");

    // 2. Déposer un texte source dans S3
    const config = getConfig();
    const s3 = getS3Client();
    const docId = `test-bundle-${Date.now()}`;
    const textContent = "Bonjour le monde ! Test d'accents éèàçù depuis le bundle esbuild.";
    const versionId = computeVersionId(textContent);

    await s3.send(
      new PutObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: `texts/${docId}/${versionId}.txt`,
        Body: Buffer.from(textContent, "utf-8"),
        ContentType: "text/plain; charset=utf-8",
      }),
    );

    // 3. Simuler l'événement SQS
    const sqsEvent = {
      Records: [
        {
          messageId: "msg-test-1",
          receiptHandle: "receipt-1",
          body: JSON.stringify({
            docId,
            versionId,
            requestedAt: new Date().toISOString(),
          }),
        },
      ],
    };

    // 4. Invoquer le handler
    const response = await workerModule.handler(sqsEvent);
    expect(response).toBeDefined();
    expect(response.batchItemFailures).toEqual([]);

    // 5. Vérifier que le PDF a bien été écrit dans S3 avec %PDF-
    const pdfObj = await s3.send(
      new GetObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: `pdfs/${docId}/${versionId}.pdf`,
      }),
    );

    const pdfBytes = await pdfObj.Body?.transformToByteArray();
    expect(pdfBytes).toBeDefined();
    const header = Buffer.from(pdfBytes!).subarray(0, 5).toString("utf-8");
    expect(header).toBe("%PDF-");
  });
});
