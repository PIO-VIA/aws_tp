/**
 * Script de test de fumée (Smoke test) de validation de bout en bout.
 * Exécutable contre l'environnement local ou contre le domaine CloudFront en production.
 *
 * Usage :
 *   npm run smoke -- --base-url https://xxx.cloudfront.net
 *   npm run smoke -- --base-url http://localhost:3000
 */
import { log } from "../src/shared/log";
import crypto from "crypto";

interface CommandLineArgs {
  baseUrl: string;
}

function parseArgs(): CommandLineArgs {
  const args = process.argv.slice(2);
  let baseUrl = "http://localhost:3000";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && i + 1 < args.length) {
      baseUrl = args[i + 1].replace(/\/+$/, "");
      i++;
    }
  }

  return { baseUrl };
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { baseUrl } = parseArgs();
  log.info("smoke.started", { baseUrl });

  const testEmail = `smoke-${Date.now()}@asso.fr`;
  const testName = "Testeur Automatique";

  // 1. Authentification / création de session rédacteur
  log.info("smoke.step1_auth", { testEmail });
  const authRes = await fetch(`${baseUrl}/api/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
    },
    body: JSON.stringify({ name: testName, email: testEmail }),
  });

  if (!authRes.ok) {
    throw new Error(`Échec de création de session: HTTP ${authRes.status} ${await authRes.text()}`);
  }

  const setCookie = authRes.headers.get("set-cookie") || "";
  const sessionCookie = setCookie.split(";")[0];
  if (!sessionCookie) {
    throw new Error("Aucun cookie de session reçu");
  }

  const authHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: sessionCookie,
    Origin: baseUrl,
  };

  // 2. Création d'un document
  log.info("smoke.step2_create_document");
  const docRes = await fetch(`${baseUrl}/api/documents`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ title: `Smoke Test Doc ${Date.now()}` }),
  });

  if (!docRes.ok) {
    throw new Error(`Échec création document: HTTP ${docRes.status} ${await docRes.text()}`);
  }

  const docData = (await docRes.json()) as { docId: string };
  const docId = docData.docId;
  log.info("smoke.document_created", { docId });

  // 3. Création d'un lien de téléchargement avec 3 exemplaires max
  log.info("smoke.step3_create_link", { docId, maxDownloads: 3 });
  const linkRes = await fetch(`${baseUrl}/api/documents/${docId}/links`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ maxDownloads: 3 }),
  });

  if (!linkRes.ok) {
    throw new Error(`Échec création lien: HTTP ${linkRes.status} ${await linkRes.text()}`);
  }

  const linkData = (await linkRes.json()) as { linkId: string; maxDownloads: number };
  const linkId = linkData.linkId;
  log.info("smoke.link_created", { linkId, maxDownloads: linkData.maxDownloads });

  // 4. Lancement de 5 requêtes de téléchargement concurrentes
  log.info("smoke.step4_issue_downloads", { count: 5 });
  const downloadRequests = Array.from({ length: 5 }, (_, i) => ({
    requestId: crypto.randomUUID(),
    index: i + 1,
  }));

  const results = await Promise.all(
    downloadRequests.map(async ({ requestId, index }) => {
      try {
        const reqRes = await fetch(`${baseUrl}/api/dl/${linkId}/request`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ requestId }),
        });

        const reqBody = (await reqRes.json()) as {
          state?: string;
          reservationId?: string;
          downloadUrl?: string;
          error?: { code: string; message: string };
        };

        if (reqRes.status === 410 || reqBody.state === "exhausted" || reqBody.error?.code === "exhausted") {
          return { index, status: "exhausted" as const, url: null };
        }

        if (reqRes.status === 200 && reqBody.downloadUrl) {
          return { index, status: "issued" as const, url: reqBody.downloadUrl };
        }

        if (reqBody.reservationId) {
          // Polling jusqu'à complétion
          for (let p = 0; p < 20; p++) {
            await sleep(1000);
            const pollRes = await fetch(
              `${baseUrl}/api/dl/${linkId}/reservations/${reqBody.reservationId}`,
            );
            const pollBody = (await pollRes.json()) as {
              state?: string;
              downloadUrl?: string;
            };

            if (pollRes.status === 200 && pollBody.downloadUrl) {
              return { index, status: "issued" as const, url: pollBody.downloadUrl };
            }
            if (pollRes.status === 410 || pollBody.state === "exhausted") {
              return { index, status: "exhausted" as const, url: null };
            }
          }
        }

        return { index, status: "unknown" as const, url: null, raw: reqBody };
      } catch (err) {
        return { index, status: "error" as const, url: null, error: String(err) };
      }
    }),
  );

  const issued = results.filter((r) => r.status === "issued");
  const exhausted = results.filter((r) => r.status === "exhausted");

  log.info("smoke.downloads_result", {
    issuedCount: issued.length,
    exhaustedCount: exhausted.length,
    total: results.length,
  });

  if (issued.length !== 3) {
    throw new Error(
      `INVARIANT C1 NON RESPECTÉ : Attendu 3 URL émises, obtenu ${issued.length} (détail: ${JSON.stringify(results)})`,
    );
  }

  if (exhausted.length !== 2) {
    throw new Error(
      `INVARIANT C1 NON RESPECTÉ : Attendu 2 épuisés, obtenu ${exhausted.length} (détail: ${JSON.stringify(results)})`,
    );
  }

  // 5. Téléchargement effectif d'un PDF et vérification des octets magiques %PDF-
  const firstUrl = issued[0].url!;
  log.info("smoke.step5_download_pdf", { urlSnippet: firstUrl.substring(0, 60) });

  const pdfRes = await fetch(firstUrl);
  if (!pdfRes.ok) {
    throw new Error(`Échec du téléchargement du PDF pré-signé: HTTP ${pdfRes.status}`);
  }

  const pdfBuffer = await pdfRes.arrayBuffer();
  const magic = Buffer.from(pdfBuffer).subarray(0, 5).toString("utf-8");

  log.info("smoke.pdf_magic_verified", {
    magic,
    sizeBytes: pdfBuffer.byteLength,
  });

  if (magic !== "%PDF-") {
    throw new Error(`En-tête PDF invalide : attendu "%PDF-", obtenu "${magic}"`);
  }

  log.info("smoke.success", {
    message: "Le test de fumée s'est terminé avec un succès total !",
    checks: {
      sessionCreated: true,
      documentCreated: true,
      linkConfigured: "3 copies",
      issuedUrls: 3,
      exhaustedRequests: 2,
      pdfMagicBytesVerified: true,
    },
  });
}

main().catch((err) => {
  log.error("smoke.failed", { error: err });
  console.error("\n================================================================================");
  console.error("ÉCHEC DU SMOKE TEST — DÉPLOIEMENT NON VALIDÉ");
  console.error("Commande de retour arrière immédiat :");
  console.error("  ./scripts/deploy/rollback-ec2.sh <tag_precedent> [instance_id] [region]");
  console.error("================================================================================\n");
  process.exit(1);
});
