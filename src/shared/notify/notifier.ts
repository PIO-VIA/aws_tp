import { PutCommand, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient } from "../aws/dynamodb";
import { tableName } from "../config";
import { LinkRecord } from "../links/types";
import { sendEmail } from "../aws/mailer";
import { getDocumentById } from "../docs/documents";
import { log } from "../log";

/**
 * Envoie de façon idempotente et thread-safe la notification du dernier exemplaire.
 * Effectue une réservation atomique d'envoi avant l'appel SES / Mailpit (C-06).
 */
export async function sendLastCopyNotification(
  linkId: string,
): Promise<{ sent: boolean; reason?: string; error?: string }> {
  const docClient = getDocClient();
  const notifTable = tableName("notifications");
  const linksTable = tableName("links");
  const now = Math.floor(Date.now() / 1000);
  const staleCutoff = now - 120; // 120s timeout de réservation

  // 1. Réservation atomique d'envoi
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: notifTable,
        Key: { linkId },
        UpdateExpression: "SET #st = :sending, claimedAt = :now",
        ConditionExpression: "#st = :pending AND (attribute_not_exists(claimedAt) OR claimedAt < :staleCutoff)",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":pending": "pending",
          ":sending": "sending",
          ":now": now,
          ":staleCutoff": staleCutoff,
        },
      }),
    );
  } catch (err: unknown) {
    const error = err as { name?: string };
    if (error.name === "ConditionalCheckFailedException") {
      log.info("notify.last_copy.already_claimed_or_sent", { linkId });
      return { sent: false, reason: "already_claimed_or_sent" };
    }
    log.error("notify.last_copy.claim_failed", { linkId, error: err });
    throw err;
  }

  // 2. Récupération des informations du lien
  const linkRes = await docClient.send(
    new GetCommand({
      TableName: linksTable,
      Key: { linkId },
    }),
  );
  const link = linkRes.Item as LinkRecord | undefined;
  if (!link) {
    log.warn("notify.last_copy.link_not_found", { linkId });
    // Libération du claim pour ne pas bloquer indéfiniment
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: notifTable,
          Key: { linkId },
          UpdateExpression: "SET #st = :pending, attempts = if_not_exists(attempts, :zero) + :one, lastError = :err REMOVE claimedAt",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: { ":pending": "pending", ":zero": 0, ":one": 1, ":err": "Link not found" },
        }),
      );
    } catch {
      // Ignorer
    }
    return { sent: false, reason: "link_not_found" };
  }

  // 3. Récupération du titre du document depuis la table documents (F11 / C-06 point 5)
  let docTitle = "Document";
  try {
    const doc = await getDocumentById(link.docId);
    if (doc?.title) {
      docTitle = doc.title;
    }
  } catch (docErr) {
    log.warn("notify.last_copy.doc_fetch_failed", { docId: link.docId, error: docErr });
  }

  // 4. Construction de l'e-mail
  const subject = `[Journal] Dernier exemplaire téléchargé pour « ${docTitle} »`;
  const text = [
    `Bonjour ${link.creatorName || "Rédacteur"},`,
    ``,
    `La limite de téléchargements autorisée pour votre document « ${docTitle} » a été atteinte.`,
    `- Nombre d'exemplaires autorisés : ${link.maxDownloads}`,
    `- Exemplaires distribués : ${link.issued}`,
    `- Identifiant du lien : ${link.linkId}`,
    `- Heure (UTC) : ${new Date().toISOString()}`,
    ``,
    `Le lien est désormais fermé aux nouvelles demandes de téléchargement.`,
    ``,
    `Cordialement,`,
    `L'équipe de l'association.`,
  ].join("\n");

  // 5. Envoi et mise à jour DynamoDB
  try {
    await sendEmail({
      to: link.creatorEmail,
      subject,
      text,
    });

    const sentAt = Math.floor(Date.now() / 1000);
    await docClient.send(
      new UpdateCommand({
        TableName: notifTable,
        Key: { linkId },
        UpdateExpression: "SET #st = :sent, sentAt = :sentAt REMOVE claimedAt, lastError",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: { ":sent": "sent", ":sentAt": sentAt },
      }),
    );

    log.info("notify.last_copy.email_sent", { linkId, to: link.creatorEmail });
    return { sent: true };
  } catch (emailErr: unknown) {
    const errMsg = emailErr instanceof Error ? emailErr.message : String(emailErr);
    log.warn("notify.last_copy.email_failed", { linkId, error: errMsg });

    try {
      const updateRes = await docClient.send(
        new UpdateCommand({
          TableName: notifTable,
          Key: { linkId },
          UpdateExpression: "SET #st = :pending, attempts = if_not_exists(attempts, :zero) + :one, lastError = :err REMOVE claimedAt",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: {
            ":pending": "pending",
            ":zero": 0,
            ":one": 1,
            ":err": errMsg,
          },
          ReturnValues: "ALL_NEW",
        }),
      );

      const attempts = (updateRes.Attributes?.attempts as number) ?? 1;
      if (attempts >= 5) {
        log.error("notify.last_copy.abandoned_max_attempts", {
          linkId,
          attempts,
          error: errMsg,
        });
      }
    } catch (dbErr) {
      log.error("notify.last_copy.failed_to_record_error", { linkId, error: dbErr });
    }

    return { sent: false, error: errMsg };
  }
}

/**
 * Traite le changement d'état d'un lien (appelé inline en local, ou par Lambda Streams sur AWS).
 * Règle F11, D07 : Notifie par e-mail le créateur au dernier exemplaire.
 * Enregistre l'événement de manière idempotente puis délègue à sendLastCopyNotification (C-06).
 */
export async function handleLinkChange(
  oldLink: Pick<LinkRecord, "linkId" | "issued" | "maxDownloads"> | null | undefined,
  newLink: LinkRecord,
  docTitle = "Document",
): Promise<{ notified: boolean; error?: string }> {
  void docTitle;
  // Condition de déclenchement : passage à la saturation (issued >= maxDownloads et old.issued < maxDownloads)
  const oldIssued = oldLink?.issued ?? 0;
  if (!(newLink.issued >= newLink.maxDownloads && oldIssued < newLink.maxDownloads)) {
    return { notified: false };
  }

  const docClient = getDocClient();
  const notifTable = tableName("notifications");
  const now = Math.floor(Date.now() / 1000);

  // 1. Enregistrement unique de l'événement (idempotence absolue)
  try {
    await docClient.send(
      new PutCommand({
        TableName: notifTable,
        Item: {
          linkId: newLink.linkId,
          status: "pending",
          attempts: 0,
          createdAt: now,
        },
        ConditionExpression: "attribute_not_exists(linkId)",
      }),
    );
    log.info("notify.last_copy.event_created", { linkId: newLink.linkId, issued: newLink.issued });
  } catch (err: unknown) {
    const error = err as { name?: string };
    if (error.name === "ConditionalCheckFailedException") {
      log.info("notify.last_copy.already_handled", { linkId: newLink.linkId });
      return { notified: false };
    }
    log.error("notify.last_copy.put_failed", { linkId: newLink.linkId, error: err });
    throw err;
  }

  // 2. Délégation à sendLastCopyNotification avec réservation conditionnelle
  const result = await sendLastCopyNotification(newLink.linkId);
  return { notified: result.sent, error: result.error };
}
