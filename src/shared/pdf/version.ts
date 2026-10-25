import { createHash } from "crypto";

/**
 * Calcule l'identifiant immuable de version à partir du texte brut (D-11 : sha256 UTF-8).
 * Ne dépend d'aucun module lourd (ni pdfkit ni canvas).
 */
export function computeVersionId(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}
