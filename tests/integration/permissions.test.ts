import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";
import { DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { initDynamoDBTables, initS3Bucket, initSQSQueues } from "../../scripts/local-init";
import { resetConfig, ALL_TABLES } from "@shared/config";
import { getDynamoDBClient, resetDynamoClients } from "@shared/aws/dynamodb";
import { resetS3Clients } from "@shared/aws/s3";
import {
  createDocument,
  getDocumentForUser,
  listUserDocuments,
  shareDocument,
  unshareDocument,
  listDocumentLinks,
  getDocumentPermission,
} from "@shared/docs/documents";
import { createLink } from "@shared/links/links";
import { upsertWriter } from "@shared/auth/session";

describe("Phase 2 — Permissions et cycle de vie des documents", () => {
  const testPrefix = `test-perm-${randomBytes(4).toString("hex")}-`;

  const alice = {
    writerId: "w-alice-id",
    name: "Alice",
    email: "alice@asso.fr",
  };

  const bob = {
    writerId: "w-bob-id",
    name: "Bob",
    email: "bob@asso.fr",
  };

  const charlie = {
    writerId: "w-charlie-id",
    name: "Charlie",
    email: "charlie@asso.fr",
  };

  beforeAll(async () => {
    process.env.APP_ENV = "local";
    process.env.TABLE_PREFIX = testPrefix;
    process.env.DDB_ENDPOINT = "http://localhost:8000";
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.S3_FORCE_PATH_STYLE = "true";
    process.env.S3_BUCKET = "editeur-local-data";
    process.env.SQS_ENDPOINT = "http://localhost:9324";
    process.env.PDF_QUEUE_URL = "http://localhost:9324/000000000000/pdf-jobs";
    process.env.PDF_DLQ_URL = "http://localhost:9324/000000000000/pdf-jobs-dlq";
    process.env.STREAM_MODE = "inline";

    resetConfig();
    resetDynamoClients();
    resetS3Clients();

    await initDynamoDBTables(testPrefix);
    await initS3Bucket();
    await initSQSQueues();

    // Enregistrement des rédacteurs
    const recAlice = await upsertWriter(alice.name, alice.email);
    alice.writerId = recAlice.writerId;

    const recBob = await upsertWriter(bob.name, bob.email);
    bob.writerId = recBob.writerId;

    const recCharlie = await upsertWriter(charlie.name, charlie.email);
    charlie.writerId = recCharlie.writerId;
  });

  afterAll(async () => {
    const ddb = getDynamoDBClient();
    for (const key of ALL_TABLES) {
      try {
        await ddb.send(new DeleteTableCommand({ TableName: `${testPrefix}${key}` }));
      } catch {
        // ignore
      }
    }
  });

  let createdDocId: string;

  it("1. Alice crée un document et obtient le rôle 'owner' atomiquement", async () => {
    const res = await createDocument("Journal de rentrée", alice);
    expect(res.docId).toBeDefined();
    createdDocId = res.docId;

    const docUser = await getDocumentForUser(createdDocId, alice.writerId);
    expect(docUser).not.toBeNull();
    expect(docUser?.meta.title).toBe("Journal de rentrée");
    expect(docUser?.meta.ownerId).toBe(alice.writerId);
    expect(docUser?.role).toBe("owner");

    const aliceDocs = await listUserDocuments(alice.writerId);
    expect(aliceDocs.length).toBe(1);
    expect(aliceDocs[0].docId).toBe(createdDocId);
    expect(aliceDocs[0].role).toBe("owner");
  });

  it("2. Bob et Charlie n'ont pas accès au document initialement", async () => {
    const bobAccess = await getDocumentForUser(createdDocId, bob.writerId);
    expect(bobAccess).toBeNull();

    const bobDocs = await listUserDocuments(bob.writerId);
    expect(bobDocs.length).toBe(0);
  });

  it("3. Alice partage le document avec Bob en rôle 'editor'", async () => {
    const shareRes = await shareDocument({
      docId: createdDocId,
      ownerId: alice.writerId,
      targetEmail: bob.email,
      targetName: bob.name,
      role: "editor",
    });
    expect(shareRes.targetWriterId).toBe(bob.writerId);

    const bobDoc = await getDocumentForUser(createdDocId, bob.writerId);
    expect(bobDoc).not.toBeNull();
    expect(bobDoc?.role).toBe("editor");

    const bobDocs = await listUserDocuments(bob.writerId);
    expect(bobDocs.length).toBe(1);
    expect(bobDocs[0].docId).toBe(createdDocId);
    expect(bobDocs[0].role).toBe("editor");
  });

  it("4. Bob (editor) ne peut pas partager le document (seul le owner le peut)", async () => {
    await expect(
      shareDocument({
        docId: createdDocId,
        ownerId: bob.writerId,
        targetEmail: charlie.email,
        role: "viewer",
      }),
    ).rejects.toThrow("Seul le propriétaire peut partager le document");
  });

  it("5. Alice partage le document avec Charlie en rôle 'viewer'", async () => {
    await shareDocument({
      docId: createdDocId,
      ownerId: alice.writerId,
      targetEmail: charlie.email,
      targetName: charlie.name,
      role: "viewer",
    });

    const charlieDoc = await getDocumentForUser(createdDocId, charlie.writerId);
    expect(charlieDoc).not.toBeNull();
    expect(charlieDoc?.role).toBe("viewer");

    // Charlie ne peut pas lister les liens de téléchargement
    await expect(listDocumentLinks(createdDocId, charlie.writerId)).rejects.toThrow(
      "Droits insuffisants pour voir les liens",
    );
  });

  it("6. Bob (editor) peut créer et voir un lien de téléchargement", async () => {
    const perm = await getDocumentPermission(createdDocId, bob.writerId);
    expect(perm?.role).toBe("editor");

    const link = await createLink({
      docId: createdDocId,
      creatorId: bob.writerId,
      creatorEmail: bob.email,
      creatorName: bob.name,
      maxDownloads: 50,
    });
    expect(link.linkId).toBeDefined();
    expect(link.maxDownloads).toBe(50);

    const links = await listDocumentLinks(createdDocId, bob.writerId);
    expect(links.length).toBe(1);
    expect(links[0].linkId).toBe(link.linkId);
    expect(links[0].remaining).toBe(50);
  });

  it("7. Alice révoque l'accès de Bob", async () => {
    const unshared = await unshareDocument(createdDocId, alice.writerId, bob.writerId);
    expect(unshared).toBe(true);

    const bobAccess = await getDocumentForUser(createdDocId, bob.writerId);
    expect(bobAccess).toBeNull();

    const bobDocs = await listUserDocuments(bob.writerId);
    expect(bobDocs.length).toBe(0);
  });

  it("8. Le propriétaire ne peut pas se retirer lui-même ses droits", async () => {
    await expect(
      unshareDocument(createdDocId, alice.writerId, alice.writerId),
    ).rejects.toThrow("Le propriétaire ne peut pas retirer ses propres droits");
  });
});
