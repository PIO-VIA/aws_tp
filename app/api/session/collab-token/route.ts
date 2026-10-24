import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { authenticateSession } from "@shared/auth/session";
import { createCollabToken } from "@shared/auth/jwt";
import { getDocumentPermission } from "@shared/docs/documents";

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get("sid")?.value;

  const session = await authenticateSession(token);
  if (!session) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Session requise" } },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(request.url);
  const docId = searchParams.get("docId");

  if (!docId) {
    return NextResponse.json(
      { error: { code: "missing_doc_id", message: "docId requis en paramètre" } },
      { status: 400 },
    );
  }

  // Vérification de la permission
  const perm = await getDocumentPermission(docId, session.writer.id);
  if (!perm) {
    return NextResponse.json(
      { error: { code: "forbidden", message: "Accès refusé au document" } },
      { status: 403 },
    );
  }

  const collabToken = await createCollabToken({
    writerId: session.writer.id,
    docId,
  });

  return NextResponse.json({ token: collabToken });
}
