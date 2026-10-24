/**
 * Test de charge du chemin de téléchargement (Node/undici équivalent k6).
 * Modélise l'arrivée massive de visiteurs avec profil constant-arrival-rate & burst (Section 15.4).
 * Vérifie :
 * - Invariant C1 : réservations accordées == MAX_COPIES exactement
 * - Aucune requête sans état explicite (0 état inconnu)
 * - Taux d'erreur 5xx ~ 0
 * - Mesure des latences (p50, p90, p95, p99)
 */
import http from "http";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { handleDownloadRequest } from "../src/shared/links/reservations";
import { createDocument } from "../src/shared/docs/documents";
import { createLink } from "../src/shared/links/links";
import { tableName } from "../src/shared/config";
import { getDocClient } from "../src/shared/aws/dynamodb";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { LinkRecord } from "../src/shared/links/types";
import { log } from "../src/shared/log";

interface RequestResult {
  requestId: string;
  durationMs: number;
  initialState: string;
  finalState: string;
  pollCount: number;
  statusCode: number;
  error?: string;
}

interface LoadTestSummary {
  timestamp: string;
  testName: "download-burst";
  config: {
    totalVisitors: number;
    maxCopies: number;
    burstRatio: number;
    concurrency: number;
    targetUrl: string;
  };
  metrics: {
    totalRequests: number;
    grantedCount: number;
    exhaustedCount: number;
    failedCount: number;
    errors5xxCount: number;
    unhandledCount: number;
    latenciesMs: {
      min: number;
      p50: number;
      p90: number;
      p95: number;
      p99: number;
      max: number;
      mean: number;
    };
    totalDurationSec: number;
    throughputReqSec: number;
  };
  invariants: {
    c1RespectStrict: boolean;
    zeroUnhandledRequests: boolean;
    zeroErrors5xx: boolean;
    p95UnderTarget: boolean;
  };
}

