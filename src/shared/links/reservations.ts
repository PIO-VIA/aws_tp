import {
  GetCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { getDocClient } from "../aws/dynamodb";
import { tableName, getConfig } from "../config";
import {
  ReservationRecord,
  DlResponseState,
  linkIdSchema,
  requestIdSchema,
} from "./types";
import {
  getLink,
  isLinkExhaustedInMemory,
  markLinkExhaustedInMemory,
} from "./links";
import { getHead } from "../docs/head";
import { headObject, getPresignedDownloadUrl } from "../aws/s3";
import { createPdfJobIfNotExists, getPdfJob } from "../pdf/jobs";
import { processPdfJob } from "../pdf/worker";
import { sendPdfJob } from "../aws/sqs";
import { handleLinkChange } from "../notify/notifier";
import { refundReservation } from "./refund";
import { log, metric } from "../log";

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "document"
  );
}

function computeRetryAfterMs(attempt = 1): number {
  // Retry-After avec jitter (+/- 20 %)
  const baseMs = Math.min(1000 * Math.pow(1.5, attempt - 1), 3000);
  const jitter = baseMs * 0.2 * (Math.random() * 2 - 1);
  return Math.round(baseMs + jitter);
}

/**
 * Endpoint POST /api/dl/:linkId/request
 * Algorithme 10.2 complet avec réservation atomique, idempotence stricte et chemin rapide.
 */
