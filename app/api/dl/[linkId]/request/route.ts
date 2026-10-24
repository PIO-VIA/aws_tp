import { NextResponse } from "next/server";
import { handleDownloadRequest } from "@shared/links/reservations";
import { dlRequestSchema } from "@shared/links/types";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ linkId: string }> },
) {
  const { linkId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Corps JSON invalide" } },
      { status: 400 },
    );
  }

  const parsedBody = dlRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: { code: "invalid_request_id", message: "requestId (UUID v4) requis" } },
      { status: 400 },
    );
  }

  const result = await handleDownloadRequest(linkId, parsedBody.data.requestId);

  const headers: Record<string, string> = {};
  if (result.retryAfterSec !== undefined) {
    headers["Retry-After"] = String(result.retryAfterSec);
  }

  return NextResponse.json(result.body, {
    status: result.status,
    headers,
  });
}
