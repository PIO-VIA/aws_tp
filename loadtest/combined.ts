/**
 * Test combiné (Section 15.4, C-08) :
 * Lance SIMULTANÉMENT :
 * 1. Le test de rafale de téléchargement en boucle ouverte (download-burst)
 * 2. La simulation de collaboration multi-rédacteurs (collab-sim)
 * Mesure la latence de propagation Yjs et le comportement du système PENDANT le pic de téléchargement.
 */
import fs from "fs";
import path from "path";
import { runDownloadBurst, DownloadBurstSummary } from "./download-burst";
import { runCollabSim, CollabSimSummary } from "./collab-sim";
import { getEnvInfo, EnvInfo } from "./env-info";
import { log } from "../src/shared/log";

export interface CombinedLoadTestSummary {
  timestamp: string;
  testName: "combined-loadtest";
  environment: EnvInfo;
  config: {
    downloadVisitors: number;
    downloadCopies: number;
    collabWriters: number;
    collabDocs: number;
    timeScale: number;
  };
  downloadBurst: DownloadBurstSummary["metrics"];
  collabSim: CollabSimSummary["metrics"];
  invariants: {
    c1RespectStrict: boolean;
    c1DistinctUrlsMatchIssued: boolean;
    c2ConvergenceStrict: boolean;
    zeroErrors5xx: boolean;
    zeroUnhandledRequests: boolean;
  };
}

export async function runCombinedLoadTest(): Promise<CombinedLoadTestSummary> {
  const envInfo = getEnvInfo();
  const timeScale = parseFloat(process.env.TIME_SCALE || "10");
  const downloadVisitors = parseInt(process.env.TOTAL_VISITORS || "600", 10);
  const downloadCopies = parseInt(process.env.MAX_COPIES || "500", 10);
  const collabWriters = parseInt(process.env.WRITERS || process.env.TOTAL_WRITERS || "50", 10);
  const collabDocs = parseInt(process.env.DOC_COUNT || "2", 10);

  log.info("loadtest.combined.start", {
    downloadVisitors,
    downloadCopies,
    collabWriters,
    collabDocs,
    timeScale,
    env: envInfo,
  });

  const startTime = Date.now();

  // Exécution conjointe strictement simultanée
  const [downloadSummary, collabSummary] = await Promise.all([
    runDownloadBurst({
      totalVisitors: downloadVisitors,
      maxCopies: downloadCopies,
      timeScale,
    }),
    runCollabSim({
      totalWriters: collabWriters,
      docCount: collabDocs,
      typingBursts: 3,
    }),
  ]);

  const totalDurationSec = (Date.now() - startTime) / 1000;

  const summary: CombinedLoadTestSummary = {
    timestamp: new Date().toISOString(),
    testName: "combined-loadtest",
    environment: envInfo,
    config: {
      downloadVisitors,
      downloadCopies,
      collabWriters,
      collabDocs,
      timeScale,
    },
    downloadBurst: downloadSummary.metrics,
    collabSim: collabSummary.metrics,
    invariants: {
      c1RespectStrict: downloadSummary.invariants.c1RespectStrict,
      c1DistinctUrlsMatchIssued: downloadSummary.invariants.c1DistinctUrlsMatchIssued,
      c2ConvergenceStrict: collabSummary.invariants.c2ConvergenceStrict,
      zeroErrors5xx: downloadSummary.invariants.zeroErrors5xx,
      zeroUnhandledRequests: downloadSummary.invariants.zeroUnhandledRequests,
    },
  };

  // Enregistrement JSON et Markdown
  const resultsDir = path.join(process.cwd(), "loadtest", "results");
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const dateFile = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(resultsDir, `${dateFile}-combined.json`);
  const mdPath = path.join(resultsDir, `${dateFile}-combined.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf-8");

  const mdReport = `# Rapport de Test de Charge Combiné (Téléchargement + Collaboration)

- **Date** : ${summary.timestamp}
- **Environnement** : Node ${envInfo.nodeVersion}, ${envInfo.osPlatform} (${envInfo.osRelease}), ${envInfo.cpuModel} (${envInfo.cpuCores} cœurs, ${envInfo.totalMemoryMb} Mo RAM), mode **${envInfo.mode}**
- **Durée totale combinée** : ${Math.round(totalDurationSec * 10) / 10} s
- **Facteur d'échelle temporelle (TIME_SCALE)** : ${timeScale}x

---

## 1. Respect des Invariants en Conditions Réunies

| Invariant | Attendu | Obtenu | Statut |
| :--- | :--- | :--- | :--- |
| **C1 (Capacité de téléchargement)** | Exactement ${downloadCopies} exemplaires | **${summary.downloadBurst.dbIssuedCount} en DB** | ${summary.invariants.c1RespectStrict ? "[VALIDÉ]" : "[ÉCHEC]"} |
| **C1 (URLs distinctes)** | URLs distinctes = ${summary.downloadBurst.dbIssuedCount} | **${summary.downloadBurst.distinctPresignedUrls} URLs** | ${summary.invariants.c1DistinctUrlsMatchIssued ? "[VALIDÉ]" : "[ÉCHEC]"} |
| **C2 (Convergence CRDT)** | 100 % cohérence entre pairs | **Convergence stricte** | ${summary.invariants.c2ConvergenceStrict ? "[VALIDÉ]" : "[ÉCHEC]"} |
| **Zéro 5xx** | 0 erreur serveur | **${summary.downloadBurst.errors5xxCount}** | ${summary.invariants.zeroErrors5xx ? "[VALIDÉ]" : "[ÉCHEC]"} |
| **Zéro requête non gérée** | 0 inconnu | **${summary.downloadBurst.unhandledCount}** | ${summary.invariants.zeroUnhandledRequests ? "[VALIDÉ]" : "[ÉCHEC]"} |

---

## 2. Performances Mesurées PENDANT le Pic Conjoint

- **Latence de téléchargement p95 (initiale)** : ${summary.downloadBurst.initialLatenciesMs.p95} ms (moyenne : ${summary.downloadBurst.initialLatenciesMs.mean} ms)
- **Latence de propagation collaborative p95** : ${summary.collabSim.latenciesMs.p95} ms (moyenne : ${summary.collabSim.latenciesMs.mean} ms)
- **Éditions collaboratives traitées** : ${summary.collabSim.totalEditsSent}
- **Propagations observées** : ${summary.collabSim.totalPropagationsObserved}
- **CPU Serveur Hocuspocus** : ${summary.collabSim.serverCpu.totalMs} ms (~${summary.collabSim.serverCpu.percentOfOneCore}% d'un cœur)
`;

  fs.writeFileSync(mdPath, mdReport, "utf-8");

  log.info("loadtest.combined.completed", {
    c1Valid: summary.invariants.c1RespectStrict,
    c2Valid: summary.invariants.c2ConvergenceStrict,
    jsonPath,
    mdPath,
  });

  console.log("\n" + mdReport);
  return summary;
}

if (require.main === module || process.argv[1]?.endsWith("combined.ts")) {
  runCombinedLoadTest()
    .then((summary) => {
      if (!summary.invariants.c1RespectStrict || !summary.invariants.c2ConvergenceStrict) {
        process.exit(1);
      }
    })
    .catch((err) => {
      log.error("loadtest.combined.fatal", { error: err });
      process.exit(1);
    });
}
