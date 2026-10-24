/**
 * pdf-worker : génération déterministe et autonome des PDF (Section 10.4).
 * Lit le texte immuable depuis S3 texts/<docId>/<versionId>.txt (jamais le doc vivant).
 * Publie dans S3 pdfs/<docId>/<versionId>.pdf avec If-None-Match: *
 */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient } from "../aws/dynamodb";
import { tableName } from "../config";
import { getObjectBuffer, putObjectIfNotExist, headObject } from "../aws/s3";
import { transitionPdfJob, getPdfJob } from "./jobs";
import { renderPdfBuffer } from "./render";
import { log } from "../log";

export interface PdfWorkerEvent {
  docId: string;
  versionId: string;
}

export async function processPdfJob(event: PdfWorkerEvent): Promise<{ success: boolean; reason?: string }> {
  const { docId, versionId } = event;
  const pdfKey = `pdfs/${docId}/${versionId}.pdf`;
  const textKey = `texts/${docId}/${versionId}.txt`;

  // 1. Si le PDF existe déjà dans S3, marquer le job comme fait (idempotence)
  const existingPdf = await headObject(pdfKey);
  if (existingPdf) {
    await transitionPdfJob(docId, versionId, "pending", "done");
    await transitionPdfJob(docId, versionId, "running", "done");
    log.info("pdf_worker.already_rendered", { docId, versionId });
    return { success: true, reason: "already_rendered" };
  }

  // 2. Transition de statut pending -> running (conditionnel)
  const transitioned = await transitionPdfJob(docId, versionId, "pending", "running");
  if (!transitioned) {
    const job = await getPdfJob(docId, versionId);
    if (job?.status === "done") {
      return { success: true, reason: "already_done" };
    }
    // Si un autre worker est en cours (running), on laisse l'autre finir
    if (job?.status === "running") {
      log.debug("pdf_worker.already_running", { docId, versionId });
      return { success: true, reason: "already_running" };
    }
  }

  try {
    // 3. Récupération du titre du document depuis DynamoDB
    const docClient = getDocClient();
    const docRes = await docClient.send(
      new GetCommand({
        TableName: tableName("documents"),
        Key: { docId },
      }),
    );
    const title = (docRes.Item?.title as string) || "Document";

    // 4. Lecture du texte immuable depuis S3
    const textBuffer = await getObjectBuffer(textKey);
    if (textBuffer === null) {
      throw new Error(`Fichier texte immuable introuvable: ${textKey}`);
    }
    const textContent = textBuffer.toString("utf-8");

    // 5. Génération du PDF déterministe en mémoire avec DejaVu Sans TTF
    const pdfBuffer = await renderPdfBuffer(title, textContent, versionId);

    // 6. Écriture atomique dans S3 avec condition "n'existe pas" (If-None-Match: *)
    await putObjectIfNotExist(pdfKey, pdfBuffer, "application/pdf");

    // 7. Transition running -> done
    await transitionPdfJob(docId, versionId, "running", "done");

    log.info("pdf_worker.rendered_successfully", {
      docId,
      versionId,
      bytes: pdfBuffer.byteLength,
    });

    return { success: true };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error("pdf_worker.render_failed", { docId, versionId, error: errorMsg });

    // En cas d'échec, on marque comme failed ou on laisse SQS réindexer
    // Remarque : Si attempts < maxReceiveCount, SQS réessaiera.
    throw err;
  }
}
