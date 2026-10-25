import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { authenticateSession } from "@shared/auth/session";
import {
  shareDocument,
  unshareDocument,
  listDocumentEditorsWithCredits,
} from "@shared/docs/documents";

const shareSchema = z.object({
  email: z.string().trim().email("Adresse e-mail invalide"),
  role: z.enum(["editor", "viewer"] as const),
});

/**
 * Récupère la liste des rédacteurs et leurs crédits d'écriture restants (propriétaire requis).
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

/**
 * Partage un document avec un nouveau rédacteur (propriétaire requis).
 */
export async function POST(
  request: NextRequest,
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Corps JSON invalide" } },
      { status: 400 },
    );
  }

  const parsed = shareSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "validation_error", message: parsed.error.issues[0].message } },
      { status: 400 },
    );
  }

  try {
    const { targetWriterId } = await shareDocument({
      docId,
      ownerId: session.writer.id,
      targetEmail: parsed.data.email,
      role: parsed.data.role,
    });

    return NextResponse.json({ targetWriterId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erreur de partage";
    return NextResponse.json(
      { error: { code: "forbidden", message } },
      { status: 403 },
    );
  }
}

/**
 * Révocation des droits d'un collaborateur (propriétaire requis).
 */
export async function DELETE(
  request: NextRequest,
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

  let targetWriterId = "";
  try {
    const body = (await request.json()) as { writerId?: string };
    targetWriterId = body.writerId || "";
  } catch {
    const url = new URL(request.url);
    targetWriterId = url.searchParams.get("writerId") || "";
  }

  if (!targetWriterId) {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Identifiant du rédacteur requis" } },
      { status: 400 },
    );
  }

  try {
    await unshareDocument(docId, session.writer.id, targetWriterId);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erreur de retrait des droits";
    return NextResponse.json(
      { error: { code: "forbidden", message } },
      { status: 403 },
    );
  }
}
