import { NextResponse } from "next/server";
import { handleGetReservation } from "@shared/links/reservations";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ linkId: string; reservationId: string }> },
) {
  const { linkId, reservationId } = await params;

  const result = await handleGetReservation(linkId, reservationId);

  const headers: Record<string, string> = {};
  if (result.retryAfterSec !== undefined) {
    headers["Retry-After"] = String(result.retryAfterSec);
  }

  return NextResponse.json(result.body, {
    status: result.status,
    headers,
  });
}
