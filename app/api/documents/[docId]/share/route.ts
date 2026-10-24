import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { authenticateSession } from "@shared/auth/session";
import { shareDocument } from "@shared/docs/documents";

const shareSchema = z.object({
  email: z.string().trim().email("Adresse e-mail invalide"),
  role: z.enum(["editor", "viewer"] as const),
});

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