export async function handleDownloadRequest(
  rawLinkId: string,
  rawRequestId: string,
): Promise<{ status: number; body: DlResponseState; retryAfterSec?: number }> {
  // a. Valider linkId et requestId
  const linkIdParse = linkIdSchema.safeParse(rawLinkId);
  const requestIdParse = requestIdSchema.safeParse(rawRequestId);

  if (!linkIdParse.success || !requestIdParse.success) {
    return {
      status: 400,
      body: { state: "failed" },
    };
  }

  const linkId = linkIdParse.data;
  const requestId = requestIdParse.data;
  const config = getConfig();
  const docClient = getDocClient();
  const nowSec = Math.floor(Date.now() / 1000);
  const resTable = tableName("reservations");
  const linksTable = tableName("links");

  // b. Idempotence : GetItem reservations(linkId, requestId)
  const existingRes = await docClient.send(
    new GetCommand({
      TableName: resTable,
      Key: { linkId, reservationId: requestId },
      ConsistentRead: true,
    }),
  );

  if (existingRes.Item) {
    metric("DownloadRequests", 1, { state: "idempotent" });
    return mapReservationToResponse(existingRes.Item as ReservationRecord);
  }

  // c. Chemin rapide "épuisé" (sans écriture dans DynamoDB)
  if (isLinkExhaustedInMemory(linkId)) {
    metric("DownloadRequests", 1, { state: "exhausted_cache" });
    return { status: 200, body: { state: "exhausted" } };
  }

  const link = await getLink(linkId);
  if (!link || link.status !== "active") {
    return { status: 404, body: { state: "failed" } };
  }

  if (link.issued >= link.maxDownloads) {
    markLinkExhaustedInMemory(linkId);
    metric("DownloadRequests", 1, { state: "exhausted" });
    return { status: 200, body: { state: "exhausted" } };
  }

  // d. Réservation atomique : TransactWriteItems avec retry exponentiel sur TransactionConflict
  const maxRetries = 5;
  let attempt = 0;
  let reservationAcquired = false;

  while (attempt < maxRetries && !reservationAcquired) {
    attempt++;
    try {
      await docClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: linksTable,
                Key: { linkId },
                UpdateExpression: "SET issued = issued + :one",
                ConditionExpression:
                  "issued < maxDownloads AND #status = :active",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":one": 1,
                  ":active": "active",
                },
              },
            },
            {
              Put: {
                TableName: resTable,
                Item: {
                  linkId,
                  reservationId: requestId,
                  status: "reserved",
                  docId: link.docId,
                  createdAt: nowSec,
                  ttl: nowSec + 86400 * 7,
                },
                ConditionExpression: "attribute_not_exists(reservationId)",
              },
            },
          ],
        }),
      );

      reservationAcquired = true;
      metric("ReservationsAccepted", 1);
      log.info("reservation.acquired", { linkId, requestId, attempt });
    } catch (err: unknown) {
      const error = err as {
        name?: string;
        CancellationReasons?: Array<{ Code?: string }>;
      };

      if (error.name === "TransactionCanceledException") {
        const reasons = error.CancellationReasons ?? [];
        // Condition échouée sur links (index 0) => quota épuisé ou statut inactif
        if (reasons[0]?.Code === "ConditionalCheckFailed") {
          markLinkExhaustedInMemory(linkId);
          metric("DownloadRequests", 1, { state: "exhausted" });
          return { status: 200, body: { state: "exhausted" } };
        }
        // Condition échouée sur reservations (index 1) => doublon concurrent (même requestId)
        if (reasons[1]?.Code === "ConditionalCheckFailed") {
          const doubleRes = await docClient.send(
            new GetCommand({
              TableName: resTable,
              Key: { linkId, reservationId: requestId },
              ConsistentRead: true,
            }),
          );
          if (doubleRes.Item) {
            return mapReservationToResponse(doubleRes.Item as ReservationRecord);
          }
        }
        log.warn("reservation.tx_canceled", { linkId, requestId, reasons });
        return { status: 500, body: { state: "failed" } };
      }

      // Conflit de transaction ou throttling : backoff exponentiel + jitter
      if (
        error.name === "TransactionConflictException" ||
        error.name === "ProvisionedThroughputExceededException" ||
        error.name === "ThrottlingException"
      ) {
        metric("TransactionConflicts", 1);
        if (attempt >= maxRetries) {
          // Jamais de 429/503 sec (contrainte C5) : 202 retry avec Retry-After
          const retryMs = computeRetryAfterMs(attempt);
          const retrySec = Math.max(1, Math.ceil(retryMs / 1000));
          return {
            status: 202,
            body: { state: "retry", retryAfterMs: retryMs },
            retryAfterSec: retrySec,
          };
        }
        // Attente exponentielle avec jitter (< 1 s au total)
        const backoffMs = Math.floor(Math.random() * 20 * Math.pow(2, attempt));
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      log.error("reservation.unexpected_error", { linkId, requestId, error: err });
      return { status: 500, body: { state: "failed" } };
    }
  }

  // Notifier si STREAM_MODE = inline et dernier exemplaire atteint
  if (config.STREAM_MODE === "inline") {
    const updatedLink = await getLink(linkId);
    if (updatedLink) {
      handleLinkChange(
        { linkId, issued: updatedLink.issued - 1, maxDownloads: link.maxDownloads },
        updatedLink,
      ).catch((err) => {
        log.warn("notify.inline_failed", { linkId, error: err });
      });
    }
  }

  // e. Gagnant : sélection de version (getHead)
  const head = await getHead(link.docId);
  const versionId = head.versionId;
  const selectedAt = Math.floor(Date.now() / 1000);

  // Mettre à jour la réservation avec la version sélectionnée
  await docClient.send(
    new UpdateCommand({
      TableName: resTable,
      Key: { linkId, reservationId: requestId },
      UpdateExpression: "SET versionId = :v, selectedAt = :s",
      ExpressionAttributeValues: { ":v": versionId, ":s": selectedAt },
    }),
  );

  // f. Si le PDF existe dans S3
  const pdfKey = `pdfs/${link.docId}/${versionId}.pdf`;
  const pdfExists = await headObject(pdfKey);

  const docSlug = slugify(link.docId);
  const filename = `${docSlug}-${versionId.substring(0, 8)}.pdf`;

  if (pdfExists) {
    const { url, expiresAtEpochSec } = await getPresignedDownloadUrl(
      pdfKey,
      filename,
      config.PRESIGN_TTL_SEC,
    );

    // UpdateItem conditionnel pour passer à url_issued (D-04 : UNE seule URL émise par réservation)
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: resTable,
          Key: { linkId, reservationId: requestId },
          UpdateExpression:
            "SET #status = :issued, #url = :u, urlExpiresAt = :exp, issuedAt = :iat, filename = :fn",
          ConditionExpression: "#status = :reserved",
          ExpressionAttributeNames: { "#status": "status", "#url": "url" },
          ExpressionAttributeValues: {
            ":issued": "url_issued",
            ":u": url,
            ":exp": expiresAtEpochSec,
            ":iat": Math.floor(Date.now() / 1000),
            ":fn": filename,
            ":reserved": "reserved",
          },
        }),
      );

      metric("DownloadRequests", 1, { state: "granted" });
      return {
        status: 200,
        body: {
          state: "granted",
          url,
          expiresAt: expiresAtEpochSec,
          reservationId: requestId,
          filename,
        },
      };
    } catch {
      // Un poll concurrent a déjà passé la réservation à url_issued
      const reRead = await docClient.send(
        new GetCommand({
          TableName: resTable,
          Key: { linkId, reservationId: requestId },
          ConsistentRead: true,
        }),
      );
      if (reRead.Item) {
        return mapReservationToResponse(reRead.Item as ReservationRecord);
      }
    }
  }

  // g. Sinon : garantir UNE génération par version (single-flight)
  const jobResult = await createPdfJobIfNotExists(link.docId, versionId);
  if (jobResult.created) {
    // Seul le créateur du job publie le message SQS
    try {
      await sendPdfJob({ docId: link.docId, versionId });
    } catch (sqsErr) {
      log.error("sqs.publish_failed", { docId: link.docId, versionId, error: sqsErr });
      // Le reconciler republiera (Section 10.2.h)
    }
  }

  const retryMs = computeRetryAfterMs(1);
  const retrySec = Math.max(1, Math.ceil(retryMs / 1000));
  metric("DownloadRequests", 1, { state: "preparing" });
  return {
    status: 202,
    body: {
      state: "preparing",
      reservationId: requestId,
      retryAfterMs: retryMs,
    },
    retryAfterSec: retrySec,
  };
}

