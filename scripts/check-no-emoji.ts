import fs from "fs";
import path from "path";

/**
 * Garde-fou automatique : scripts/check-no-emoji.ts (npm run check:ui)
 * Contrôle qualité de la charte visuelle.
 * Parcourt app/ et src/components/ et échoue si un emoji ou l'un des glyphes
 * interdits (✕, ✓, ✔, ✖, ←, →, ↑, ↓, ⚠, etc.) est trouvé dans le code JSX ou source.
 */

const TARGET_DIRS = ["app", "src/components"];
const FORBIDDEN_GLYPHS = ["✕", "✓", "✔", "✖", "←", "→", "↑", "↓", "⚠", "⚠️", "🕒", "🔄", "★"];
const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

interface Violation {
  file: string;
  line: number;
  char: string;
  snippet: string;
}

function scanFile(filePath: string): Violation[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const violations: Violation[] = [];

  lines.forEach((line, index) => {
    // Vérifier les glyphes interdits
    for (const glyph of FORBIDDEN_GLYPHS) {
      if (line.includes(glyph)) {
        violations.push({
          file: filePath,
          line: index + 1,
          char: glyph,
          snippet: line.trim(),
        });
        return;
      }
    }

    // Vérifier les emojis Unicode
    if (EMOJI_REGEX.test(line)) {
      const match = line.match(EMOJI_REGEX);
      violations.push({
        file: filePath,
        line: index + 1,
        char: match ? match[0] : "emoji",
        snippet: line.trim(),
      });
    }
  });

  return violations;
}

function walkDir(dir: string, fileList: string[] = []): string[] {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, fileList);
    } else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) {
      fileList.push(fullPath);
    }
  }

  return fileList;
}

function main() {
  console.log("==> Vérification de l'absence d'emojis et glyphes interdits (check:ui)...");
  const rootDir = path.join(__dirname, "..");
  const allViolations: Violation[] = [];

  for (const dirName of TARGET_DIRS) {
    const fullDir = path.join(rootDir, dirName);
    const files = walkDir(fullDir);
    for (const file of files) {
      const violations = scanFile(file);
      allViolations.push(...violations);
    }
  }

  if (allViolations.length > 0) {
    console.error(`\n❌ ÉCHEC : ${allViolations.length} occurrence(s) d'emojis ou glyphes interdits détectée(s) :`);
    for (const v of allViolations) {
      const relPath = path.relative(rootDir, v.file);
      console.error(`  - ${relPath}:${v.line} [symbole: "${v.char}"]`);
      console.error(`    Code : ${v.snippet}`);
    }
    console.error("\nRègle : Remplacer par des composants de lucide-react conformément à la charte graphique de l'interface.\n");
    process.exit(1);
  }

  console.log("✓ Aucun emoji ni glyphe interdit trouvé dans app/ et src/components/ !");
}

main();
