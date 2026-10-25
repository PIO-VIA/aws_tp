import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { authenticateSession } from "@shared/auth/session";
import { listDocumentEditorsWithCredits } from "@shared/docs/documents";

/**
 * Endpoint dédié permettant au propriétaire d'un document de consulter les rédacteurs et leurs crédits restants.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ docId: string }> },
) {
  const cookieStore = await cookies();
  const token = cookieStore.get("sid")?.value;
  const session = await authenticateSession(token);

  if (!session) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Session requise" } },
      { status: 401 },
    );
  }

  const { docId } = await params;

  try {
    const editors = await listDocumentEditorsWithCredits(docId, session.writer.id);
    return NextResponse.json({ editors });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Erreur de consultation des rédacteurs";
    return NextResponse.json(
      { error: { code: "forbidden", message } },
      { status: 403 },
    );
  }
}
