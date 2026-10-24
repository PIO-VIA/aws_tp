import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { authenticateSession } from "@shared/auth/session";
import { getDocumentForUser } from "@shared/docs/documents";

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
  const result = await getDocumentForUser(docId, session.writer.id);

  if (!result) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Document introuvable ou accès refusé" } },
      { status: 404 },
    );
  }

  return NextResponse.json({ meta: result.meta, role: result.role });
}
