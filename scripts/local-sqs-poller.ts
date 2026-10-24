/**
 * Poller SQS local (Section 14.3).
 * - Dépile les messages de la file principale `pdf-jobs`.
 * - Appelle le handler `processPdfJob`.
 * - Gère le retry et le déplacement vers la DLQ si `receiveCount >= 3`.
 * - Dépile la DLQ `pdf-jobs-dlq` et appelle `processPdfDlqMessage` pour remboursement automatique.
 */
import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { getSQSClient } from "../src/shared/aws/sqs";
import { getConfig } from "../src/shared/config";
import { processPdfJob } from "../src/shared/pdf/worker";
import { processPdfDlqMessage } from "../src/shared/pdf/dlq";
import { log } from "../src/shared/log";

let running = true;

async function pollQueue(): Promise<void> {
  const config = getConfig();
  const sqs = getSQSClient();

  const queueUrl = config.PDF_QUEUE_URL;
  const dlqUrl = config.PDF_DLQ_URL;

  while (running) {
    try {
      // 1. Dépilement de la file principale pdf-jobs
      const res = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 2,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );

      if (res.Messages && res.Messages.length > 0) {
        for (const msg of res.Messages) {
          if (!msg.Body || !msg.ReceiptHandle) continue;

          let body: { docId: string; versionId: string };
          try {
            body = JSON.parse(msg.Body);
          } catch {
            // Corps corrompu, suppression
            await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: msg.ReceiptHandle }));
            continue;
          }

          const receiveCount = parseInt(msg.Attributes?.ApproximateReceiveCount || "1", 10);

          if (receiveCount > 3) {
            // Déplacement vers la DLQ
            log.warn("sqs_poller.redrive_to_dlq", { docId: body.docId, versionId: body.versionId, receiveCount });
            if (dlqUrl) {
              await sqs.send(
                new SendMessageCommand({
                  QueueUrl: dlqUrl,
                  MessageBody: JSON.stringify({ ...body, error: "Trop de tentatives (redrive)" }),
                }),
              );
            }
            await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: msg.ReceiptHandle }));

            // Traitement DLQ immédiat pour remboursement
            await processPdfDlqMessage({ docId: body.docId, versionId: body.versionId, error: "Trop de tentatives" });
            continue;
          }

          try {
            await processPdfJob(body);
            // Succès : suppression du message de la file
            await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: msg.ReceiptHandle }));
          } catch (err) {
            log.warn("sqs_poller.job_failed_will_retry", {
              docId: body.docId,
              versionId: body.versionId,
              receiveCount,
              error: err,
            });
            // Le message n'est pas acquitté, ElasticMQ le rendra à nouveau visible
          }
        }
      }

      // 2. Dépilement de la DLQ si configurée
      if (dlqUrl) {
        const dlqRes = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: dlqUrl,
            MaxNumberOfMessages: 5,
            WaitTimeSeconds: 1,
          }),
        );

        if (dlqRes.Messages && dlqRes.Messages.length > 0) {
          for (const msg of dlqRes.Messages) {
            if (!msg.Body || !msg.ReceiptHandle) continue;
            try {
              const body = JSON.parse(msg.Body);
              await processPdfDlqMessage(body);
            } catch {
              // Ignorer
            }
            await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: msg.ReceiptHandle }));
          }
        }
      }
    } catch (err: unknown) {
      if (running) {
        log.debug("sqs_poller.poll_error", { error: err });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

log.info("sqs_poller.started", { mode: "local" });
pollQueue().catch((err) => {
  log.error("sqs_poller.fatal", { error: err });
  process.exit(1);
});

const stop = () => {
  running = false;
  log.info("sqs_poller.stopped");
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