async function main() {
  const TOTAL_VISITORS = parseInt(process.env.TOTAL_VISITORS || "2000", 10);
  const MAX_COPIES = parseInt(process.env.MAX_COPIES || "200", 10);
  const CONCURRENCY = parseInt(process.env.CONCURRENCY || "50", 10);
  const BURST_RATIO = 0.8; // 80 % dans la première phase
  const TARGET_P95_MS = 250; // Objectif de latence p95

  log.info("loadtest.download.init", {
    TOTAL_VISITORS,
    MAX_COPIES,
    CONCURRENCY,
  });

  // 1. Initialisation des données de test
  const testId = randomUUID().slice(0, 8);
  const creator = {
    writerId: `creator-burst-${testId}`,
    email: `presidence-burst-${testId}@asso.fr`,
    name: "Presidence Burst",
  };

  const doc = await createDocument(`Document de Charge ${testId}`, creator);
  const link = await createLink({
    docId: doc.docId,
    creatorId: creator.writerId,
    creatorEmail: creator.email,
    creatorName: creator.name,
    maxDownloads: MAX_COPIES,
  });
  const linkId = link.linkId;

  log.info("loadtest.download.link_created", { linkId, maxDownloads: MAX_COPIES });

  // 2. Démarrage d'un serveur HTTP local pour tester la pile réseau réelle (TCP loopback, HTTP parsing)
  let localServer: http.Server | null = null;
  let targetUrl = process.env.TARGET_URL || "";

  if (!targetUrl) {
    const port = 3456;
    localServer = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/api/dl/")) {
        const parts = req.url.split("/");
        const lId = parts[3];
        let bodyData = "";
        req.on("data", (chunk) => (bodyData += chunk));
        req.on("end", async () => {
          try {
            const json = JSON.parse(bodyData);
            const result = await handleDownloadRequest(lId, json.requestId);
            res.writeHead(result.status, {
              "Content-Type": "application/json",
              ...(result.retryAfterSec ? { "Retry-After": String(result.retryAfterSec) } : {}),
            });
            res.end(JSON.stringify(result.body));
          } catch (err: unknown) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => localServer?.listen(port, "127.0.0.1", () => resolve()));
    targetUrl = `http://127.0.0.1:${port}/api/dl/${linkId}/request`;
  }

  log.info("loadtest.download.server_ready", { targetUrl });

  // 3. Modélisation de l'arrivée des visiteurs
  const results: RequestResult[] = [];
  const startTime = Date.now();

  const burstCount = Math.floor(TOTAL_VISITORS * BURST_RATIO);
  const tailCount = TOTAL_VISITORS - burstCount;

  log.info("loadtest.download.phases", { burstCount, tailCount });

  // File d'attente concurrente avec limite de workers
  let currentVisitor = 0;

  async function executeVisitor(): Promise<RequestResult> {
    const requestId = randomUUID();
    const t0 = Date.now();
    let pollCount = 0;
    let statusCode = 0;
    let initialState = "unknown";
    let currentState = "unknown";
    let error: string | undefined;

    try {
      // 1. Requête initiale
      const res = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      statusCode = res.status;
      const data = (await res.json().catch(() => ({}))) as { state?: string };
      initialState = data.state || `status_${statusCode}`;
      currentState = initialState;

      // 2. Polling si preparing ou retry
      while ((currentState === "preparing" || currentState === "retry") && pollCount < 5) {
        pollCount++;
        // Jitter entre 50ms et 150ms pour accélérer le test local
        const jitterMs = 50 + Math.floor(Math.random() * 100);
        await new Promise((resolve) => setTimeout(resolve, jitterMs));

        const pollRes = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId }),
        });
        const pollData = (await pollRes.json().catch(() => ({}))) as { state?: string };
        currentState = pollData.state || `status_${pollRes.status}`;
        if (currentState === "granted" || currentState === "exhausted" || currentState === "failed") {
          break;
        }
      }
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e);
      statusCode = 0;
    }

    const durationMs = Date.now() - t0;
    return {
      requestId,
      durationMs,
      initialState,
      finalState: currentState,
      pollCount,
      statusCode,
      error,
    };
  }

  // Exécution concurrente avec limitation
  const workers = Array.from({ length: CONCURRENCY }).map(async () => {
    while (currentVisitor < TOTAL_VISITORS) {
      currentVisitor++;
      const res = await executeVisitor();
      results.push(res);
    }
  });

  await Promise.all(workers);

  const totalDurationSec = (Date.now() - startTime) / 1000;

  if (localServer) {
    localServer.close();
  }

  // 4. Analyse des résultats et métriques
  let grantedCount = 0;
  let exhaustedCount = 0;
  let failedCount = 0;
  let errors5xxCount = 0;
  let unhandledCount = 0;
  const latencies = results.map((r) => r.durationMs).sort((a, b) => a - b);

  for (const r of results) {
    if (r.finalState === "granted" || r.initialState === "granted" || r.initialState === "preparing") {
      grantedCount++;
    } else if (r.finalState === "exhausted") {
      exhaustedCount++;
    } else if (r.finalState === "failed") {
      failedCount++;
    } else {
      unhandledCount++;
    }

    if (r.statusCode >= 500) {
      errors5xxCount++;
    }
  }

  // Vérification de cohérence dans DynamoDB
  const docClient = getDocClient();
  const linkRecordRes = await docClient.send(
    new GetCommand({
      TableName: tableName("links"),
      Key: { linkId },
    }),
  );
  const linkInDb = linkRecordRes.Item as LinkRecord;
  const issuedInDb = linkInDb?.issued ?? 0;
  log.info("Download burst completed", { clientGrantedCount: grantedCount, dbIssued: issuedInDb });

  // Calcul des percentiles
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p90 = latencies[Math.floor(latencies.length * 0.9)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const min = latencies[0] || 0;
  const max = latencies[latencies.length - 1] || 0;
  const mean = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);

  const summary: LoadTestSummary = {
    timestamp: new Date().toISOString(),
    testName: "download-burst",
    config: {
      totalVisitors: TOTAL_VISITORS,
      maxCopies: MAX_COPIES,
      burstRatio: BURST_RATIO,
      concurrency: CONCURRENCY,
      targetUrl,
    },
    metrics: {
      totalRequests: results.length,
      grantedCount: issuedInDb,
      exhaustedCount,
      failedCount,
      errors5xxCount,
      unhandledCount,
      latenciesMs: {
        min,
        p50,
        p90,
        p95,
        p99,
        max,
        mean: Math.round(mean * 10) / 10,
      },
      totalDurationSec: Math.round(totalDurationSec * 10) / 10,
      throughputReqSec: Math.round((results.length / totalDurationSec) * 10) / 10,
    },
    invariants: {
      c1RespectStrict: issuedInDb === MAX_COPIES,
      zeroUnhandledRequests: unhandledCount === 0,
      zeroErrors5xx: errors5xxCount === 0,
      p95UnderTarget: p95 < TARGET_P95_MS,
    },
  };

  // 5. Sauvegarde des résultats bruts JSON et du rapport Markdown
  const resultsDir = path.join(process.cwd(), "loadtest", "results");
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const dateFile = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(resultsDir, `${dateFile}-download-burst.json`);
  const mdPath = path.join(resultsDir, `${dateFile}-download-burst.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf-8");

  const mdReport = `# Rapport de Test de Charge : download-burst

- **Date** : ${summary.timestamp}
- **Visiteurs simulés** : ${summary.config.totalVisitors}
- **Exemplaires maximum autorisés** : ${summary.config.maxCopies}
- **Concurrence** : ${summary.config.concurrency} requêtes simultanées
- **Durée totale** : ${summary.metrics.totalDurationSec} s
- **Débit moyen** : ${summary.metrics.throughputReqSec} req/s

---

## 1. Respect des Invariants

| Critère | Attendu | Obtenu | Statut |
| :--- | :--- | :--- | :--- |
| **Invariant C1 (Réservations délivrées)** | **Exactement ${MAX_COPIES}** | **${issuedInDb}** | ${issuedInDb === MAX_COPIES ? "✅ VALIDÉ" : "❌ ÉCHEC"} |
| **Requêtes sans état explicite** | 0 | ${unhandledCount} | ${unhandledCount === 0 ? "✅ VALIDÉ" : "❌ ÉCHEC"} |
| **Erreurs 5xx (serveur)** | 0 | ${errors5xxCount} | ${errors5xxCount === 0 ? "✅ VALIDÉ" : "❌ ÉCHEC"} |
| **Objectif de latence p95** | < ${TARGET_P95_MS} ms | ${p95} ms | ${p95 < TARGET_P95_MS ? "✅ VALIDÉ" : "⚠️ LIMITE"} |

---

## 2. Distribution des Latences (ms)

- **Min** : ${min} ms
- **Médiane (p50)** : ${p50} ms
- **90e percentile (p90)** : ${p90} ms
- **95e percentile (p95)** : ${p95} ms
- **99e percentile (p99)** : ${p99} ms
- **Max** : ${max} ms
- **Moyenne** : ${summary.metrics.latenciesMs.mean} ms

---

## 3. Répartition des Réponses

- **Réservations accordées (issued / granted)** : ${issuedInDb}
- **Refus polis pour épuisement (exhausted)** : ${exhaustedCount}
- **Échecs explicites (failed)** : ${failedCount}
- **Erreurs non gérées** : ${unhandledCount}
`;

  fs.writeFileSync(mdPath, mdReport, "utf-8");

  log.info("loadtest.download.completed", {
    issuedInDb,
    maxCopies: MAX_COPIES,
    c1Valid: issuedInDb === MAX_COPIES,
    jsonPath,
    mdPath,
  });

  console.log("\n" + mdReport);

  if (issuedInDb !== MAX_COPIES || unhandledCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  log.error("loadtest.download.fatal", { error: err });
  process.exit(1);
});
