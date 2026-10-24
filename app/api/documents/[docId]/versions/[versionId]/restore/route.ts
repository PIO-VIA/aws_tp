import { NextRequest, NextResponse } from "next/server";
import { authenticateSession } from "@/src/shared/auth/session";
import { getDocumentPermission } from "@/src/shared/docs/documents";
import { requestRestore } from "@/src/shared/docs/history";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ docId: string; versionId: string }> },
) {
  const session = await authenticateSession(request);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const { docId, versionId } = await context.params;
  const perm = await getDocumentPermission(docId, session.writerId);
  if (!perm || perm.role === "viewer") {
    return NextResponse.json(
      { error: "Droits insuffisants pour restaurer ce document" },
      { status: 403 },
    );
  }

  try {
    const res = await requestRestore(docId, versionId, session.writerId);
    return NextResponse.json(res);
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur restauration" },
      { status: 400 },
    );
  }
}
