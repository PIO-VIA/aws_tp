/**
 * Validation de répétabilité pour Phase 1 :
 * Exécute 20 fois d'affilée le scénario de concurrence critique (100 vs 1 copie restante)
 * pour prouver formellement l'absence de race condition ou de dépassement (C1, I01).
 */
import { randomUUID } from "crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient } from "../src/shared/aws/dynamodb";
import { tableName } from "../src/shared/config";
import { createLink, getLink, resetExhaustedCache } from "../src/shared/links/links";
import { handleDownloadRequest } from "../src/shared/links/reservations";

async function runOnce(iteration: number): Promise<{ success: boolean; granted: number; exhausted: number }> {
  resetExhaustedCache();
  const docId = `doc-repeat-${iteration}-${randomUUID().substring(0, 8)}`;
  const link = await createLink({
    docId,
    creatorId: "creator-repeat",
    creatorEmail: "repeat@example.org",
    creatorName: "Repeat Tester",
    maxDownloads: 50,
  });

  const docClient = getDocClient();
  await docClient.send(
    new PutCommand({
      TableName: tableName("links"),
      Item: {
        ...link,
        issued: 49,
      },
    }),
  );

  const requestIds = Array.from({ length: 100 }, () => randomUUID());
  const responses = await Promise.all(
    requestIds.map((reqId) => handleDownloadRequest(link.linkId, reqId)),
  );

  let granted = 0;
  let exhausted = 0;

  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    if (r.body.state === "granted" || r.body.state === "preparing") {
      granted++;
    } else if (r.body.state === "exhausted") {
      exhausted++;
    } else if (r.body.state === "retry") {
      // Retry automatique
      const followUp = await handleDownloadRequest(link.linkId, requestIds[i]);
      if (followUp.body.state === "granted" || followUp.body.state === "preparing") granted++;
      else if (followUp.body.state === "exhausted") exhausted++;
    }
  }

  const finalLink = await getLink(link.linkId);
  const ok = granted === 1 && exhausted === 99 && finalLink?.issued === 50;
  return { success: ok, granted, exhausted };
}

async function main() {
  console.log("=== Lancement du test de répétabilité SC02 (20 itérations de 100 requêtes concurrentes) ===");
  const t0 = Date.now();
  let allOk = true;

  for (let i = 1; i <= 20; i++) {
    const res = await runOnce(i);
    const mark = res.success ? "✓" : "✗ ÉCHEC";
    console.log(`[Itération ${i.toString().padStart(2, " ")}/20] ${mark} (granted: ${res.granted}, exhausted: ${res.exhausted})`);
    if (!res.success) allOk = false;
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`=== Résultat : ${allOk ? "SUCCÈS TOTAL (20/20)" : "ÉCHEC DÉTECTÉ"} en ${totalSec}s ===`);
  if (!allOk) process.exit(1);
}

main().catch((err) => {
  console.error("Erreur test répétabilité :", err);
  process.exit(1);
});
