import { unmarshall } from "@aws-sdk/util-dynamodb";
import { handleLinkChange } from "../src/shared/notify/notifier";
import { LinkRecord } from "../src/shared/links/types";
import { getDocumentById } from "../src/shared/docs/documents";
import { log } from "../src/shared/log";

export interface DynamoDBStreamRecord {
  eventName?: string;
  dynamodb?: {
    OldImage?: Record<string, unknown>;
    NewImage?: Record<string, unknown>;
  };
}

export interface DynamoDBStreamEvent {
  Records: DynamoDBStreamRecord[];
}

/**
 * Handler Lambda pour les flux DynamoDB Streams sur la table links (F11, D07).
 * Se déclenche lorsque NewImage.issued == maxDownloads et OldImage.issued < maxDownloads.
 */
export async function handler(event: DynamoDBStreamEvent): Promise<{ processed: number }> {
  log.info("lambda.notifier.invoked", { recordCount: event.Records?.length ?? 0 });
  let processed = 0;

  for (const record of event.Records || []) {
    if (record.eventName !== "MODIFY" || !record.dynamodb?.NewImage || !record.dynamodb?.OldImage) {
      continue;
    }

    try {
      const oldLink = unmarshall(record.dynamodb.OldImage as Record<string, import("@aws-sdk/client-dynamodb").AttributeValue>) as LinkRecord;
      const newLink = unmarshall(record.dynamodb.NewImage as Record<string, import("@aws-sdk/client-dynamodb").AttributeValue>) as LinkRecord;

      let docTitle = "Document";
      try {
        const doc = await getDocumentById(newLink.docId);
        if (doc?.title) docTitle = doc.title;
      } catch {
        // Fallback sur le titre par défaut si lookup échoue
      }

      const res = await handleLinkChange(oldLink, newLink, docTitle);
      if (res.notified) {
        processed++;
      }
    } catch (err: unknown) {
      log.error("lambda.notifier.record_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { processed };
}
