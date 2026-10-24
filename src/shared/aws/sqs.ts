import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  Message,
} from "@aws-sdk/client-sqs";
import { getConfig } from "../config";
import { log } from "../log";

let sqsClientInstance: SQSClient | null = null;

export function getSQSClient(): SQSClient {
  if (sqsClientInstance) return sqsClientInstance;
  const config = getConfig();
  sqsClientInstance = new SQSClient({
    region: config.AWS_REGION,
    endpoint: config.SQS_ENDPOINT,
    credentials:
      config.APP_ENV === "local"
        ? { accessKeyId: "local", secretAccessKey: "local" }
        : undefined,
  });
  return sqsClientInstance;
}

export function resetSQSClient(): void {
  sqsClientInstance = null;
}

export interface PdfJobMessage {
  docId: string;
  versionId: string;
}

/**
 * Publie une tâche de génération de PDF dans SQS.
 */
export async function sendPdfJob(job: PdfJobMessage): Promise<string | undefined> {
  const config = getConfig();
  const client = getSQSClient();

  const res = await client.send(
    new SendMessageCommand({
      QueueUrl: config.PDF_QUEUE_URL,
      MessageBody: JSON.stringify(job),
    }),
  );

  log.info("sqs.send_pdf_job", { docId: job.docId, versionId: job.versionId, messageId: res.MessageId });
  return res.MessageId;
}

/**
 * Réception de messages SQS (utilisé pour le poller local ou tests).
 */
export async function receivePdfJobs(
  maxMessages = 1,
  visibilityTimeout = 60,
  waitTimeSeconds = 0,
): Promise<Message[]> {
  const config = getConfig();
  const client = getSQSClient();

  const res = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: config.PDF_QUEUE_URL,
      MaxNumberOfMessages: maxMessages,
      VisibilityTimeout: visibilityTimeout,
      WaitTimeSeconds: waitTimeSeconds,
    }),
  );

  return res.Messages ?? [];
}

/**
 * Supprime un message traité de la file SQS.
 */
export async function deletePdfJob(receiptHandle: string): Promise<void> {
  const config = getConfig();
  const client = getSQSClient();

  await client.send(
    new DeleteMessageCommand({
      QueueUrl: config.PDF_QUEUE_URL,
      ReceiptHandle: receiptHandle,
    }),
  );
}

/**
 * Réception depuis la DLQ (poller local ou reconciler).
 */
export async function receiveDlqMessages(
  maxMessages = 1,
  visibilityTimeout = 30,
): Promise<Message[]> {
  const config = getConfig();
  if (!config.PDF_DLQ_URL) return [];
  const client = getSQSClient();

  const res = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: config.PDF_DLQ_URL,
      MaxNumberOfMessages: maxMessages,
      VisibilityTimeout: visibilityTimeout,
      WaitTimeSeconds: 0,
    }),
  );

  return res.Messages ?? [];
}

export async function deleteDlqMessage(receiptHandle: string): Promise<void> {
  const config = getConfig();
  if (!config.PDF_DLQ_URL) return;
  const client = getSQSClient();

  await client.send(
    new DeleteMessageCommand({
      QueueUrl: config.PDF_DLQ_URL,
      ReceiptHandle: receiptHandle,
    }),
  );
}
