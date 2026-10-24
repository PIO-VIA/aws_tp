import { NextRequest, NextResponse } from "next/server";
import { authenticateSession } from "@/src/shared/auth/session";
import { getDocumentPermission } from "@/src/shared/docs/documents";
import { listDocumentSnapshots } from "@/src/shared/docs/history";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ docId: string }> },
) {
  const session = await authenticateSession(request);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const { docId } = await context.params;
  const perm = await getDocumentPermission(docId, session.writerId);
  if (!perm) {
    return NextResponse.json({ error: "Accès refusé au document" }, { status: 403 });
  }

  try {
    const versions = await listDocumentSnapshots(docId);
    return NextResponse.json({ versions });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur récupération historique" },
      { status: 500 },
    );
  }
}
