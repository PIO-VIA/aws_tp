import { describe, it, expect } from "vitest";
import { linkIdSchema, requestIdSchema, dlRequestSchema } from "@shared/links/types";
import { generateLinkId } from "@shared/links/links";
import { computeVersionId } from "@shared/pdf/render";

describe("Validation des liens et formats publics (15.1)", () => {
  it("génère des identifiants linkId base64url de 128 bits (>= 22 caractères)", () => {
    const linkId = generateLinkId();
    expect(linkId.length).toBeGreaterThanOrEqual(22);
    expect(linkIdSchema.safeParse(linkId).success).toBe(true);
  });

  it("rejette les linkId trop courts ou avec des caractères interdits", () => {
    expect(linkIdSchema.safeParse("short").success).toBe(false);
    expect(linkIdSchema.safeParse("invalid$character!").success).toBe(false);
  });

  it("valide les requestId conformes à UUID v4", () => {
    const validUuid = "123e4567-e89b-42d3-a456-426614174000";
    expect(requestIdSchema.safeParse(validUuid).success).toBe(true);
    expect(dlRequestSchema.safeParse({ requestId: validUuid }).success).toBe(true);
  });

  it("rejette les requestId non-UUID", () => {
    expect(requestIdSchema.safeParse("not-a-uuid").success).toBe(false);
    expect(dlRequestSchema.safeParse({ requestId: "123" }).success).toBe(false);
  });

  it("calcule le versionId de manière déterministe (sha256 du texte UTF-8)", () => {
    const text = "Bonjour le monde ✨";
    const v1 = computeVersionId(text);
    const v2 = computeVersionId(text);
    expect(v1).toBe(v2);
    expect(v1).toHaveLength(64); // sha256 hex
  });
});
