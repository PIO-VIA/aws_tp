/**
 * Lambda Handler: pdf-worker (Section 10.4).
 * Déclenché par SQS (taille de lot 1 ou rapport partiel ReportBatchItemFailures).
 */
import { processPdfJob } from "../src/shared/pdf/worker";
import { log } from "../src/shared/log";

interface SQSRecord {
  messageId: string;
  body: string;
}

interface SQSEvent {
  Records: SQSRecord[];
}

export async function handler(event: SQSEvent) {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    try {
      const payload = JSON.parse(record.body);
      await processPdfJob(payload);
    } catch (err) {
      log.error("lambda.pdf_worker.record_failed", {
        messageId: record.messageId,
        error: err,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
