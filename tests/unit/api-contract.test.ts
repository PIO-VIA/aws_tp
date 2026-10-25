import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { DlResponseState } from "../../src/shared/links/types";

describe("C-12 : Test de contrat d'API publique de téléchargement", () => {
  const rootDir = path.join(__dirname, "..", "..");
  const apiMdPath = path.join(rootDir, "docs", "API.md");
  const openapiYamlPath = path.join(rootDir, "docs", "openapi.yaml");

  const expectedStates = [
    "granted",
    "preparing",
    "retry",
    "exhausted",
    "failed",
    "expired",
  ] as const;

  it("V1. docs/API.md documente explicitement les 6 états possibles", () => {
    const apiMd = fs.readFileSync(apiMdPath, "utf-8");
    for (const state of expectedStates) {
      expect(
        apiMd,
        `docs/API.md doit documenter l'état '${state}'`,
      ).toContain(`\`${state}\``);
    }
  });

  it("V2. docs/openapi.yaml contient les schémas des 6 états de téléchargement", () => {
    const openapi = fs.readFileSync(openapiYamlPath, "utf-8");
    for (const state of expectedStates) {
      const pascal = state.charAt(0).toUpperCase() + state.slice(1);
      expect(
        openapi,
        `openapi.yaml doit définir le schéma DownloadState${pascal}`,
      ).toContain(`DownloadState${pascal}:`);
    }
  });

  it("V3. Les charges utiles réelles respectent le typage DlResponseState et les contrats", () => {
    const payloads: Record<(typeof expectedStates)[number], DlResponseState> = {
      granted: {
        state: "granted",
        url: "https://bucket.s3.amazonaws.com/pdfs/doc/ver.pdf?signature=abc",
        expiresAt: 1729792860,
        reservationId: "res-550e8400-e29b-41d4-a716-446655440000",
        filename: "doc.pdf",
      },
      preparing: {
        state: "preparing",
        reservationId: "res-550e8400-e29b-41d4-a716-446655440000",
        retryAfterMs: 2000,
      },
      retry: {
        state: "retry",
        retryAfterMs: 1500,
      },
      exhausted: {
        state: "exhausted",
      },
      failed: {
        state: "failed",
      },
      expired: {
        state: "expired",
      },
    };

    for (const state of expectedStates) {
      const payload = payloads[state];
      expect(payload.state).toBe(state);

      if (payload.state === "granted") {
        expect(payload).toHaveProperty("url");
        expect(payload).toHaveProperty("expiresAt");
        expect(payload).toHaveProperty("reservationId");
        expect(payload).toHaveProperty("filename");
      } else if (payload.state === "preparing") {
        expect(payload).toHaveProperty("reservationId");
        expect(payload).toHaveProperty("retryAfterMs");
      } else if (payload.state === "retry") {
        expect(payload).toHaveProperty("retryAfterMs");
      }
    }
  });
});
