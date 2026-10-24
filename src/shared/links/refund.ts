import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient } from "../aws/dynamodb";
import { tableName } from "../config";
import { log, metric } from "../log";

/**
 * Remboursement strict (D-05, 10.5) :
 * Transaction atomique :
 * 1. reservation passe de reserved -> cancelled (CONDITION: status = 'reserved')
 * 2. links.issued décrémenté de 1 (CONDITION: issued > 0)
 *
 * Interdit ABSOLU si status === 'url_issued'.
 */
export async function refundReservation(
  linkId: string,
  reservationId: string,
): Promise<{ refunded: boolean; reason?: string }> {
  const docClient = getDocClient();
  const resTable = tableName("reservations");
  const linksTable = tableName("links");

  try {
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: resTable,
              Key: { linkId, reservationId },
              UpdateExpression: "SET #status = :cancelled, cancelledAt = :now",
              ConditionExpression: "#status = :reserved",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":cancelled": "cancelled",
                ":reserved": "reserved",
                ":now": Math.floor(Date.now() / 1000),
              },
            },
          },
          {
            Update: {
              TableName: linksTable,
              Key: { linkId },
              UpdateExpression: "SET issued = issued - :one",
              ConditionExpression: "issued > :zero",
              ExpressionAttributeValues: {
                ":one": 1,
                ":zero": 0,
              },
            },
          },
        ],
      }),
    );

    metric("ReservationsRefunded", 1);
    log.info("reservation.refunded", { linkId, reservationId });
    return { refunded: true };
  } catch (err: unknown) {
    const error = err as {
      name?: string;
      CancellationReasons?: Array<{ Code?: string }>;
    };

    if (error.name === "TransactionCanceledException") {
      log.warn("reservation.refund_declined", {
        linkId,
        reservationId,
        reasons: error.CancellationReasons,
      });
      return { refunded: false, reason: "Condition non satisfaite (déjà émis ou déjà remboursé)" };
    }

    log.error("reservation.refund_error", { linkId, reservationId, error: err });
    throw err;
  }
}
