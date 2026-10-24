/**
 * Seed local : crée 3 rédacteurs, 1 document avec contenu initial, 1 lien de 3 exemplaires.
 * Conforme à la section 14.3 et 14.4 (1) de la spécification.
 */
import * as Y from "yjs";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { upsertWriter } from "../src/shared/auth/session";
import { createDocument, shareDocument } from "../src/shared/docs/documents";
import { createLink } from "../src/shared/links/links";
import { getDocClient } from "../src/shared/aws/dynamodb";
import { tableName } from "../src/shared/config";
import { getHead } from "../src/shared/docs/head";
import { log } from "../src/shared/log";

async function main() {
  log.info("seed.started", { mode: "local" });

  // 1. Création des 3 rédacteurs
  const alice = await upsertWriter("Alice Dupont", "alice@asso.fr");
  const bob = await upsertWriter("Bob Martin", "bob@asso.fr");
  const charlie = await upsertWriter("Charlie Dubois", "charlie@asso.fr");

  console.log("Rédacteurs créés :");
  console.log(` - Alice (owner)   : ${alice.email} (${alice.writerId})`);
  console.log(` - Bob (editor)    : ${bob.email} (${bob.writerId})`);
  console.log(` - Charlie (viewer): ${charlie.email} (${charlie.writerId})`);

  // 2. Création d'un document par Alice
  const { docId } = await createDocument("Journal Étudiant — Édition Spéciale", {
    writerId: alice.writerId,
    name: alice.name,
    email: alice.email,
  });
  console.log(`\nDocument créé : ${docId}`);

  // 3. Partage du document avec Bob (editor) et Charlie (viewer)
  await shareDocument({
    docId,
    ownerId: alice.writerId,
    targetEmail: bob.email,
    targetName: bob.name,
    role: "editor",
  });
  console.log(` - Partagé avec Bob (${bob.email}) en rôle: editor`);

  await shareDocument({
    docId,
    ownerId: alice.writerId,
    targetEmail: charlie.email,
    targetName: charlie.name,
    role: "viewer",
  });
  console.log(` - Partagé avec Charlie (${charlie.email}) en rôle: viewer`);

  // 4. Insertion de contenu initial via un update Yjs durable dans doc_updates
  const initialText =
    "============================================================\n" +
    "LE JOURNAL ÉTUDIANT — ÉDITION SPÉCIALE\n" +
    "Association des Étudiants AWS — 2026\n" +
    "============================================================\n\n" +
    "Bienvenue dans cette édition spéciale diffusée en tirage limité !\n\n" +
    "Cet éditeur de documents collaboratif intègre :\n" +
    "- Synchronisation en temps réel avec CRDT Yjs sans conflit d'édition\n" +
    "- Invariant strict C1 : aucune copie excédentaire délivrée\n" +
    "- Rendu PDF fidèle et déterministe avec police DejaVu Sans\n" +
    "- Quota quotidien de 10 000 caractères par rédacteur\n\n" +
    "Bonne lecture et bonne collaboration à tous les étudiants !";

  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.insert(0, initialText);
  const updateBytes = Y.encodeStateAsUpdate(ydoc);

  const docClient = getDocClient();
  const now = Math.floor(Date.now() / 1000);
  await docClient.send(
    new PutCommand({
      TableName: tableName("doc_updates"),
      Item: {
        docId,
        seq: 1,
        update: Buffer.from(updateBytes),
        writerId: alice.writerId,
        billedChars: initialText.length,
        createdAt: now,
        ttl: now + 30 * 24 * 3600,
      },
      ConditionExpression: "attribute_not_exists(seq)",
    }),
  );
  console.log(` - Contenu initial injecté (${initialText.length} caractères UTF-16)`);

  // Calcul immédiat du Head pour valider la chaîne de rendu
  const head = await getHead(docId);
  console.log(` - Version courante (Head) générée : ${head.versionId}`);

  // 5. Création d'un lien de téléchargement limité à 3 exemplaires
  const link = await createLink({
    docId,
    creatorId: alice.writerId,
    creatorEmail: alice.email,
    creatorName: alice.name,
    maxDownloads: 3,
  });

  console.log(`\nLien de téléchargement public créé (3 exemplaires) :`);
  console.log(` - LinkId     : ${link.linkId}`);
  console.log(` - URL locale : http://localhost:3000/d/${link.linkId}`);

  console.log("\nSeed terminé avec succès !");
}

main().catch((err) => {
  log.error("seed.failed", { error: err });
  console.error("Erreur de seed:", err);
  process.exit(1);
});
