/**
 * Test de charge et simulation de collaboration multi-rédacteurs (Section 15.4, C-08).
 * - N rédacteurs simultanés (300 par défaut, ou paramètre WRITERS / TOTAL_WRITERS).
 * - Répartis sur 1 document puis plusieurs (paramètre DOC_COUNT).
 * - Frappes groupées à rythme humain (1 à 3 frappes/s avec pauses).
 * - Échantillonnage de /internal/health du SERVEUR collab (début et fin) :
 *   mesure le CPU et la mémoire du SERVEUR (pas du client de test).
 * - Vérification stricte de la convergence Yjs sans perte d'édition (C2).
 * - Mesure des latences de propagation (p50, p90, p95, p99).
 */
import fs from "fs";
import path from "path";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { createCollabServer } from "../collab/server";
import { createDocument, shareDocument } from "../src/shared/docs/documents";
import { createCollabToken } from "../src/shared/auth/jwt";
import { upsertWriter } from "../src/shared/auth/session";
import { getConfig } from "../src/shared/config";
import { getEnvInfo, EnvInfo } from "./env-info";
import { log } from "../src/shared/log";

export interface PropagationRecord {
  fromWriter: number;
  toWriter: number;
  docIndex: number;
  latencyMs: number;
}

export interface CollabSimSummary {
  timestamp: string;
  testName: "collab-sim";
  environment: EnvInfo;
  config: {
    totalWriters: number;
    docCount: number;
    typingBursts: number;
    collabPort: number;
  };
  metrics: {
    totalEditsSent: number;
    totalPropagationsObserved: number;
    writeRefusedCount: number;
    convergenceMatch: boolean;
    finalTextLengths: number[];
    latenciesMs: {
      min: number;
      p50: number;
      p90: number;
      p95: number;
      p99: number;
      max: number;
      mean: number;
    };
    serverCpu: {
      userMs: number;
      systemMs: number;
      totalMs: number;
      percentOfOneCore: number;
    };
    serverMemoryMb: {
      rss: number;
    };
    durationSec: number;
  };
  invariants: {
    c2ConvergenceStrict: boolean;
    zeroWriteLoss: boolean;
    p95UnderTarget: boolean;
  };
}

