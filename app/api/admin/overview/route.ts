import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient, scanAll } from "@/src/shared/aws/dynamodb";
import { tableName, getConfig } from "@/src/shared/config";
import { timingSafeCompare } from "@/src/shared/auth/jwt";
import { LinkRecord } from "@/src/shared/links/types";
import { DocumentRecord } from "@/src/shared/docs/documents";
import { WriterRecord } from "@/src/shared/auth/session";
import { log } from "@/src/shared/log";

function extractAdminToken(req: NextRequest): string {
  const authHeader = req.headers.get("authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  const customHeader = req.headers.get("x-admin-token");
  if (customHeader) return customHeader.trim();
  return "";
}

/**
 * GET /api/admin/overview (Section 6.5, F10)
 * Retourne les 3 listes de supervision : openDocuments, activeLinks, blockedWriters.
 */
export async function GET(request: NextRequest) {
  const config = getConfig();
  const token = extractAdminToken(request);

  if (!timingSafeCompare(token, config.ADMIN_TOKEN)) {
    return NextResponse.json(
      { error: "Accès refusé : token administrateur invalide" },
      { status: 401 },
    );
  }

  const docClient = getDocClient();
  const now = Math.floor(Date.now() / 1000);

  try {
    // 1. Documents ouverts (interrogation du serveur interne collab)
    let openDocsRaw: Array<{ docId: string; connections: number; lastActivityAt: number }> = [];
    try {
      const collabRes = await fetch(
        `http://${config.COLLAB_INTERNAL_HOST}:${config.COLLAB_INTERNAL_PORT}/internal/open-documents`,
        {
          headers: { "x-internal-token": config.INTERNAL_TOKEN },
        },
      );
      if (collabRes.ok) {
        const body = (await collabRes.json()) as {
          openDocuments: Array<{ docId: string; connections: number; lastActivityAt: number }>;
        };
        openDocsRaw = body.openDocuments || [];
      }
    } catch (collabErr) {
      log.warn("admin.overview.collab_fetch_failed", { error: collabErr });
    }

    // Enrichissement des titres de documents ouverts
    const openDocuments = await Promise.all(
      openDocsRaw.map(async (od) => {
        let title = "Document sans titre";
        try {
          const docRes = await docClient.send(
            new GetCommand({
              TableName: tableName("documents"),
              Key: { docId: od.docId },
            }),
          );
          if (docRes.Item) {
            title = (docRes.Item as DocumentRecord).title;
          }
        } catch {
          // Fallback
        }
        return {
          docId: od.docId,
          title,
          connections: od.connections,
          lastActivityAt: od.lastActivityAt || now,
        };
      }),
    );

    // 2. Liens actifs (scan paginé C-06)
    const linksItems = await scanAll<LinkRecord>({
      TableName: tableName("links"),
      FilterExpression: "#st = :active",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: { ":active": "active" },
    });

    const activeLinks = await Promise.all(
      linksItems.map(async (l) => {
        let docTitle = "Document";
        try {
          const docRes = await docClient.send(
            new GetCommand({
              TableName: tableName("documents"),
              Key: { docId: l.docId },
            }),
          );
          if (docRes.Item) {
            docTitle = (docRes.Item as DocumentRecord).title;
          }
        } catch {
          // Fallback
        }
        return {
          linkId: l.linkId,
          docId: l.docId,
          title: docTitle,
          maxDownloads: l.maxDownloads,
          issued: l.issued,
          remaining: Math.max(0, l.maxDownloads - l.issued),
          creator: l.creatorName || l.creatorEmail,
        };
      }),
    );

    // 3. Rédacteurs bloqués (scan paginé C-06)
    const writersItems = await scanAll<WriterRecord & { blockedReason?: string }>({
      TableName: tableName("writers"),
      FilterExpression: "attribute_exists(blockedUntil) AND blockedUntil > :now",
      ExpressionAttributeValues: { ":now": now },
    });

    const blockedWriters = writersItems.map((w) => ({
      writerId: w.writerId,
      name: w.name,
      email: w.email,
      blockedUntil: w.blockedUntil!,
      reason: w.blockedReason || "Activité suspecte répétée (dépassements de quota ou requêtes trop volumineuses)",
    }));

    return NextResponse.json({
      openDocuments,
      activeLinks,
      blockedWriters,
    });
  } catch (err: unknown) {
    log.error("admin.overview.error", { error: err });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur vue d'ensemble" },
      { status: 500 },
    );
  }
}
