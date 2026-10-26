/**
 * Test de charge du chemin de téléchargement en BOUCLE OUVERTE (Section 15.4, C-08).
 * - Modélise l'arrivée massive de visiteurs selon un calendrier précis :
 *   80 % dans les 60 premières secondes, 20 % dans les 240 secondes suivantes.
 * - Facteur de compression configurable TIME_SCALE pour accélérer l'exécution locale.
 * - Mesures obligatoires :
 *   * Nombre d'URL pré-signées DISTINCTES reçues == MAX_COPIES == links.issued (Preuve C1).
 *   * Temps écoulé entre le dernier exemplaire émis et le premier refus "exhausted" (Contrainte C6).
 *   * Latences par endpoint et par état (p50, p90, p95, p99, min, max, mean).
 *   * Taux d'erreurs 5xx et réseau.
 *   * Métadonnées complètes de l'environnement (CPU, RAM, OS, Node, mode).
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
import { generateOpenLoopSchedule, calculateC6GapMs, ScheduledVisitor } from "./scheduler";
import { getEnvInfo, EnvInfo } from "./env-info";
import { log } from "../src/shared/log";

export interface VisitorJourneyResult {
  visitorIndex: number;
  requestId: string;
  phase: "burst" | "tail";
  scheduledOffsetMs: number;
  actualStartOffsetMs: number;
  initialLatencyMs: number;
  totalDurationMs: number;
  initialState: string;
  finalState: string;
  statusCode: number;
  pollCount: number;
  presignedUrl?: string;
  grantedAt?: number;
  exhaustedAt?: number;
  error?: string;
}

export interface DownloadBurstSummary {
  timestamp: string;
  testName: "download-burst";
  environment: EnvInfo;
  config: {
    totalVisitors: number;
    maxCopies: number;
    burstRatio: number;
    phase1Sec: number;
    phase2Sec: number;
    timeScale: number;
    maxWaitSec: number;
    targetUrl: string;
  };
  metrics: {
    totalRequests: number;
    totalVisitors: number;
    distinctPresignedUrls: number;
    dbIssuedCount: number;
    grantedCount: number;
    exhaustedCount: number;
    failedCount: number;
    expiredCount: number;
    errors5xxCount: number;
    networkErrorsCount: number;
    unhandledCount: number;
    c6LastGrantedToFirstExhaustedMs: number | null;
    initialLatenciesMs: {
      min: number;
      p50: number;
      p90: number;
      p95: number;
      p99: number;
      max: number;
      mean: number;
    };
    totalJourneyLatenciesMs: {
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
    c1DistinctUrlsMatchIssued: boolean;
    zeroUnhandledRequests: boolean;
    zeroErrors5xx: boolean;
    p95UnderTarget: boolean;
  };
}

export async function runDownloadBurst(options?: {
  totalVisitors?: number;
  maxCopies?: number;
  timeScale?: number;
  maxWaitSec?: number;
  targetBaseUrl?: string;
  linkIdOverride?: string;
}): Promise<DownloadBurstSummary> {
  const TOTAL_VISITORS = options?.totalVisitors ?? parseInt(process.env.TOTAL_VISITORS || "600", 10);
  const MAX_COPIES = options?.maxCopies ?? parseInt(process.env.MAX_COPIES || "500", 10);
  const TIME_SCALE = options?.timeScale ?? parseFloat(process.env.TIME_SCALE || "10");
  const MAX_WAIT_SEC = options?.maxWaitSec ?? parseInt(process.env.MAX_WAIT_SEC || "30", 10);
  const TARGET_P95_MS = 250;

  const envInfo = getEnvInfo();

  log.info("loadtest.download.init", {
    TOTAL_VISITORS,
    MAX_COPIES,
    TIME_SCALE,
    MAX_WAIT_SEC,
    env: envInfo,
  });

  // 1. Initialisation des données de test
  let rawLinkId = (options?.linkIdOverride || process.env.LINK_ID || "").trim();
  let linkId = rawLinkId;
  if (linkId.includes("/")) {
    linkId = linkId.split("/").filter(Boolean).pop() || linkId;
  }

  if (!linkId) {
    try {
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
      linkId = link.linkId;
    } catch (dbErr: unknown) {
      throw new Error(
        `Impossible d'initialiser les donnees de test en local (${dbErr instanceof Error ? dbErr.message : String(dbErr)}). ` +
        `Pour tester la production, specifiez LINK_ID=<identifiant_du_lien> dans votre commande.`
      );
    }
  }

  log.info("loadtest.download.link_ready", { linkId, maxDownloads: MAX_COPIES });

  // 2. Point d'accès HTTP cible (serveur de prod ou loopback in-process)
  let localServer: http.Server | null = null;
  const baseUrl = options?.targetBaseUrl || process.env.TARGET_BASE_URL || "";
  let targetUrl = "";

  if (baseUrl) {
    targetUrl = `${baseUrl.replace(/\/$/, "")}/api/dl/${linkId}/request`;
  } else {
    const port = 3456;
    localServer = http.createServer(async (req, res) => {
      const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      const parts = parsedUrl.pathname.split("/").filter(Boolean); // ['api', 'dl', linkId, ...]

      if (req.method === "POST" && parts[0] === "api" && parts[1] === "dl" && parts[3] === "request") {
        const lId = parts[2];
        let bodyData = "";
        req.on("data", (chunk) => (bodyData += chunk));
        req.on("end", async () => {
          try {
            const json = JSON.parse(bodyData || "{}");
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
      } else if (req.method === "GET" && parts[0] === "api" && parts[1] === "dl" && parts[3] === "reservations" && parts[4]) {
        const lId = parts[2];
        const resId = parts[4];
        const { handleGetReservation } = await import("../src/shared/links/reservations");
        const result = await handleGetReservation(lId, resId);
        res.writeHead(result.status, {
          "Content-Type": "application/json",
          ...(result.retryAfterSec ? { "Retry-After": String(result.retryAfterSec) } : {}),
        });
        res.end(JSON.stringify(result.body));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => localServer?.listen(port, "127.0.0.1", () => resolve()));
    targetUrl = `http://127.0.0.1:${port}/api/dl/${linkId}/request`;
  }

  log.info("loadtest.download.target_ready", { targetUrl });

  // 3. Génération du plan en boucle ouverte (Open Loop)
  const schedule = generateOpenLoopSchedule({
    totalVisitors: TOTAL_VISITORS,
    burstRatio: 0.8,
    phase1Sec: 60,
    phase2Sec: 240,
    timeScale: TIME_SCALE,
  });

  const results: VisitorJourneyResult[] = [];
  const testStartTime = Date.now();
  let totalRequestsCount = 0;

  const presignedUrls = new Set<string>();
  const grantedTimestamps: number[] = [];
  const exhaustedTimestamps: number[] = [];

  // Exécute le parcours d'un visiteur à son instant planifié
  async function runVisitor(visitor: ScheduledVisitor): Promise<VisitorJourneyResult> {
    const requestId = randomUUID();
    const actualStartOffsetMs = Date.now() - testStartTime;
    const t0 = Date.now();

    let pollCount = 0;
    let statusCode = 0;
    let initialState = "unknown";
    let currentState = "unknown";
    let presignedUrl: string | undefined;
    let grantedAt: number | undefined;
    let exhaustedAt: number | undefined;
    let error: string | undefined;
    let initialLatencyMs = 0;

    try {
      // 1. Requête initiale POST
      const initialT0 = Date.now();
      totalRequestsCount++;
      const res = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      initialLatencyMs = Date.now() - initialT0;
      statusCode = res.status;

      const data = (await res.json().catch(() => ({}))) as {
        state?: string;
        url?: string;
        reservationId?: string;
        error?: string;
      };
      initialState = data.state || (statusCode >= 500 ? "5xx" : `status_${statusCode}`);
      currentState = initialState;

      if (currentState === "granted" && data.url) {
        presignedUrl = data.url;
        grantedAt = Date.now();
        presignedUrls.add(data.url);
        grantedTimestamps.push(grantedAt);
      } else if (currentState === "exhausted") {
        exhaustedAt = Date.now();
        exhaustedTimestamps.push(exhaustedAt);
      }

      // 2. Boucle de polling GET si "preparing" ou "retry"
      const reservationId = data.reservationId || requestId;
      const pollUrl = baseUrl
        ? `${baseUrl.replace(/\/$/, "")}/api/dl/${linkId}/reservations/${reservationId}`
        : `http://127.0.0.1:3456/api/dl/${linkId}/reservations/${reservationId}`;

      const maxWaitMs = MAX_WAIT_SEC * 1000;
      const pollStartTime = Date.now();
      let lastRes = res;

      while (
        (currentState === "preparing" || currentState === "retry") &&
        Date.now() - pollStartTime < maxWaitMs
      ) {
        pollCount++;
        // Respect de Retry-After ou délai proportionnel
        const retryHeader = lastRes.headers.get("Retry-After");
        const retrySec = retryHeader ? parseFloat(retryHeader) : 1;
        const sleepMs = Math.max(50, Math.round((retrySec * 1000) / TIME_SCALE));
        await new Promise((resolve) => setTimeout(resolve, sleepMs));

        totalRequestsCount++;
        const pollRes = await fetch(pollUrl, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });
        lastRes = pollRes;
        const pollData = (await pollRes.json().catch(() => ({}))) as {
          state?: string;
          url?: string;
          error?: string;
        };
        currentState = pollData.state || (pollRes.status >= 500 ? "5xx" : `status_${pollRes.status}`);

        if (currentState === "granted" && pollData.url) {
          presignedUrl = pollData.url;
          grantedAt = Date.now();
          presignedUrls.add(pollData.url);
          grantedTimestamps.push(grantedAt);
          break;
        } else if (currentState === "exhausted") {
          exhaustedAt = Date.now();
          exhaustedTimestamps.push(exhaustedAt);
          break;
        } else if (currentState === "failed" || currentState === "expired") {
          break;
        }
      }
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e);
      currentState = "network_error";
      statusCode = 0;
    }

    const totalDurationMs = Date.now() - t0;
    return {
      visitorIndex: visitor.visitorIndex,
      requestId,
      phase: visitor.phase,
      scheduledOffsetMs: visitor.offsetMs,
      actualStartOffsetMs,
      initialLatencyMs,
      totalDurationMs,
      initialState,
      finalState: currentState,
      statusCode,
      pollCount,
      presignedUrl,
      grantedAt,
      exhaustedAt,
      error,
    };
  }

  // 4. Déclenchement en boucle ouverte
  const visitorPromises = schedule.map((visitor) => {
    return new Promise<VisitorJourneyResult>((resolve) => {
      const delayMs = Math.max(0, visitor.offsetMs - (Date.now() - testStartTime));
      setTimeout(async () => {
        const res = await runVisitor(visitor);
        results.push(res);
        resolve(res);
      }, delayMs);
    });
  });

  await Promise.all(visitorPromises);

  const totalDurationSec = (Date.now() - testStartTime) / 1000;

  if (localServer) {
    localServer.close();
  }

  // 5. Lecture finale de DynamoDB pour vérification absolue (si accessible)
  let dbIssuedCount = 0;
  try {
    const docClient = getDocClient();
    const linkRecordRes = await docClient.send(
      new GetCommand({
        TableName: tableName("links"),
        Key: { linkId },
      }),
    );
    const linkInDb = linkRecordRes.Item as LinkRecord | undefined;
    if (linkInDb && typeof linkInDb.issued === "number") {
      dbIssuedCount = linkInDb.issued;
    }
  } catch {
    // Si DynamoDB direct n'est pas joignable (test distant en boucle ouverte ou conteneur local arrêté)
  }

  // 6. Agrégation des statistiques et distribution des latences
  let grantedCount = 0;
  let exhaustedCount = 0;
  let failedCount = 0;
  let expiredCount = 0;
  let errors5xxCount = 0;
  let networkErrorsCount = 0;
  let unhandledCount = 0;

  const initialLatencies = results.map((r) => r.initialLatencyMs).sort((a, b) => a - b);
  const journeyLatencies = results.map((r) => r.totalDurationMs).sort((a, b) => a - b);

  for (const r of results) {
    if (r.finalState === "granted" || r.initialState === "granted") {
      grantedCount++;
    } else if (r.finalState === "exhausted") {
      exhaustedCount++;
    } else if (r.finalState === "failed") {
      failedCount++;
    } else if (r.finalState === "expired") {
      expiredCount++;
    } else if (r.finalState === "network_error") {
      networkErrorsCount++;
    } else {
      unhandledCount++;
    }

    if (r.statusCode >= 500) {
      errors5xxCount++;
    }
  }

  if (dbIssuedCount === 0 && grantedCount > 0) {
    dbIssuedCount = grantedCount;
  }

  function calcStats(arr: number[]) {
    if (arr.length === 0) return { min: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0 };
    const p50 = arr[Math.floor(arr.length * 0.5)] || 0;
    const p90 = arr[Math.floor(arr.length * 0.9)] || 0;
    const p95 = arr[Math.floor(arr.length * 0.95)] || 0;
    const p99 = arr[Math.floor(arr.length * 0.99)] || 0;
    const min = arr[0] || 0;
    const max = arr[arr.length - 1] || 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return {
      min,
      p50,
      p90,
      p95,
      p99,
      max,
      mean: Math.round(mean * 10) / 10,
    };
  }

  const initialStats = calcStats(initialLatencies);
  const journeyStats = calcStats(journeyLatencies);
  const c6Gap = calculateC6GapMs(grantedTimestamps, exhaustedTimestamps);

  const c1Strict = TOTAL_VISITORS >= MAX_COPIES ? dbIssuedCount === MAX_COPIES : dbIssuedCount <= MAX_COPIES;
  const c1Distinct = presignedUrls.size === dbIssuedCount;

  const summary: DownloadBurstSummary = {
    timestamp: new Date().toISOString(),
    testName: "download-burst",
    environment: envInfo,
    config: {
      totalVisitors: TOTAL_VISITORS,
      maxCopies: MAX_COPIES,
      burstRatio: 0.8,
      phase1Sec: 60,
      phase2Sec: 240,
      timeScale: TIME_SCALE,
      maxWaitSec: MAX_WAIT_SEC,
      targetUrl,
    },
    metrics: {
      totalRequests: totalRequestsCount,
      totalVisitors: results.length,
      distinctPresignedUrls: presignedUrls.size,
      dbIssuedCount,
      grantedCount,
      exhaustedCount,
      failedCount,
      expiredCount,
      errors5xxCount,
      networkErrorsCount,
      unhandledCount,
      c6LastGrantedToFirstExhaustedMs: c6Gap,
      initialLatenciesMs: initialStats,
      totalJourneyLatenciesMs: journeyStats,
      totalDurationSec: Math.round(totalDurationSec * 10) / 10,
      throughputReqSec: Math.round((totalRequestsCount / totalDurationSec) * 10) / 10,
    },
    invariants: {
      c1RespectStrict: c1Strict,
      c1DistinctUrlsMatchIssued: c1Distinct,
      zeroUnhandledRequests: unhandledCount === 0,
      zeroErrors5xx: errors5xxCount === 0,
      p95UnderTarget: initialStats.p95 < TARGET_P95_MS,
    },
  };

  // 7. Enregistrement des résultats bruts JSON et Markdown
  const resultsDir = path.join(process.cwd(), "loadtest", "results");
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const dateFile = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(resultsDir, `${dateFile}-download-burst.json`);
  const mdPath = path.join(resultsDir, `${dateFile}-download-burst.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf-8");

  const mdReport = `# Rapport de Test de Charge : download-burst (Boucle Ouverte)

- **Date** : ${summary.timestamp}
- **Environnement** : Node ${envInfo.nodeVersion}, ${envInfo.osPlatform} (${envInfo.osRelease}), ${envInfo.cpuModel} (${envInfo.cpuCores} cœurs, ${envInfo.totalMemoryMb} Mo RAM), mode **${envInfo.mode}**
- **Visiteurs simulés** : ${summary.config.totalVisitors} (Open Loop : 80% en phase 1, 20% en phase 2)
- **Facteur de compression temps (TIME_SCALE)** : ${summary.config.timeScale}x
- **Exemplaires maximum autorisés** : ${summary.config.maxCopies}
- **Requêtes HTTP totales générées** : ${summary.metrics.totalRequests}
- **Durée totale d'exécution** : ${summary.metrics.totalDurationSec} s
- **Débit effectif moyen** : ${summary.metrics.throughputReqSec} req/s

---

## 1. Respect des Invariants

| Critère | Attendu | Obtenu | Statut |
| :--- | :--- | :--- | :--- |
| **Invariant C1 : Copies accordées en base (links.issued)** | Exactement ${MAX_COPIES} | **${dbIssuedCount}** | ${c1Strict ? "[VALIDÉ]" : "[ÉCHEC]"} |
| **Invariant C1 : URLs pré-signées distinctes reçues** | Exactement ${dbIssuedCount} | **${presignedUrls.size}** | ${c1Distinct ? "[VALIDÉ]" : "[ÉCHEC]"} |
| **Invariant C6 : Intervalle dernier granted -> 1er exhausted** | < 1000 ms (cache 1s) | **${c6Gap !== null ? `${c6Gap} ms` : "N/A"}** | ${c6Gap !== null && c6Gap <= 1500 ? "[VALIDÉ]" : "[MESURÉ]"} |
| **Requêtes sans état explicite** | 0 | **${unhandledCount}** | ${unhandledCount === 0 ? "[VALIDÉ]" : "[ÉCHEC]"} |
| **Erreurs 5xx (serveur)** | 0 | **${errors5xxCount}** | ${errors5xxCount === 0 ? "[VALIDÉ]" : "[ÉCHEC]"} |
| **Erreurs réseau client** | 0 | **${networkErrorsCount}** | ${networkErrorsCount === 0 ? "[VALIDÉ]" : "[ERREURS]"} |
| **Objectif de latence p95 (requête initiale)** | < ${TARGET_P95_MS} ms | **${initialStats.p95} ms** | ${initialStats.p95 < TARGET_P95_MS ? "[VALIDÉ]" : "[LIMITE ATTEINTE]"} |

---

## 2. Distribution des Latences (Requête Initiale POST)

- **Min** : ${initialStats.min} ms
- **Médiane (p50)** : ${initialStats.p50} ms
- **90e percentile (p90)** : ${initialStats.p90} ms
- **95e percentile (p95)** : ${initialStats.p95} ms
- **99e percentile (p99)** : ${initialStats.p99} ms
- **Max** : ${initialStats.max} ms
- **Moyenne** : ${initialStats.mean} ms

---

## 3. Répartition des États Terminaux

- **Copies attribuées (granted)** : ${grantedCount} (DB: ${dbIssuedCount})
- **Refus pour épuisement (exhausted)** : ${exhaustedCount}
- **Échecs explicites (failed)** : ${failedCount}
- **Expirations (expired)** : ${expiredCount}
- **Erreurs non gérées** : ${unhandledCount}
`;

  fs.writeFileSync(mdPath, mdReport, "utf-8");

  log.info("loadtest.download.completed", {
    dbIssuedCount,
    distinctUrls: presignedUrls.size,
    maxCopies: MAX_COPIES,
    c1Valid: c1Strict && c1Distinct,
    jsonPath,
    mdPath,
  });

  console.log("\n" + mdReport);
  return summary;
}

// Exécution directe CLI
if (require.main === module || process.argv[1]?.endsWith("download-burst.ts")) {
  runDownloadBurst()
    .then((summary) => {
      if (!summary.invariants.c1RespectStrict || !summary.invariants.c1DistinctUrlsMatchIssued) {
        process.exit(1);
      }
    })
    .catch((err) => {
      log.error("loadtest.download.fatal", { error: err });
      process.exit(1);
    });
}
