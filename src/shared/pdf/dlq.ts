/**
 * pdf-dlq-handler : traitement des échecs définitifs de génération PDF (Section 10.5, D-05).
 * - Passe pdf_jobs à "failed".
 * - Rembourse atomiquement chaque réservation encore "reserved" associée à cette version.
 * - Ne rembourse JAMAIS les réservations passées à "url_issued".
 */
import { scanAll } from "../aws/dynamodb";
import { tableName } from "../config";
import { transitionPdfJob } from "./jobs";
import { refundReservation } from "../links/refund";
import { log, metric } from "../log";
import { ReservationRecord } from "../links/types";

export interface PdfDlqEvent {
  docId: string;
  versionId: string;
  error?: string;
}

export async function processPdfDlqMessage(
  event: PdfDlqEvent,
): Promise<{ refundedCount: number }> {
  const { docId, versionId, error } = event;

  log.warn("pdf_dlq.processing", { docId, versionId, error });
  metric("PdfJobsFailed", 1);

  // 1. Passage du job à l'état failed
  await transitionPdfJob(docId, versionId, "pending", "failed", error);
  await transitionPdfJob(docId, versionId, "running", "failed", error);

  // 2. Recherche des réservations "reserved" associées à cette version (scan paginé C-06)
  const resTable = tableName("reservations");

  const items = await scanAll<ReservationRecord>({
    TableName: resTable,
    FilterExpression: "docId = :docId AND versionId = :vId AND #status = :reserved",
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":docId": docId,
      ":vId": versionId,
      ":reserved": "reserved",
    },
  });

  let refundedCount = 0;

  // 3. Remboursement atomique pour chaque réservation éligible
  for (const item of items) {
    const res = await refundReservation(item.linkId, item.reservationId);
    if (res.refunded) {
      refundedCount++;
    }
  }

  log.info("pdf_dlq.refunds_completed", {
    docId,
    versionId,
    eligibleReservations: items.length,
    refundedCount,
  });

  return { refundedCount };
}
