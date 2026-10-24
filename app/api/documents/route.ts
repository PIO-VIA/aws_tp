import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { authenticateSession } from "@shared/auth/session";
import { createDocument, listUserDocuments } from "@shared/docs/documents";

const createDocSchema = z.object({
  title: z.string().trim().max(200).optional().default("Document sans titre"),
});

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get("sid")?.value;
  const session = await authenticateSession(token);

  if (!session) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Session requise" } },
      { status: 401 },
    );
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Corps vide autorisé, titre par défaut
    body = {};
  }

  const parsed = createDocSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "validation_error", message: parsed.error.issues[0].message } },
      { status: 400 },
    );
  }

  const { title } = parsed.data;
  const result = await createDocument(title, {
    writerId: session.writer.id,
    name: session.writer.name,
    email: session.writer.email,
  });

  return NextResponse.json({ docId: result.docId }, { status: 201 });
}

export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get("sid")?.value;
  const session = await authenticateSession(token);

  if (!session) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Session requise" } },
      { status: 401 },
    );
  }

  const documents = await listUserDocuments(session.writer.id);
  return NextResponse.json({ documents });
}
