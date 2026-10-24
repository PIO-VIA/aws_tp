import { NextResponse } from "next/server";
import { getLink, isLinkExhaustedInMemory, markLinkExhaustedInMemory } from "@shared/links/links";
import { linkIdSchema } from "@shared/links/types";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ linkId: string }> },
) {
  const { linkId: rawLinkId } = await params;
  const parsed = linkIdSchema.safeParse(rawLinkId);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_id", message: "Identifiant invalide" } },
      { status: 400 },
    );
  }

  const linkId = parsed.data;

  // Chemin rapide mémoire
  if (isLinkExhaustedInMemory(linkId)) {
    return NextResponse.json(
      { state: "exhausted" },
      {
        status: 200,
        headers: { "Cache-Control": "public, max-age=1" },
      },
    );
  }

  const link = await getLink(linkId);
  if (!link || link.status !== "active") {
    return NextResponse.json(
      { error: { code: "not_found", message: "Lien inconnu ou révoqué" } },
      { status: 404 },
    );
  }

  const isExhausted = link.issued >= link.maxDownloads;
  if (isExhausted) {
    markLinkExhaustedInMemory(linkId);
  }

  return NextResponse.json(
    { state: isExhausted ? "exhausted" : "open" },
    {
      status: 200,
      headers: { "Cache-Control": "public, max-age=1" },
    },
  );
}