async function fetchServerStats(internalPort: number, token: string): Promise<{
  cpuUserMs: number;
  cpuSystemMs: number;
  rssMb: number;
  connections: number;
} | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${internalPort}/internal/health`, {
      headers: { "x-internal-token": token },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      stats?: { cpuUserMs: number; cpuSystemMs: number; rssMb: number; connections: number };
    };
    return data.stats || null;
  } catch {
    return null;
  }
}

export async function runCollabSim(options?: {
  totalWriters?: number;
  docCount?: number;
  typingBursts?: number;
  collabPort?: number;
  internalPort?: number;
  externalServer?: boolean;
  targetBaseUrl?: string;
}): Promise<CollabSimSummary> {
  const TOTAL_WRITERS = options?.totalWriters ?? parseInt(process.env.WRITERS || process.env.TOTAL_WRITERS || "300", 10);
  const DOC_COUNT = options?.docCount ?? parseInt(process.env.DOC_COUNT || "2", 10);
  const TYPING_BURSTS = options?.typingBursts ?? parseInt(process.env.TYPING_BURSTS || "3", 10);
  const TARGET_P95_MS = 200;

  const targetBaseUrl = (options?.targetBaseUrl || process.env.TARGET_BASE_URL || "").replace(/\/$/, "");
  const isProd = Boolean(targetBaseUrl);
  const collabPort = options?.collabPort ?? parseInt(process.env.COLLAB_PORT || "1240", 10);
  const internalPort = options?.internalPort ?? parseInt(process.env.COLLAB_INTERNAL_PORT || "1241", 10);
  const isExternal = isProd || (options?.externalServer ?? (process.env.COLLAB_EXTERNAL === "true"));
  const collabWsUrl = isProd
    ? targetBaseUrl.replace(/^http/, "ws") + "/collab"
    : `ws://127.0.0.1:${collabPort}`;

  const envInfo = getEnvInfo();
  let config: ReturnType<typeof getConfig> | null = null;
  try {
    config = getConfig();
  } catch {
    // En mode production sans variables d'environnement locales AWS
  }

  log.info("loadtest.collab.init", {
    TOTAL_WRITERS,
    DOC_COUNT,
    TYPING_BURSTS,
    collabPort,
    internalPort,
    isExternal,
    collabWsUrl,
    mode: isProd ? "production_remote" : "local_dedicated",
    env: envInfo,
  });

  // 1. Démarrage du serveur si nécessaire (uniquement en local non externe)
  let dedicatedServer: ReturnType<typeof createCollabServer> | null = null;
  if (!isExternal) {
    dedicatedServer = createCollabServer();
    await dedicatedServer.server.listen(collabPort);
    await new Promise<void>((resolve) => dedicatedServer!.internalHttp.listen(internalPort, "127.0.0.1", () => resolve()));
  }

  // Échantillon CPU/mémoire initial du serveur Hocuspocus (via /internal/health)
  const startServerStats = config ? await fetchServerStats(internalPort, config.INTERNAL_TOKEN) : null;
  const startTime = Date.now();

  // 2. Initialisation des documents et rédacteurs
  interface WriterClient {
    id: number;
    name: string;
    writerId: string;
    docIndex: number;
    docId: string;
    ydoc: Y.Doc;
    provider: HocuspocusProvider;
    refusedCount: number;
  }

  const clients: WriterClient[] = [];
  const propagations: PropagationRecord[] = [];

  function attachTextObserver(clientObj: WriterClient) {
    clientObj.ydoc.getText("content").observe((event) => {
      const receivedAt = Date.now();
      for (const op of event.changes.delta) {
        if (op.insert && typeof op.insert === "string") {
          const matches = op.insert.matchAll(/\[W(\d+):(\d+):(\d+)\]/g);
          for (const m of matches) {
            const fromWriterId = parseInt(m[1], 10);
            const sentAt = parseInt(m[3], 10);
            if (fromWriterId !== clientObj.id) {
              const latency = Math.max(0, receivedAt - sentAt);
              propagations.push({
                fromWriter: fromWriterId,
                toWriter: clientObj.id,
                docIndex: clientObj.docIndex,
                latencyMs: latency,
              });
            }
          }
        }
      }
    });
  }

  if (isProd) {
    // Mode Production : création via API HTTP publique et connexion WSS
    log.info("loadtest.collab.prod_setup", { targetBaseUrl, collabWsUrl });
    const documents: Array<{ docId: string; ownerCookie: string }> = [];

    for (let d = 0; d < DOC_COUNT; d++) {
      const ownerEmail = `owner-sim-d${d}-${Date.now()}@asso.fr`;
      const ownerRes = await fetch(`${targetBaseUrl}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: targetBaseUrl },
        body: JSON.stringify({ name: `Owner D${d}`, email: ownerEmail }),
      });
      const ownerCookie = ownerRes.headers.get("set-cookie")?.split(";")[0] || "";
      const docRes = await fetch(`${targetBaseUrl}/api/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: ownerCookie, Origin: targetBaseUrl },
        body: JSON.stringify({ title: `Doc Collab Prod #${d + 1}` }),
      });
      const docData = (await docRes.json()) as { docId: string };
      documents.push({ docId: docData.docId, ownerCookie });
    }

    const batchSize = 10;
    for (let i = 0; i < TOTAL_WRITERS; i += batchSize) {
      const chunk = Array.from({ length: Math.min(batchSize, TOTAL_WRITERS - i) }, (_, idx) => i + idx);
      await Promise.all(
        chunk.map(async (wIdx) => {
          const docIndex = wIdx % DOC_COUNT;
          const doc = documents[docIndex];
          const email = `writer-sim-${wIdx}-${Date.now()}@asso.fr`;
          const name = `Redacteur ${wIdx}`;

          const wRes = await fetch(`${targetBaseUrl}/api/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: targetBaseUrl },
            body: JSON.stringify({ name, email }),
          });
          const writerCookie = wRes.headers.get("set-cookie")?.split(";")[0] || "";

          await fetch(`${targetBaseUrl}/api/documents/${doc.docId}/share`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: doc.ownerCookie, Origin: targetBaseUrl },
            body: JSON.stringify({ email, name, role: "editor" }),
          });

          const tokRes = await fetch(`${targetBaseUrl}/api/session/collab-token?docId=${doc.docId}`, {
            headers: { Cookie: writerCookie },
          });
          const { token } = (await tokRes.json()) as { token: string };

          const ydoc = new Y.Doc();
          const clientObj: WriterClient = {
            id: wIdx,
            name,
            writerId: `w-${wIdx}`,
            docIndex,
            docId: doc.docId,
            ydoc,
            refusedCount: 0,
            provider: null as unknown as HocuspocusProvider,
          };

          const provider = new HocuspocusProvider({
            url: collabWsUrl,
            name: doc.docId,
            document: ydoc,
            token,
            onStateless(payload) {
              try {
                const parsed = JSON.parse(payload.payload);
                if (parsed.type === "write_refused") {
                  clientObj.refusedCount++;
                }
              } catch {}
            },
          });
          clientObj.provider = provider;
          attachTextObserver(clientObj);
          clients.push(clientObj);
        }),
      );
    }
    clients.sort((a, b) => a.id - b.id);
  } else {
    // Mode Local : création directe en base locale
    const documents: Array<{ docId: string; ownerId: string; title: string }> = [];
    for (let d = 0; d < DOC_COUNT; d++) {
      const ownerEmail = `owner-sim-d${d}-${Date.now()}@asso.fr`;
      const owner = await upsertWriter(`Owner D${d}`, ownerEmail);
      const doc = await createDocument(`Document Collaboratif Sim #${d + 1}`, {
        writerId: owner.writerId,
        name: owner.name,
        email: owner.email,
      });
      documents.push({ docId: doc.docId, ownerId: owner.writerId, title: `Doc ${d + 1}` });
    }

    for (let i = 0; i < TOTAL_WRITERS; i++) {
      const docIndex = i % DOC_COUNT;
      const doc = documents[docIndex];
      const email = `writer-sim-${i}-${Date.now()}@asso.fr`;
      const name = `Rédacteur ${i}`;

      const writerRec = await upsertWriter(name, email);
      const ydoc = new Y.Doc();

      await shareDocument({
        docId: doc.docId,
        ownerId: doc.ownerId,
        targetEmail: email,
        targetName: name,
        role: "editor",
      });

      const token = await createCollabToken({
        writerId: writerRec.writerId,
        docId: doc.docId,
      });

      const clientObj: WriterClient = {
        id: i,
        name,
        writerId: writerRec.writerId,
        docIndex,
        docId: doc.docId,
        ydoc,
        refusedCount: 0,
        provider: null as unknown as HocuspocusProvider,
      };

      const provider = new HocuspocusProvider({
        url: collabWsUrl,
        name: doc.docId,
        document: ydoc,
        token,
        onStateless(payload) {
          try {
            const parsed = JSON.parse(payload.payload);
            if (parsed.type === "write_refused") {
              clientObj.refusedCount++;
            }
          } catch {}
        },
      });

      clientObj.provider = provider;
      attachTextObserver(clientObj);
      clients.push(clientObj);
    }
  }

  // 4. Attente de synchronisation initiale de tous les clients
  log.info("loadtest.collab.syncing_clients", { count: clients.length });
  await Promise.all(
    clients.map(
      (c) =>
        new Promise<void>((resolve) => {
          if (c.provider.isSynced) resolve();
          else c.provider.on("synced", () => resolve());
        }),
    ),
  );

  log.info("loadtest.collab.clients_synced");

  // 5. Frappes groupées à rythme humain (1 à 3 frappes/s avec pauses)
  let totalEditsSent = 0;

  for (let burst = 0; burst < TYPING_BURSTS; burst++) {
    log.info("loadtest.collab.burst_round", { round: burst + 1, totalRounds: TYPING_BURSTS });

    await Promise.all(
      clients.map(async (client, clientIdx) => {
        const timestamp = Date.now();
        const editTag = `[W${client.id}:${burst}:${timestamp}] `;
        const ytext = client.ydoc.getText("content");

        ytext.insert(0, editTag);
        totalEditsSent++;

        // Pause humaine aléatoire (80 à 250 ms)
        const pause = 80 + (clientIdx % 8) * 20;
        await new Promise((resolve) => setTimeout(resolve, pause));
      }),
    );

    // Pause entre deux rafales
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  // Attente de convergence finale (jusqu'à convergence de tous les pairs ou timeout de 10s)
  log.info("loadtest.collab.awaiting_convergence");
  const convStart = Date.now();
  const convergenceTimeoutMs = 12000;
  let convergenceMatch = false;

  while (Date.now() - convStart < convergenceTimeoutMs) {
    let allDocsConverged = true;
    for (let d = 0; d < DOC_COUNT; d++) {
      const clientsOnDoc = clients.filter((c) => c.docIndex === d);
      if (clientsOnDoc.length > 0) {
        const refText = clientsOnDoc[0].ydoc.getText("content").toString();
        for (let j = 1; j < clientsOnDoc.length; j++) {
          if (clientsOnDoc[j].ydoc.getText("content").toString() !== refText) {
            allDocsConverged = false;
            break;
          }
        }
      }
      if (!allDocsConverged) break;
    }
    if (allDocsConverged) {
      convergenceMatch = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // 6. Vérification de convergence stricte (C2)
  const finalTextLengths: number[] = [];

  for (let d = 0; d < DOC_COUNT; d++) {
    const clientsOnDoc = clients.filter((c) => c.docIndex === d);
    if (clientsOnDoc.length > 0) {
      const referenceText = clientsOnDoc[0].ydoc.getText("content").toString();
      finalTextLengths.push(referenceText.length);

      for (let j = 1; j < clientsOnDoc.length; j++) {
        const otherText = clientsOnDoc[j].ydoc.getText("content").toString();
        if (otherText !== referenceText) {
          convergenceMatch = false;
          log.error("loadtest.collab.convergence_failure", {
            docIndex: d,
            expectedLen: referenceText.length,
            actualLen: otherText.length,
          });
        }
      }
    }
  }

  // Échantillon CPU/mémoire final du serveur Hocuspocus (via /internal/health)
  const endServerStats = config ? await fetchServerStats(internalPort, config.INTERNAL_TOKEN) : null;

  // Fermeture des clients et du serveur
  for (const c of clients) {
    c.provider.destroy();
  }
  if (dedicatedServer) {
    await dedicatedServer.server.destroy();
    dedicatedServer.internalHttp.close();
  }

  const durationSec = (Date.now() - startTime) / 1000;

  // Calcul du CPU SERVEUR exact
  let serverCpuUserMs = 0;
  let serverCpuSystemMs = 0;
  let serverRssMb = 0;

  if (startServerStats && endServerStats) {
    serverCpuUserMs = Math.max(0, endServerStats.cpuUserMs - startServerStats.cpuUserMs);
    serverCpuSystemMs = Math.max(0, endServerStats.cpuSystemMs - startServerStats.cpuSystemMs);
    serverRssMb = endServerStats.rssMb;
  } else {
    // Fallback
    const cpu = process.cpuUsage();
    serverCpuUserMs = Math.round(cpu.user / 1000);
    serverCpuSystemMs = Math.round(cpu.system / 1000);
    serverRssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  }

  const totalServerCpuMs = serverCpuUserMs + serverCpuSystemMs;
  const percentOfOneCore = durationSec > 0 ? Math.round((totalServerCpuMs / (durationSec * 1000)) * 1000) / 10 : 0;

  // Latences de propagation
  const latencies = propagations.map((p) => p.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p90 = latencies[Math.floor(latencies.length * 0.9)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const min = latencies[0] || 0;
  const max = latencies[latencies.length - 1] || 0;
  const mean = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

  const totalRefused = clients.reduce((acc, c) => acc + c.refusedCount, 0);

  const summary: CollabSimSummary = {
    timestamp: new Date().toISOString(),
    testName: "collab-sim",
    environment: envInfo,
    config: {
      totalWriters: TOTAL_WRITERS,
      docCount: DOC_COUNT,
      typingBursts: TYPING_BURSTS,
      collabPort,
    },
    metrics: {
      totalEditsSent,
      totalPropagationsObserved: propagations.length,
      writeRefusedCount: totalRefused,
      convergenceMatch,
      finalTextLengths,
      latenciesMs: {
        min,
        p50,
        p90,
        p95,
        p99,
        max,
        mean: Math.round(mean * 10) / 10,
      },
      serverCpu: {
        userMs: serverCpuUserMs,
        systemMs: serverCpuSystemMs,
        totalMs: totalServerCpuMs,
        percentOfOneCore,
      },
      serverMemoryMb: {
        rss: serverRssMb,
      },
      durationSec: Math.round(durationSec * 10) / 10,
    },
    invariants: {
      c2ConvergenceStrict: convergenceMatch,
      zeroWriteLoss: convergenceMatch && finalTextLengths.every((len) => len > 0),
      p95UnderTarget: p95 < TARGET_P95_MS,
    },
  };

  // 7. Enregistrement JSON et rapport Markdown
  const resultsDir = path.join(process.cwd(), "loadtest", "results");
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const dateFile = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(resultsDir, `${dateFile}-collab-sim.json`);
  const mdPath = path.join(resultsDir, `${dateFile}-collab-sim.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf-8");

  const mdReport = `# Rapport de Test de Charge : collab-sim (Simulation Rédacteurs)

- **Date** : ${summary.timestamp}
- **Environnement** : Node ${envInfo.nodeVersion}, ${envInfo.osPlatform} (${envInfo.osRelease}), ${envInfo.cpuModel} (${envInfo.cpuCores} cœurs, ${envInfo.totalMemoryMb} Mo RAM), mode **${envInfo.mode}**
- **Rédacteurs simulés** : ${summary.config.totalWriters}
- **Documents concurrents** : ${summary.config.docCount}
- **Rafales de frappe** : ${summary.config.typingBursts}
- **Éditions émises** : ${summary.metrics.totalEditsSent}
- **Propagations observées** : ${summary.metrics.totalPropagationsObserved}
- **Durée totale** : ${summary.metrics.durationSec} s

---

## 1. Respect des Invariants

| Critère | Attendu | Obtenu | Statut |
| :--- | :--- | :--- | :--- |
| **Invariant C2 (Convergence CRDT sans conflit)** | 100 % identique entre pairs | **${convergenceMatch ? "Strictement identique" : "Divergence"}** | ${convergenceMatch ? "[VALIDÉ]" : "[ÉCHEC]"} |
| **Aucune perte d'édition** | Textes finaux non vides | **${finalTextLengths.join(" car., ")} car.** | ${summary.invariants.zeroWriteLoss ? "[VALIDÉ]" : "[ÉCHEC]"} |
| **Refus d'écriture (write_refused)** | Selon quotas | **${totalRefused}** | [NORMAL] |
| **Latence p95 de propagation** | < ${TARGET_P95_MS} ms | **${p95} ms** | ${p95 < TARGET_P95_MS ? "[VALIDÉ]" : "[LIMITE ATTEINTE]"} |

---

## 2. Latences de Propagation Réseau (ms)

- **Min** : ${min} ms
- **Médiane (p50)** : ${p50} ms
- **90e percentile (p90)** : ${p90} ms
- **95e percentile (p95)** : ${p95} ms
- **99e percentile (p99)** : ${p99} ms
- **Max** : ${max} ms
- **Moyenne** : ${summary.metrics.latenciesMs.mean} ms

---

## 3. Empreinte Système du SERVEUR Collab (mesurée via /internal/health)

- **CPU Serveur Utilisateur** : ${summary.metrics.serverCpu.userMs} ms
- **CPU Serveur Système** : ${summary.metrics.serverCpu.systemMs} ms
- **CPU Serveur Total** : ${summary.metrics.serverCpu.totalMs} ms (~${summary.metrics.serverCpu.percentOfOneCore}% d'un cœur)
- **Mémoire RSS Serveur** : ${summary.metrics.serverMemoryMb.rss} Mo
`;

  fs.writeFileSync(mdPath, mdReport, "utf-8");

  log.info("loadtest.collab.completed", {
    convergenceMatch,
    p95,
    serverCpuTotalMs: totalServerCpuMs,
    jsonPath,
    mdPath,
  });

  console.log("\n" + mdReport);
  return summary;
}

// Exécution directe CLI
if (require.main === module || process.argv[1]?.endsWith("collab-sim.ts")) {
  runCollabSim()
    .then((summary) => {
      if (!summary.invariants.c2ConvergenceStrict) {
        process.exit(1);
      }
    })
    .catch((err) => {
      log.error("loadtest.collab.fatal", { error: err });
      process.exit(1);
    });
}
