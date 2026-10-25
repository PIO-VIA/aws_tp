import { NextRequest, NextResponse } from "next/server";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient } from "@/src/shared/aws/dynamodb";
import { tableName, getConfig } from "@/src/shared/config";
import { timingSafeCompare } from "@/src/shared/auth/jwt";
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
 * POST /api/admin/unblock (Section 6.5)
 * Débloque un rédacteur en levant la sanction d'abus.
 */
export async function POST(request: NextRequest) {
  const config = getConfig();
  const token = extractAdminToken(request);

  if (!timingSafeCompare(token, config.ADMIN_TOKEN)) {
    return NextResponse.json(
      { error: "Accès refusé : token administrateur invalide" },
      { status: 401 },
    );
  }

  let body: { writerId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps JSON invalide" }, { status: 400 });
  }

  const writerId = body.writerId?.trim();
  if (!writerId) {
    return NextResponse.json({ error: "writerId obligatoire" }, { status: 400 });
  }

  const docClient = getDocClient();
  const writersTable = tableName("writers");

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: writersTable,
        Key: { writerId },
        UpdateExpression: "REMOVE blockedUntil, blockReason, blockedReason",
      }),
    );

    log.info("admin.writer.unblocked", { writerId });
    return NextResponse.json({ unblocked: true, writerId });
  } catch (err: unknown) {
    log.error("admin.unblock.failed", { writerId, error: err });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur déblocage" },
      { status: 500 },
    );
  }
}
