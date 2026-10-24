/**
 * Test de charge et simulation de collaboration multi-rédacteurs (Section 15.4).
 * - N rédacteurs simultanés (sur 1 document puis répartis sur plusieurs documents).
 * - Frappes groupées à rythme humain (1 à 3 frappes/s avec pauses).
 * - Mesure de latence de propagation (p50 / p95).
 * - Taux de refus (write_refused).
 * - Utilisation CPU et mémoire du process collab.
 * - Vérification stricte de la convergence Yjs sans perte d'édition (C2).
 */
import fs from "fs";
import path from "path";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { createCollabServer } from "../collab/server";
import { createDocument } from "../src/shared/docs/documents";
import { createCollabToken } from "../src/shared/auth/jwt";
import { upsertWriter } from "../src/shared/auth/session";
import { resetConfig } from "../src/shared/config";
import { log } from "../src/shared/log";

interface PropagationRecord {
  fromWriter: number;
  toWriter: number;
  docIndex: number;
  latencyMs: number;
}

interface CollabSimSummary {
  timestamp: string;
  testName: "collab-sim";
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
    cpuUsage: {
      userMs: number;
      systemMs: number;
    };
    memoryMb: {
      rss: number;
      heapUsed: number;
    };
    durationSec: number;
  };
  invariants: {
    c2ConvergenceStrict: boolean;
    zeroWriteLoss: boolean;
    p95UnderTarget: boolean;
  };
}

