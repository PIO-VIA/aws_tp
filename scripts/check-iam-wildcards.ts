import fs from "fs";
import path from "path";

interface WildcardFinding {
  file: string;
  line: number;
  statement: string;
  justification: string;
  valid: boolean;
}

function checkTerraformIamWildcards(): void {
  const tfDir = path.join(__dirname, "..", "infra", "terraform");
  const files = fs.readdirSync(tfDir).filter((f) => f.endsWith(".tf"));

  const findings: WildcardFinding[] = [];
  let hasErrors = false;

  for (const file of files) {
    const fullPath = path.join(tfDir, file);
    const lines = fs.readFileSync(fullPath, "utf-8").split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Ignorer les commentaires eux-mêmes
      if (trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        continue;
      }

      // Détecter Resource = "*" ou "Resource": "*"
      if (/(?:Resource\s*=\s*"\*"|"Resource"\s*:\s*"\*")/.test(line)) {
        // Ignorer si ce n'est pas une politique IAM (par exemple si c'est Principal = "*")
        if (line.includes("Principal")) continue;

        // Chercher une ligne de commentaire au-dessus (dans les 5 lignes précédentes)
        let justification = "";
        for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
          const prev = lines[j].trim();
          if (prev.startsWith("#") || prev.startsWith("//") || prev.startsWith("/*")) {
            justification = prev.replace(/^([#/]|\*)+\s*/, "");
            break;
          }
        }

        const valid = justification.length > 0;
        if (!valid) hasErrors = true;

        findings.push({
          file,
          line: i + 1,
          statement: line.trim(),
          justification: justification || "AUCUN COMMENTAIRE JUSTIFICATIF TROUVÉ (NON CONFORME)",
          valid,
        });
      }
    }
  }

  console.log("================================================================================");
  console.log("INSPECTION DES WILDCARDS IAM (Resource = \"*\") DANS infra/terraform/*.tf");
  console.log("================================================================================");
  console.log(`Nombre total d'occurrences trouvées : ${findings.length}\n`);

  for (const f of findings) {
    const status = f.valid ? "[VALIDE]" : "[ERREUR]";
    console.log(`${status} ${f.file}:${f.line}`);
    console.log(`   Ligne         : ${f.statement}`);
    console.log(`   Justification : ${f.justification}\n`);
  }

  if (hasErrors) {
    console.error("ÉCHEC : Des jokers Resource = \"*\" ne disposent pas d'un commentaire justificatif explicite.");
    process.exit(1);
  } else {
    console.log("SUCCÈS : Tous les Resource = \"*\" sont strictement justifiés par les spécifications de l'API AWS.");
  }
}

checkTerraformIamWildcards();