/**
 * Endpoint GET /api/dl/:linkId/reservations/:reservationId (polling)
 * Algorithme 10.3
 */
export async function handleGetReservation(
  rawLinkId: string,
  rawReservationId: string,
): Promise<{ status: number; body: DlResponseState; retryAfterSec?: number }> {
  const linkIdParse = linkIdSchema.safeParse(rawLinkId);
  const resIdParse = requestIdSchema.safeParse(rawReservationId);

  if (!linkIdParse.success || !resIdParse.success) {
    return { status: 400, body: { state: "failed" } };
  }

  const linkId = linkIdParse.data;
  const reservationId = resIdParse.data;
  const docClient = getDocClient();
  const resTable = tableName("reservations");
  const config = getConfig();

  const resItem = await docClient.send(
    new GetCommand({
      TableName: resTable,
      Key: { linkId, reservationId },
      ConsistentRead: true,
    }),
  );

  if (!resItem.Item) {
    return { status: 404, body: { state: "failed" } };
  }

  const res = resItem.Item as ReservationRecord;

  // status "url_issued" ou "cancelled" : traité par mapReservationToResponse (aucune réémission)
  if (res.status === "url_issued" || res.status === "cancelled") {
    return mapReservationToResponse(res);
  }

  // status "reserved"
  if (res.status === "reserved") {
    const versionId = res.versionId;
    if (!versionId) {
      const retryMs = computeRetryAfterMs(2);
      return {
        status: 202,
        body: { state: "preparing", retryAfterMs: retryMs, reservationId },
        retryAfterSec: Math.ceil(retryMs / 1000),
      };
    }

    // Vérifier si le PDF est disponible (ou rendu synchrone immédiat)
    const pdfKey = `pdfs/${res.docId}/${versionId}.pdf`;
    let pdfExists = await headObject(pdfKey);

    if (!pdfExists) {
      try {
        await processPdfJob({ docId: res.docId, versionId });
        pdfExists = await headObject(pdfKey);
      } catch (err) {
        log.warn("reservation.poll_direct_render_fallback", { docId: res.docId, versionId, error: err });
      }
    }

    if (pdfExists) {
      const docSlug = slugify(res.docId);
      const filename = `${docSlug}-${versionId.substring(0, 8)}.pdf`;
      const { url, expiresAtEpochSec } = await getPresignedDownloadUrl(
        pdfKey,
        filename,
        config.PRESIGN_TTL_SEC,
      );

      // UpdateItem conditionnel pour émettre une URL unique
      try {
        await docClient.send(
          new UpdateCommand({
            TableName: resTable,
            Key: { linkId, reservationId },
            UpdateExpression:
              "SET #status = :issued, #url = :u, urlExpiresAt = :exp, issuedAt = :iat, filename = :fn",
            ConditionExpression: "#status = :reserved",
            ExpressionAttributeNames: { "#status": "status", "#url": "url" },
            ExpressionAttributeValues: {
              ":issued": "url_issued",
              ":u": url,
              ":exp": expiresAtEpochSec,
              ":iat": Math.floor(Date.now() / 1000),
              ":fn": filename,
              ":reserved": "reserved",
            },
          }),
        );

        return {
          status: 200,
          body: {
            state: "granted",
            url,
            expiresAt: expiresAtEpochSec,
            reservationId,
            filename,
          },
        };
      } catch {
        // En cas de course, relire
        const reRead = await docClient.send(
          new GetCommand({
            TableName: resTable,
            Key: { linkId, reservationId },
            ConsistentRead: true,
          }),
        );
        if (reRead.Item) {
          return mapReservationToResponse(reRead.Item as ReservationRecord);
        }
      }
    }

    // Vérifier si le job a échoué
    const job = await getPdfJob(res.docId, versionId);
    if (job?.status === "failed") {
      // Déclencher le remboursement (Section 10.5)
      await refundReservation(linkId, reservationId);
      return { status: 200, body: { state: "failed" } };
    }

    const retryMs = computeRetryAfterMs(2);
    return {
      status: 202,
      body: { state: "preparing", retryAfterMs: retryMs, reservationId },
      retryAfterSec: Math.ceil(retryMs / 1000),
    };
  }

  return { status: 500, body: { state: "failed" } };
}

export function mapReservationToResponse(
  res: ReservationRecord,
): {
  status: number;
  body: DlResponseState;
  retryAfterSec?: number;
} {
  const nowSec = Math.floor(Date.now() / 1000);

  if (res.status === "url_issued") {
    if (res.url && res.urlExpiresAt && nowSec < res.urlExpiresAt) {
      return {
        status: 200,
        body: {
          state: "granted",
          url: res.url,
          expiresAt: res.urlExpiresAt,
          reservationId: res.reservationId,
          filename: res.filename ?? "document.pdf",
        },
      };
    }

    // Invariant C-02 / C1 : au plus UNE URL pré-signée par réservation.
    // Une fois expirée, renvoyer 200 { state: "expired" }. Aucune régénération, aucune écriture.
    return { status: 200, body: { state: "expired" } };
  }

  if (res.status === "cancelled") {
    return { status: 200, body: { state: "failed" } };
  }

  // "reserved"
  const retryMs = computeRetryAfterMs(1);
  return {
    status: 202,
    body: {
      state: "preparing",
      reservationId: res.reservationId,
      retryAfterMs: retryMs,
    },
    retryAfterSec: Math.ceil(retryMs / 1000),
  };
}
