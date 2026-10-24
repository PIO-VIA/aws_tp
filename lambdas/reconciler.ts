import { runReconciliation, ReconcileStats } from "../src/shared/reconcile/reconciler";
import { log } from "../src/shared/log";

/**
 * Handler Lambda pour EventBridge (déclenché toutes les 5 minutes).
 * Section 12 : réconciliation des notifications, jobs PDF et réservations expirées.
 */
export async function handler(): Promise<ReconcileStats> {
  log.info("lambda.reconciler.invoked");
  try {
    const stats = await runReconciliation();
    return stats;
  } catch (err: unknown) {
    log.error("lambda.reconciler.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
