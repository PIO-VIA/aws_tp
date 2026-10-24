/**
 * Lambda Handler: pdf-dlq-handler (Section 10.5).
 * Déclenché par la DLQ SQS.
 */
import { processPdfDlqMessage } from "../src/shared/pdf/dlq";
import { log } from "../src/shared/log";

interface SQSRecord {
  messageId: string;
  body: string;
}

interface SQSEvent {
  Records: SQSRecord[];
}

export async function handler(event: SQSEvent) {
  for (const record of event.Records) {
    try {
      const payload = JSON.parse(record.body);
      await processPdfDlqMessage(payload);
    } catch (err) {
      log.error("lambda.pdf_dlq_handler.record_failed", {
        messageId: record.messageId,
        error: err,
      });
      // Laisser remonter l'erreur pour la DLQ
      throw err;
    }
  }

  return { ok: true };
}