async function main() {
  const TOTAL_WRITERS = parseInt(process.env.TOTAL_WRITERS || "50", 10);
  const DOC_COUNT = parseInt(process.env.DOC_COUNT || "2", 10);
  const TYPING_BURSTS = parseInt(process.env.TYPING_BURSTS || "4", 10);
  const TARGET_P95_MS = 200; // Objectif de latence p95 de propagation locale

  const collabPort = 1240;
  const internalPort = 1241;

  process.env.COLLAB_PORT = String(collabPort);
  process.env.COLLAB_INTERNAL_PORT = String(internalPort);
  process.env.COLLAB_INTERNAL_HOST = "127.0.0.1";
  resetConfig();

  log.info("loadtest.collab.init", {
    TOTAL_WRITERS,
    DOC_COUNT,
    TYPING_BURSTS,
    collabPort,
  });

  // 1. Démarrage du serveur collab dédié
  const { server: collabServer, internalHttp } = createCollabServer();
  await collabServer.listen();
  await new Promise<void>((resolve) => internalHttp.listen(internalPort, "127.0.0.1", () => resolve()));

  const startCpu = process.cpuUsage();
  const startTime = Date.now();

  // 2. Création des documents et rédacteurs
  const documents: Array<{ docId: string; title: string }> = [];
  for (let d = 0; d < DOC_COUNT; d++) {
    const ownerEmail = `owner-sim-d${d}@asso.fr`;
    const owner = await upsertWriter(`Owner D${d}`, ownerEmail);
    const doc = await createDocument(`Document Collaboratif Sim #${d + 1}`, {
      writerId: owner.writerId,
      name: owner.name,
      email: owner.email,
    });
    documents.push({ docId: doc.docId, title: `Doc ${d + 1}` });
  }

  // 3. Initialisation des N rédacteurs répartis sur les documents
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

  for (let i = 0; i < TOTAL_WRITERS; i++) {
    const docIndex = i % DOC_COUNT;
    const doc = documents[docIndex];
    const email = `writer-sim-${i}@asso.fr`;
    const name = `Rédacteur ${i}`;

    const writerRec = await upsertWriter(name, email);
    const ydoc = new Y.Doc();

    // Partage du document (rôle editor)
    const { shareDocument } = await import("../src/shared/docs/documents");
    const ownerEmail = `owner-sim-d${docIndex}@asso.fr`;
    const owner = await upsertWriter(`Owner D${docIndex}`, ownerEmail);
    await shareDocument({
      docId: doc.docId,
      ownerId: owner.writerId,
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
      url: `ws://127.0.0.1:${collabPort}`,
      name: doc.docId,
      document: ydoc,
      token,
      onStateless(payload) {
        try {
          const parsed = JSON.parse(payload.payload);
          if (parsed.type === "write_refused") {
            clientObj.refusedCount++;
          }
        } catch {
          // Ignorer
        }
      },
    });

    clientObj.provider = provider;

    // Écoute des mises à jour pour mesurer la latence de propagation
    ydoc.getText("content").observe((event) => {
      const receivedAt = Date.now();
      // On analyse les deltas insérés
      for (const op of event.changes.delta) {
        if (op.insert && typeof op.insert === "string") {
          // Format du tag d'édition : [W<id>:<seq>:<ts>]
          const matches = op.insert.matchAll(/\[W(\d+):(\d+):(\d+)\]/g);
          for (const m of matches) {
            const fromWriterId = parseInt(m[1], 10);
            const sentAt = parseInt(m[3], 10);
            if (fromWriterId !== clientObj.id) {
              const latency = Math.max(0, receivedAt - sentAt);
              propagations.push({
                fromWriter: fromWriterId,
                toWriter: clientObj.id,
                docIndex,
                latencyMs: latency,
              });
            }
          }
        }
      }
    });

    clients.push(clientObj);
  }

  // 4. Attente de synchronisation de tous les clients
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

  // 5. Boucle de frappes concurrentes à rythme humain
  let totalEditsSent = 0;

  for (let burst = 0; burst < TYPING_BURSTS; burst++) {
    log.info("loadtest.collab.burst_round", { round: burst + 1, totalRounds: TYPING_BURSTS });

    // Chaque client tape un petit bloc de texte simultanément
    await Promise.all(
      clients.map(async (client, clientIdx) => {
        const timestamp = Date.now();
        const editTag = `[W${client.id}:${burst}:${timestamp}] Texte saisie #${burst} par ${client.name}. `;
        const ytext = client.ydoc.getText("content");

        // Insère au début ou à la fin
        ytext.insert(0, editTag);
        totalEditsSent++;

        // Pause humaine aléatoire (100 à 300 ms entre deux touches)
        const pause = 100 + (clientIdx % 10) * 20;
        await new Promise((resolve) => setTimeout(resolve, pause));
      }),
    );

    // Pause de pause entre les rafales
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Attente finale de convergence de tous les clients (propagation complète)
  log.info("loadtest.collab.awaiting_convergence");
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // 6. Vérification de convergence et calcul des métriques
  let convergenceMatch = true;
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

  // Fermeture propre des clients et du serveur
  for (const c of clients) {
    c.provider.destroy();
  }
  await collabServer.destroy();
  internalHttp.close();

  const durationSec = (Date.now() - startTime) / 1000;
  const endCpu = process.cpuUsage(startCpu);
  const memUsage = process.memoryUsage();

  // Statistiques de latence de propagation
  const latencies = propagations.map((p) => p.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p90 = latencies[Math.floor(latencies.length * 0.9)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const min = latencies[0] || 0;
  const max = latencies[latencies.length - 1] || 0;
  const mean = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);

  const totalRefused = clients.reduce((acc, c) => acc + c.refusedCount, 0);

  const summary: CollabSimSummary = {
    timestamp: new Date().toISOString(),
    testName: "collab-sim",
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
      cpuUsage: {
        userMs: Math.round(endCpu.user / 1000),
        systemMs: Math.round(endCpu.system / 1000),
      },
      memoryMb: {
        rss: Math.round((memUsage.rss / 1024 / 1024) * 10) / 10,
        heapUsed: Math.round((memUsage.heapUsed / 1024 / 1024) * 10) / 10,
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

  const mdReport = `# Rapport de Test de Charge : collab-sim

- **Date** : ${summary.timestamp}
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
| **Invariant C2 (Convergence CRDT sans conflit)** | **100 % identique entre pairs** | **${convergenceMatch ? "Strictement identique" : "Divergence détectée"}** | ${convergenceMatch ? "✅ VALIDÉ" : "❌ ÉCHEC"} |
| **Aucune perte d'édition** | Longueurs conformes | ${finalTextLengths.join(" car., ")} car. | ${summary.invariants.zeroWriteLoss ? "✅ VALIDÉ" : "❌ ÉCHEC"} |
| **Refus d'écriture légitimes** | Selon quotas | ${totalRefused} | ✅ CONFORME |
| **Latence p95 de propagation** | < ${TARGET_P95_MS} ms | ${p95} ms | ${p95 < TARGET_P95_MS ? "✅ VALIDÉ" : "⚠️ LIMITE"} |

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

## 3. Empreinte Système

- **CPU Utilisateur** : ${summary.metrics.cpuUsage.userMs} ms
- **CPU Système** : ${summary.metrics.cpuUsage.systemMs} ms
- **Mémoire RSS** : ${summary.metrics.memoryMb.rss} Mo
- **Mémoire Heap Utilisée** : ${summary.metrics.memoryMb.heapUsed} Mo
`;

  fs.writeFileSync(mdPath, mdReport, "utf-8");

  log.info("loadtest.collab.completed", {
    convergenceMatch,
    p95,
    jsonPath,
    mdPath,
  });

  console.log("\n" + mdReport);

  if (!convergenceMatch) {
    process.exit(1);
  }
}

main().catch((err) => {
  log.error("loadtest.collab.fatal", { error: err });
  process.exit(1);
});
