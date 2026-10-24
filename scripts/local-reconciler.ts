import { runReconciliation } from "../src/shared/reconcile/reconciler";
import { log } from "../src/shared/log";

/**
 * Script de réconciliation locale exécuté en continu par npm run dev.
 * Déclenche runReconciliation toutes les 60 secondes.
 */
let running = true;
const INTERVAL_MS = 60_000;

async function loop() {
  log.info("local_reconciler.started", { intervalMs: INTERVAL_MS });

  while (running) {
    try {
      await runReconciliation();
    } catch (err: unknown) {
      log.error("local_reconciler.cycle_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Attente avec interruption rapide
    const start = Date.now();
    while (running && Date.now() - start < INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  log.info("local_reconciler.stopped");
}

function stop() {
  running = false;
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

loop().catch((err) => {
  log.error("local_reconciler.fatal", { error: err });
  process.exit(1);
});
