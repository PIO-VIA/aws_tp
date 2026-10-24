import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";

export function computeVersionId(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

let fontPathCache: string | null = null;
function getFontPath(): string | null {
  if (fontPathCache && fs.existsSync(/*turbopackIgnore: true*/ fontPathCache)) return fontPathCache;
  const candidates = [
    path.join(process.cwd(), "assets", "fonts", "DejaVuSans.ttf"),
    path.join(__dirname, "..", "..", "assets", "fonts", "DejaVuSans.ttf"),
    path.join(__dirname, "..", "..", "..", "assets", "fonts", "DejaVuSans.ttf"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(/*turbopackIgnore: true*/ p)) {
      fontPathCache = p;
      return p;
    }
  }
  return null;
}

/**
 * Génère un document PDF déterministe avec en-tête, pagination et pied de page.
 * Utilise la police TrueType DejaVu Sans embarquée si disponible (support accents).
 */
export async function renderPdfBuffer(
  title: string,
  content: string,
  versionId: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: 50,
        bufferPages: true,
        info: {
          Title: title,
          Author: "Association Journal",
          Subject: `Version ${versionId.substring(0, 8)}`,
        },
      });

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err: Error) => reject(err));

      const fontFile = getFontPath();
      if (fontFile) {
        doc.font(fontFile);
      } else {
        doc.font("Helvetica");
      }

      // En-tête : Titre du document
      doc.fontSize(20).text(title, { align: "center" });
      doc.moveDown(1.5);

      // Contenu texte
      doc.fontSize(11).text(content || "(Document vide)", {
        align: "justify",
        lineGap: 4,
      });

      // Numérotation des pages et pied de page
      const range = doc.bufferedPageRange();
      const shortVersion = versionId.substring(0, 8);
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const footerY = doc.page.height - 40;
        doc
          .fontSize(9)
          .fillColor("#666666")
          .text(`version ${shortVersion} — Page ${i + 1} / ${range.count}`, 50, footerY, {
            align: "center",
            width: doc.page.width - 100,
          });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
