import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Validation des actifs de marque (Brand Assets)", () => {
  const rootDir = path.resolve(__dirname, "../../");
  const brandDir = path.join(rootDir, "public/brand");

  const expectedSvgFiles = [
    "logo-mark.svg",
    "logo-mark-mono.svg",
    "logo-app-icon.svg",
  ];

  it("les trois fichiers SVG de public/brand/ existent", () => {
    for (const file of expectedSvgFiles) {
      const fullPath = path.join(brandDir, file);
      expect(fs.existsSync(fullPath), `${file} doit exister`).toBe(true);
    }
  });

  it("chaque SVG pèse moins de 2 Ko (2048 octets)", () => {
    for (const file of expectedSvgFiles) {
      const fullPath = path.join(brandDir, file);
      const stat = fs.statSync(fullPath);
      expect(
        stat.size,
        `${file} (${stat.size} octets) doit peser moins de 2048 octets`
      ).toBeLessThan(2048);
    }
  });

  it("aucun SVG ne contient de balise <text>, <image> ou <script>", () => {
    for (const file of expectedSvgFiles) {
      const content = fs.readFileSync(path.join(brandDir, file), "utf-8");
      expect(content).not.toMatch(/<text\b/i);
      expect(content).not.toMatch(/<image\b/i);
      expect(content).not.toMatch(/<script\b/i);
    }
  });

  it("chaque SVG est du XML bien formé avec viewBox carré et titre accessible", () => {
    for (const file of expectedSvgFiles) {
      const content = fs.readFileSync(path.join(brandDir, file), "utf-8");

      // Vérifie la balise racine <svg> et la fermeture </svg>
      expect(content.trim().startsWith("<svg")).toBe(true);
      expect(content.trim().endsWith("</svg>")).toBe(true);

      // Vérifie viewBox carré (ex. viewBox="0 0 32 32" ou "0 0 48 48")
      const viewBoxMatch = content.match(/viewBox=["']\s*0\s+0\s+(\d+)\s+(\d+)\s*["']/);
      expect(viewBoxMatch, `${file} doit avoir un viewBox carré 0 0 W H`).not.toBeNull();
      if (viewBoxMatch) {
        expect(viewBoxMatch[1]).toBe(viewBoxMatch[2]);
      }

      // Vérifie la présence d'une balise <title>
      expect(content).toMatch(/<title>.*<\/title>/);
    }
  });

  it("logo-mark-mono utilise currentColor pour la compatibilité monochrome", () => {
    const monoSvg = fs.readFileSync(
      path.join(brandDir, "logo-mark-mono.svg"),
      "utf-8"
    );
    expect(monoSvg).toContain("currentColor");
  });

  it("les icônes d'application Next.js existent aux emplacements conventionnels", () => {
    expect(fs.existsSync(path.join(rootDir, "app/icon.svg"))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, "app/favicon.ico"))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, "app/apple-icon.png"))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, "app/opengraph-image.png"))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, "app/manifest.ts"))).toBe(true);
  });
});
