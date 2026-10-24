import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { authenticateSession } from "@shared/auth/session";
import { unshareDocument } from "@shared/docs/documents";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ docId: string; writerId: string }> },
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

  const { docId, writerId } = await params;

  try {
    await unshareDocument(docId, session.writer.id, writerId);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erreur de suppression du partage";
    return NextResponse.json(
      { error: { code: "forbidden", message } },
      { status: 403 },
    );
  }
}
