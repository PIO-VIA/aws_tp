import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "crypto";
import { DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import * as Y from "yjs";
import { initDynamoDBTables, initS3Bucket, initSQSQueues } from "../../scripts/local-init";
import { resetConfig, ALL_TABLES, tableName } from "@shared/config";
import { getDynamoDBClient, resetDynamoClients, getDocClient } from "@shared/aws/dynamodb";
import { resetS3Clients, headObject, putObjectIfNotExist, getObjectBuffer } from "@shared/aws/s3";
import { upsertWriter } from "@shared/auth/session";
import { createDocument } from "@shared/docs/documents";
import { getHead, resetHeadCache } from "@shared/docs/head";
import { renderPdfBuffer, computeVersionId } from "@shared/pdf/render";
import { createPdfJobIfNotExists, getPdfJob } from "@shared/pdf/jobs";
import { processPdfJob } from "@shared/pdf/worker";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

describe("SC03 — PDF versionné, rendu déterministe et single-flight (C3, I01, I05)", () => {
  const testPrefix = `test-sc03-${randomBytes(4).toString("hex")}-`;

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
    process.env.HEAD_COALESCE_MS = "0"; // Désactivation du cache de coalescence pour les tests de versions

    resetConfig();
    resetDynamoClients();
    resetS3Clients();

    await initDynamoDBTables(testPrefix);
    await initS3Bucket();
    await initSQSQueues();

    const w = await upsertWriter("Alice Sc03", "alice-sc03@asso.fr");
    writerAlice = { writerId: w.writerId, name: w.name, email: w.email };

    const created = await createDocument("Journal Étudiant SC03", writerAlice);
    docId = created.docId;
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

  it("1. Rendu PDF avec accents (DejaVu Sans) et extraction fidèle du texte (C3)", async () => {
    const originalText = "Édition spéciale : Événement étudiant à l'université & café littéraire !";
    const versionId = computeVersionId(originalText);

    const pdfBuffer = await renderPdfBuffer("Titre Journal", originalText, versionId);
    expect(pdfBuffer).toBeDefined();
    expect(pdfBuffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    // Extraction du texte avec pdfjs-dist pour valider le rendu des accents
    const uint8 = new Uint8Array(pdfBuffer);
    const loadingTask = pdfjsLib.getDocument({ data: uint8 });
    const pdfDoc = await loadingTask.promise;
    expect(pdfDoc.numPages).toBeGreaterThanOrEqual(1);

    const page = await pdfDoc.getPage(1);
    const textContent = await page.getTextContent();
    const extractedStrings = textContent.items
      .map((it) => ("str" in it ? String((it as { str: string }).str) : ""))
      .join(" ");

    // Vérification que les mots avec accents sont bien présents
    expect(extractedStrings).toContain("Édition");
    expect(extractedStrings).toContain("spéciale");
    expect(extractedStrings).toContain("étudiant");
    expect(extractedStrings).toContain("université");
  });

  it("2. Deux demandes simultanées de la même version lancent UNE SEULE génération (single-flight)", async () => {
    const testVersionId = randomUUID().replace(/-/g, "");

    const [job1, job2] = await Promise.all([
      createPdfJobIfNotExists(docId, testVersionId),
      createPdfJobIfNotExists(docId, testVersionId),
    ]);

    // Exactement un seul appelant a le droit de publier dans SQS
    const createdCount = (job1.created ? 1 : 0) + (job2.created ? 1 : 0);
    expect(createdCount).toBe(1);

    const persisted = await getPdfJob(docId, testVersionId);
    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe("pending");
  });

  it("3. Un échec de génération ne publie aucun fichier dans S3 (I05)", async () => {
    const nonExistentVersion = "version-that-does-not-exist";
    const pdfKey = `pdfs/${docId}/${nonExistentVersion}.pdf`;

    // Le worker doit échouer car le fichier texte immuable n'existe pas
    await expect(
      processPdfJob({ docId, versionId: nonExistentVersion }),
    ).rejects.toThrow();

    // S3 ne doit contenir aucun PDF partiel ou corrompu
    const head = await headObject(pdfKey);
    expect(head).toBe(false);
  });

  it("4. Le document change pendant la génération : chaque PDF correspond à sa version immuable sans écrasement (C3)", async () => {
    resetHeadCache();

    // 1. Version 1 : texte initial
    const textV1 = "Version 1 : Le début du projet.";
    const versionIdV1 = computeVersionId(textV1);
    await putObjectIfNotExist(`texts/${docId}/${versionIdV1}.txt`, textV1, "text/plain; charset=utf-8");

    // Création de l'update dans doc_updates pour V1
    const ydoc1 = new Y.Doc();
    ydoc1.getText("content").insert(0, textV1);
    const u1 = Y.encodeStateAsUpdate(ydoc1);
    const now = Math.floor(Date.now() / 1000);

    const docClient = getDocClient();
    await docClient.send(
      new PutCommand({
        TableName: tableName("doc_updates"),
        Item: {
          docId,
          seq: 1,
          update: Buffer.from(u1),
          writerId: writerAlice.writerId,
          billedChars: textV1.length,
          createdAt: now,
          ttl: now + 3600,
        },
      }),
    );

    // Head V1 calculé
    const head1 = await getHead(docId);
    expect(head1.versionId).toBe(versionIdV1);

    // 2. Modification du document en Version 2 pendant que le worker V1 n'a pas encore tourné
    const textV2 = "Version 2 : Une modification majeure en direct !";
    const versionIdV2 = computeVersionId(textV2);
    await putObjectIfNotExist(`texts/${docId}/${versionIdV2}.txt`, textV2, "text/plain; charset=utf-8");

    const incrementalUpdates: Uint8Array[] = [];
    ydoc1.on("update", (update: Uint8Array) => {
      incrementalUpdates.push(update);
    });
    ydoc1.transact(() => {
      ydoc1.getText("content").delete(0, textV1.length);
      ydoc1.getText("content").insert(0, textV2);
    });
    const u2 = Y.mergeUpdates(incrementalUpdates);

    await docClient.send(
      new PutCommand({
        TableName: tableName("doc_updates"),
        Item: {
          docId,
          seq: 2,
          update: Buffer.from(u2),
          writerId: writerAlice.writerId,
          billedChars: textV2.length,
          createdAt: now + 1,
          ttl: now + 3600,
        },
      }),
    );

    // Head V2 calculé pour une nouvelle demande
    const head2 = await getHead(docId);
    expect(head2.versionId).toBe(versionIdV2);
    expect(head2.versionId).not.toBe(head1.versionId);

    // 3. Exécution du worker pour V1
    await createPdfJobIfNotExists(docId, versionIdV1);
    await processPdfJob({ docId, versionId: versionIdV1 });

    // 4. Exécution du worker pour V2
    await createPdfJobIfNotExists(docId, versionIdV2);
    await processPdfJob({ docId, versionId: versionIdV2 });

    // 5. Vérification que les deux PDF existent indépendamment dans S3
    const pdfBufV1 = await getObjectBuffer(`pdfs/${docId}/${versionIdV1}.pdf`);
    const pdfBufV2 = await getObjectBuffer(`pdfs/${docId}/${versionIdV2}.pdf`);

    expect(pdfBufV1).not.toBeNull();
    expect(pdfBufV2).not.toBeNull();

    // 6. Extraction et comparaison du texte de chaque PDF
    const docPdf1 = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBufV1!) }).promise;
    const page1 = await docPdf1.getPage(1);
    const content1 = await page1.getTextContent();
    const textItems1 = content1.items
      .map((i) => ("str" in i ? String((i as { str: string }).str) : ""))
      .join(" ");
    expect(textItems1).toContain("Version 1");
    expect(textItems1).not.toContain("Version 2");

    const docPdf2 = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBufV2!) }).promise;
    const page2 = await docPdf2.getPage(1);
    const content2 = await page2.getTextContent();
    const textItems2 = content2.items
      .map((i) => ("str" in i ? String((i as { str: string }).str) : ""))
      .join(" ");
    expect(textItems2).toContain("Version 2");
  });
});
