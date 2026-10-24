import { NextRequest, NextResponse } from "next/server";
import { authenticateSession } from "@/src/shared/auth/session";
import { getDocumentPermission } from "@/src/shared/docs/documents";
import { getSnapshotContent } from "@/src/shared/docs/history";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ docId: string; versionId: string }> },
) {
  const session = await authenticateSession(request);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const { docId, versionId } = await context.params;
  const perm = await getDocumentPermission(docId, session.writerId);
  if (!perm) {
    return NextResponse.json({ error: "Accès refusé au document" }, { status: 403 });
  }

  try {
    const data = await getSnapshotContent(docId, versionId);
    if (!data) {
      return NextResponse.json({ error: "Version introuvable" }, { status: 404 });
    }
    return NextResponse.json({ snapshot: data.snapshot, text: data.text });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur aperçu version" },
      { status: 500 },
    );
  }
}
