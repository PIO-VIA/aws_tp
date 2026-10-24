import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient } from "../aws/dynamodb";
import { tableName } from "../config";
import { LinkRecord } from "../links/types";
import { sendEmail } from "../aws/mailer";
import { log } from "../log";

/**
 * Traite le changement d'état d'un lien (appelé inline en local, ou par Lambda Streams sur AWS).
 * Règle F11, D07 : Notifie par e-mail le créateur au dernier exemplaire.
 * Événement logique UNIQUE garanti par attribute_not_exists(linkId) sur la table notifications.
 */
export async function handleLinkChange(
  oldLink: Pick<LinkRecord, "linkId" | "issued" | "maxDownloads"> | null | undefined,
  newLink: LinkRecord,
  docTitle = "Document",
): Promise<{ notified: boolean; error?: string }> {
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

  // 2. Envoi de l'e-mail au créateur (en français, sans données de visiteurs)
  const subject = `[Journal] Dernier exemplaire téléchargé pour « ${docTitle} »`;
  const text = [
    `Bonjour ${newLink.creatorName || "Rédacteur"},`,
    ``,
    `La limite de téléchargements autorisée pour votre document « ${docTitle} » a été atteinte.`,
    `- Nombre d'exemplaires autorisés : ${newLink.maxDownloads}`,
    `- Exemplaires distribués : ${newLink.issued}`,
    `- Identifiant du lien : ${newLink.linkId}`,
    `- Heure (UTC) : ${new Date().toISOString()}`,
    ``,
    `Le lien est désormais fermé aux nouvelles demandes de téléchargement.`,
    ``,
    `Cordialement,`,
    `L'équipe de l'association.`,
  ].join("\n");

  try {
    await sendEmail({
      to: newLink.creatorEmail,
      subject,
      text,
    });

    await docClient.send(
      new UpdateCommand({
        TableName: notifTable,
        Key: { linkId: newLink.linkId },
        UpdateExpression: "SET #status = :sent, sentAt = :sentAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":sent": "sent", ":sentAt": Math.floor(Date.now() / 1000) },
      }),
    );

    log.info("notify.last_copy.email_sent", { linkId: newLink.linkId, to: newLink.creatorEmail });
    return { notified: true };
  } catch (emailErr: unknown) {
    const errMsg = emailErr instanceof Error ? emailErr.message : String(emailErr);
    log.warn("notify.last_copy.email_failed", { linkId: newLink.linkId, error: errMsg });

    try {
      await docClient.send(
        new UpdateCommand({
          TableName: notifTable,
          Key: { linkId: newLink.linkId },
          UpdateExpression: "SET attempts = attempts + :one, lastError = :err",
          ExpressionAttributeValues: { ":one": 1, ":err": errMsg },
        }),
      );
    } catch {
      // Ignorer l'erreur secondaire
    }

    return { notified: false, error: errMsg };
  }
}
