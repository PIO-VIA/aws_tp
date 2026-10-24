import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { authenticateSession } from "@shared/auth/session";
import { getDocumentPermission, listDocumentLinks } from "@shared/docs/documents";
import { createLink } from "@shared/links/links";
import { getConfig } from "@shared/config";

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
  const now = Math.floor(Date.now() / 1000);

  // Vérification blocage
  if (session.blockedUntil && session.blockedUntil > now) {
    return NextResponse.json(
      { error: { code: "blocked", message: "Rédacteur temporairement bloqué" } },
      { status: 403 },
    );
  }

  // Vérification permission (owner ou editor requis)
  const perm = await getDocumentPermission(docId, session.writer.id);
  if (!perm || perm.role === "viewer") {
    return NextResponse.json(
      { error: { code: "forbidden", message: "Droits insuffisants (owner ou editor requis)" } },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Corps JSON invalide" } },
      { status: 400 },
    );
  }

  const config = getConfig();
  const createLinkSchema = z.object({
    maxDownloads: z
      .number()
      .int("maxDownloads doit être un entier")
      .min(1, "Au moins 1 téléchargement requis")
      .max(config.MAX_DOWNLOADS_CAP, `Maximum ${config.MAX_DOWNLOADS_CAP} exemplaires autorisés`),
  });

  const parsed = createLinkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "validation_error", message: parsed.error.issues[0].message } },
      { status: 400 },
    );
  }

  const link = await createLink({
    docId,
    creatorId: session.writer.id,
    creatorEmail: session.writer.email,
    creatorName: session.writer.name,
    maxDownloads: parsed.data.maxDownloads,
  });

  return NextResponse.json(
    {
      linkId: link.linkId,
      publicPath: `/d/${link.linkId}`,
    },
    { status: 201 },
  );
}

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
    const links = await listDocumentLinks(docId, session.writer.id);
    return NextResponse.json({ links });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erreur lors de la récupération des liens";
    return NextResponse.json(
      { error: { code: "forbidden", message } },
      { status: 403 },
    );
  }
}
