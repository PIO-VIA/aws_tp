import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { createSession, authenticateSession, getCookieOptions } from "@shared/auth/session";

const loginSchema = z.object({
  name: z.string().trim().min(1, "Le nom est requis").max(100),
  email: z.string().trim().email("Adresse e-mail invalide"),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Corps JSON invalide" } },
      { status: 400 },
    );
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "validation_error", message: parsed.error.issues[0].message } },
      { status: 400 },
    );
  }

  const { name, email } = parsed.data;
  const session = await createSession(name, email);

  const cookieStore = await cookies();
  const cookieOpts = getCookieOptions();

  cookieStore.set(cookieOpts.name, session.token!, {
    httpOnly: cookieOpts.httpOnly,
    secure: cookieOpts.secure,
    sameSite: cookieOpts.sameSite,
    path: cookieOpts.path,
    maxAge: cookieOpts.maxAge,
  });

  return NextResponse.json({
    writer: session.writer,
    credit: session.credit,
    blockedUntil: session.blockedUntil,
  });
}

export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get("sid")?.value;

  const session = await authenticateSession(token);
  if (!session) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Session expirée ou invalide" } },
      { status: 401 },
    );
  }

  return NextResponse.json({
    writer: session.writer,
    credit: session.credit,
    blockedUntil: session.blockedUntil,
  });
}

export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.delete("sid");
  return NextResponse.json({ ok: true });
}
