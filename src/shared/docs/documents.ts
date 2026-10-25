import {
  GetCommand,
  QueryCommand,
  DeleteCommand,
  TransactWriteCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { getDocClient, scanAll } from "../aws/dynamodb";
import { tableName } from "../config";
import { hashEmail, SessionPayload } from "../auth/jwt";
import { LinkRecord } from "../links/types";
import { log } from "../log";
import { getWriterQuota } from "../quota/quota";

export type DocumentRole = "owner" | "editor" | "viewer";

export interface DocumentRecord {
  docId: string;
  title: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
}

export interface DocumentPermissionRecord {
  docId: string;
  writerId: string;
  email: string;
  name: string;
  role: DocumentRole;
  createdAt: number;
}

export interface DocumentWithRole {
  docId: string;
  title: string;
  ownerId: string;
  role: DocumentRole;
  createdAt: number;
  updatedAt: number;
}

/**
 * Crée un document et accorde immédiatement le rôle 'owner' à son créateur (atomique).
 */
export async function createDocument(
  title: string,
  writer: SessionPayload,
): Promise<{ docId: string }> {
  const docClient = getDocClient();
  const docsTable = tableName("documents");
  const permsTable = tableName("doc_permissions");
  const docId = `doc-${randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);

  const cleanTitle = title.trim() || "Document sans titre";

  await docClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: docsTable,
            Item: {
              docId,
              title: cleanTitle,
              ownerId: writer.writerId,
              createdAt: now,
              updatedAt: now,
              lastActivityAt: now,
            },
            ConditionExpression: "attribute_not_exists(docId)",
          },
        },
        {
          Put: {
            TableName: permsTable,
            Item: {
              docId,
              writerId: writer.writerId,
              email: writer.email,
              name: writer.name,
              role: "owner" as DocumentRole,
              createdAt: now,
            },
            ConditionExpression: "attribute_not_exists(docId)",
          },
        },
      ],
    }),
  );

  log.info("document.created", { docId, ownerId: writer.writerId });
  return { docId };
}

/**
 * Vérifie et retourne le rôle d'un rédacteur sur un document.
 */
export async function getDocumentPermission(
  docId: string,
  writerId: string,
): Promise<DocumentPermissionRecord | null> {
  const docClient = getDocClient();
  const permsTable = tableName("doc_permissions");

  const res = await docClient.send(
    new GetCommand({
      TableName: permsTable,
      Key: { docId, writerId },
    }),
  );

  return (res.Item as DocumentPermissionRecord) ?? null;
}

/**
 * Récupère les métadonnées d'un document si le rédacteur a une permission.
 */
export async function getDocumentForUser(
  docId: string,
  writerId: string,
): Promise<{ meta: DocumentRecord; role: DocumentRole } | null> {
  const perm = await getDocumentPermission(docId, writerId);
  if (!perm) return null;

  const docClient = getDocClient();
  const docsTable = tableName("documents");

  const res = await docClient.send(
    new GetCommand({
      TableName: docsTable,
      Key: { docId },
    }),
  );

  if (!res.Item) return null;

  return {
    meta: res.Item as DocumentRecord,
    role: perm.role,
  };
}

/**
 * Liste tous les documents accessibles pour un rédacteur (GSI by_writer).
 */
export async function listUserDocuments(writerId: string): Promise<DocumentWithRole[]> {
  const docClient = getDocClient();
  const permsTable = tableName("doc_permissions");
  const docsTable = tableName("documents");

  // Query sur GSI by_writer
  const permsRes = await docClient.send(
    new QueryCommand({
      TableName: permsTable,
      IndexName: "by_writer",
      KeyConditionExpression: "writerId = :w",
      ExpressionAttributeValues: { ":w": writerId },
    }),
  );

  const permissions = (permsRes.Items as DocumentPermissionRecord[]) ?? [];
  if (permissions.length === 0) return [];

  // Récupération des métadonnées de chaque document
  const results: DocumentWithRole[] = [];
  for (const perm of permissions) {
    const docRes = await docClient.send(
      new GetCommand({
        TableName: docsTable,
        Key: { docId: perm.docId },
      }),
    );
    if (docRes.Item) {
      const doc = docRes.Item as DocumentRecord;
      results.push({
        docId: doc.docId,
        title: doc.title,
        ownerId: doc.ownerId,
        role: perm.role,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      });
    }
  }

  // Tri par updatedAt décroissant
  return results.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Partage un document avec un autre rédacteur (owner seulement).
 */
export async function shareDocument(params: {
  docId: string;
  ownerId: string;
  targetEmail: string;
  targetName?: string;
  role: "editor" | "viewer";
}): Promise<{ targetWriterId: string }> {
  // 1. Vérification que le demandeur est propriétaire
  const ownerPerm = await getDocumentPermission(params.docId, params.ownerId);
  if (!ownerPerm || ownerPerm.role !== "owner") {
    throw new Error("Seul le propriétaire peut partager le document");
  }

  const targetEmailNorm = params.targetEmail.trim().toLowerCase();
  const targetWriterId = hashEmail(targetEmailNorm);
  const now = Math.floor(Date.now() / 1000);

  const docClient = getDocClient();
  const permsTable = tableName("doc_permissions");

  await docClient.send(
    new PutCommand({
      TableName: permsTable,
      Item: {
        docId: params.docId,
        writerId: targetWriterId,
        email: targetEmailNorm,
        name: params.targetName || targetEmailNorm.split("@")[0],
        role: params.role,
        createdAt: now,
      },
    }),
  );

  log.info("document.shared", {
    docId: params.docId,
    targetEmail: targetEmailNorm,
    role: params.role,
  });

  return { targetWriterId };
}

/**
 * Retire le partage d'un document (owner seulement).
 */
export async function unshareDocument(
  docId: string,
  ownerId: string,
  targetWriterId: string,
): Promise<boolean> {
  const ownerPerm = await getDocumentPermission(docId, ownerId);
  if (!ownerPerm || ownerPerm.role !== "owner") {
    throw new Error("Seul le propriétaire peut modifier les partages");
  }

  if (targetWriterId === ownerId) {
    throw new Error("Le propriétaire ne peut pas retirer ses propres droits");
  }

  const docClient = getDocClient();
  const permsTable = tableName("doc_permissions");

  await docClient.send(
    new DeleteCommand({
      TableName: permsTable,
      Key: { docId, writerId: targetWriterId },
    }),
  );

  log.info("document.unshared", { docId, targetWriterId });
  return true;
}

/**
 * Liste les liens de téléchargement associés à un document (owner ou editor requis).
 */
export async function listDocumentLinks(
  docId: string,
  writerId: string,
): Promise<Array<LinkRecord & { remaining: number }>> {
  const perm = await getDocumentPermission(docId, writerId);
  if (!perm || perm.role === "viewer") {
    throw new Error("Droits insuffisants pour voir les liens");
  }

  const linksTable = tableName("links");

  // Scan paginé filtré par docId (C-06)
  const items = await scanAll<LinkRecord>({
    TableName: linksTable,
    FilterExpression: "docId = :docId",
    ExpressionAttributeValues: { ":docId": docId },
  });

  return items.map((l) => ({
    ...l,
    remaining: Math.max(0, l.maxDownloads - l.issued),
  }));
}

/**
 * Récupère un document par son identifiant sans contrôle de permission utilisateur (usage système / admin).
 */
export async function getDocumentById(docId: string): Promise<DocumentRecord | null> {
  const docClient = getDocClient();
  const docsTable = tableName("documents");
  const res = await docClient.send(
    new GetCommand({
      TableName: docsTable,
      Key: { docId },
    }),
  );
  return (res.Item as DocumentRecord) ?? null;
}

export interface DocumentEditorWithCredit {
  writerId: string;
  name: string;
  email: string;
  role: DocumentRole;
  createdAt: number;
  credit: {
    used: number;
    remaining: number;
    dailyLimit: number;
    resetAt: number;
  };
}

/**
 * Récupère la liste des rédacteurs autorisés sur un document ainsi que leur crédit d'écriture restant.
 * Seul le propriétaire du document peut exécuter cette requête.
 */
export async function listDocumentEditorsWithCredits(
  docId: string,
  requesterId: string,
): Promise<DocumentEditorWithCredit[]> {
  const perm = await getDocumentPermission(docId, requesterId);
  if (!perm || perm.role !== "owner") {
    throw new Error("Seul le propriétaire peut consulter les rédacteurs et leurs crédits");
  }

  const docClient = getDocClient();
  const permsTable = tableName("doc_permissions");

  const res = await docClient.send(
    new QueryCommand({
      TableName: permsTable,
      KeyConditionExpression: "docId = :docId",
      ExpressionAttributeValues: { ":docId": docId },
    }),
  );

  const permissions = (res.Items as DocumentPermissionRecord[]) ?? [];

  const results = await Promise.all(
    permissions.map(async (p) => {
      const quota = await getWriterQuota(p.writerId);
      return {
        writerId: p.writerId,
        name: p.name,
        email: p.email,
        role: p.role,
        createdAt: p.createdAt,
        credit: {
          used: quota.used,
          remaining: quota.remaining,
          dailyLimit: quota.dailyLimit,
          resetAt: quota.resetAt,
        },
      };
    }),
  );

  return results.sort((a, b) => {
    if (a.role === "owner" && b.role !== "owner") return -1;
    if (b.role === "owner" && a.role !== "owner") return 1;
    return a.name.localeCompare(b.name);
  });
}

