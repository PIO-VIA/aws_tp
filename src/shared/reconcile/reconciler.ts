import { UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient, scanAll } from "../aws/dynamodb";
import { tableName, getConfig } from "../config";
import { sendPdfJob } from "../aws/sqs";
import { refundReservation } from "../links/refund";
import { sendLastCopyNotification } from "../notify/notifier";
import { NotificationRecord, PdfJobRecord, ReservationRecord } from "../links/types";
import { log } from "../log";

export interface ReconcileStats {
  notificationsPending: number;
  notificationsSent: number;
  notificationsFailed: number;
  jobsChecked: number;
  jobsRepublished: number;
  jobsMarkedFailed: number;
  reservationsChecked: number;
  reservationsRefunded: number;
}

/**
 * 1. Réconciliation des notifications en attente (F11, Section 12).
 * Tente de renvoyer le mail pour les liens saturés si attempts < 5.
 * Délègue à sendLastCopyNotification avec réservation atomique (C-06).
 */
export async function reconcileNotifications(): Promise<{ sent: number; failed: number; pending: number }> {
  const notifTable = tableName("notifications");

  let sent = 0;
  let failed = 0;
  let pending = 0;

  try {
    const items = await scanAll<NotificationRecord>({
      TableName: notifTable,
      FilterExpression: "#st = :pending AND attempts < :maxAttempts",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: { ":pending": "pending", ":maxAttempts": 5 },
    });

    pending = items.length;

    for (const notif of items) {
      const res = await sendLastCopyNotification(notif.linkId);
      if (res.sent) {
        sent++;
      } else if (res.reason === "already_claimed_or_sent") {
        // Concurremment traité par un autre worker
      } else {
        failed++;
      }
    }
  } catch (err: unknown) {
    log.error("reconcile.notifications.scan_failed", { error: err });
  }

  return { sent, failed, pending };
}

/**
 * 2. Réconciliation des jobs de rendu PDF (C3, Section 12).
 * Relance les jobs pending/running inactifs depuis plus de 2 minutes (max 3 tentatives).
 * Utilise scanAll paginé (C-06).
 */
export async function reconcilePdfJobs(): Promise<{ checked: number; republished: number; markedFailed: number }> {
  const docClient = getDocClient();
  const pdfJobsTable = tableName("pdf_jobs");
  const now = Math.floor(Date.now() / 1000);
  const STALE_TIMEOUT_SEC = 120; // 2 minutes

  let checked = 0;
  let republished = 0;
  let markedFailed = 0;

  try {
    const jobs = await scanAll<PdfJobRecord>({
      TableName: pdfJobsTable,
      FilterExpression: "#st IN (:p, :r)",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: { ":p": "pending", ":r": "running" },
    });

    checked = jobs.length;

    for (const job of jobs) {
      if (now - (job.updatedAt || job.createdAt) < STALE_TIMEOUT_SEC) {
        continue;
      }

      if ((job.attempts || 0) >= 3) {
        // Abandon après 3 tentatives
        await docClient.send(
          new UpdateCommand({
            TableName: pdfJobsTable,
            Key: { jobId: job.jobId },
            UpdateExpression: "SET #st = :failed, #err = :err, updatedAt = :now",
            ExpressionAttributeNames: { "#st": "status", "#err": "error" },
            ExpressionAttributeValues: {
              ":failed": "failed",
              ":err": "Reconciler: délai dépassé (3 tentatives échouées)",
              ":now": now,
            },
          }),
        );
        log.warn("reconcile.pdf_job.marked_failed", { jobId: job.jobId, attempts: job.attempts });
        markedFailed++;
      } else {
        // Republier vers SQS
        const nextAttempts = (job.attempts || 0) + 1;
        await docClient.send(
          new UpdateCommand({
            TableName: pdfJobsTable,
            Key: { jobId: job.jobId },
            UpdateExpression: "SET attempts = :att, updatedAt = :now, #st = :p",
            ExpressionAttributeNames: { "#st": "status" },
            ExpressionAttributeValues: { ":att": nextAttempts, ":now": now, ":p": "pending" },
          }),
        );

        await sendPdfJob({ docId: job.docId, versionId: job.versionId });
        log.info("reconcile.pdf_job.republished", { jobId: job.jobId, attempt: nextAttempts });
        republished++;
      }
    }
  } catch (err: unknown) {
    log.error("reconcile.pdf_jobs.scan_failed", { error: err });
  }

  return { checked, republished, markedFailed };
}

/**
 * 3. Réconciliation des réservations orphelines (C1, Section 12).
 * Libère les réservations restées en statut 'reserved' depuis plus de RESERVATION_MAX_AGE_SEC
 * sans job actif. Ne rembourse JAMAIS si url_issued !
 * Utilise scanAll paginé (C-06).
 */
export async function reconcileReservations(): Promise<{ checked: number; refunded: number }> {
  const docClient = getDocClient();
  const resTable = tableName("reservations");
  const pdfJobsTable = tableName("pdf_jobs");
  const config = getConfig();
  const maxAgeSec = config.RESERVATION_MAX_AGE_SEC;
  const now = Math.floor(Date.now() / 1000);

  let checked = 0;
  let refunded = 0;

  try {
    const items = await scanAll<ReservationRecord>({
      TableName: resTable,
      FilterExpression: "#st = :reserved",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: { ":reserved": "reserved" },
    });

    checked = items.length;

    for (const res of items) {
      if (now - res.createdAt < maxAgeSec) {
        continue;
      }

      // Vérifier si un job est actif pour ce docId/versionId
      let shouldRefund = true;
      if (res.docId && res.versionId) {
        const jobId = `${res.docId}#${res.versionId}`;
        const jobRes = await docClient.send(
          new GetCommand({
            TableName: pdfJobsTable,
            Key: { jobId },
          }),
        );
        const job = jobRes.Item as PdfJobRecord | undefined;
        if (job && (job.status === "pending" || job.status === "running")) {
          // Un job est toujours en cours et récent
          if (now - job.updatedAt < 120) {
            shouldRefund = false;
          }
        }
      }

      if (shouldRefund) {
        const refundRes = await refundReservation(res.linkId, res.reservationId);
        if (refundRes.refunded) {
          log.info("reconcile.reservation.refunded_stale", {
            linkId: res.linkId,
            reservationId: res.reservationId,
            ageSec: now - res.createdAt,
          });
          refunded++;
        }
      }
    }
  } catch (err: unknown) {
    log.error("reconcile.reservations.scan_failed", { error: err });
  }

  return { checked, refunded };
}

/**
 * Exécute un cycle complet de réconciliation.
 */
export async function runReconciliation(): Promise<ReconcileStats> {
  log.info("reconciler.cycle.started");
  const [notifStats, jobStats, resStats] = await Promise.all([
    reconcileNotifications(),
    reconcilePdfJobs(),
    reconcileReservations(),
  ]);

  const stats: ReconcileStats = {
    notificationsPending: notifStats.pending,
    notificationsSent: notifStats.sent,
    notificationsFailed: notifStats.failed,
    jobsChecked: jobStats.checked,
    jobsRepublished: jobStats.republished,
    jobsMarkedFailed: jobStats.markedFailed,
    reservationsChecked: resStats.checked,
    reservationsRefunded: resStats.refunded,
  };

  log.info("reconciler.cycle.completed", { ...stats });
  return stats;
}
