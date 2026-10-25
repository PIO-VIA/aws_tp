/**
 * Script de build des 5 Lambdas du projet.
 * Utilise esbuild pour packager chaque handler en un bundle autonome (CJS/Node22)
 * et produit les archives ZIP prêtes au déploiement dans dist/lambdas/<name>.zip.
 */
import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { log } from "../src/shared/log";

const LAMBDAS = [
  "download-api",
  "pdf-worker",
  "pdf-dlq-handler",
  "notifier",
  "reconciler",
];

const ROOT_DIR = path.resolve(__dirname, "..");
const DIST_DIR = path.resolve(ROOT_DIR, "dist/lambdas");

async function buildLambda(name: string) {
  const entryPoint = path.resolve(ROOT_DIR, `lambdas/${name}.ts`);
  const lambdaDistDir = path.resolve(DIST_DIR, name);
  const zipPath = path.resolve(DIST_DIR, `${name}.zip`);

  if (!fs.existsSync(entryPoint)) {
    throw new Error(`Handler introuvable: ${entryPoint}`);
  }

  // Nettoyage dossier temporaire
  if (fs.existsSync(lambdaDistDir)) {
    fs.rmSync(lambdaDistDir, { recursive: true, force: true });
  }
  fs.mkdirSync(lambdaDistDir, { recursive: true });

  log.info(`build_lambda.${name}.bundling`);

  // Bundle esbuild avec metafile activé pour contrôle des dépendances (C-04)
  const buildResult = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: path.resolve(lambdaDistDir, "index.js"),
    sourcemap: "inline",
    minify: false,
    metafile: true,
    external: [],
    banner: {
      js: 'const import_meta_url = typeof __filename !== "undefined" ? require("url").pathToFileURL(__filename).href : "file:///var/task/index.js";',
    },
    define: {
      "import.meta.url": "import_meta_url",
    },
    conditions: ["node", "require"],
  });

  // Sauvegarde du metafile
  const metafilePath = path.resolve(DIST_DIR, `${name}.metafile.json`);
  fs.writeFileSync(metafilePath, JSON.stringify(buildResult.metafile, null, 2), "utf-8");

  // Règle C-04 : node_modules/pdfkit ne doit apparaître QUE dans pdf-worker
  if (name !== "pdf-worker") {
    const inputs = Object.keys(buildResult.metafile.inputs);
    const hasPdfKit = inputs.some((inp) => inp.includes("node_modules/pdfkit"));
    if (hasPdfKit) {
      throw new Error(`[C-04] node_modules/pdfkit ne doit pas apparaître dans le bundle de ${name}`);
    }
  }

  // Copie des polices pour le worker PDF (DejaVu Sans + standard-fonts de pdfkit)
  if (name === "pdf-worker") {
    const fontSource = path.resolve(ROOT_DIR, "assets/fonts/DejaVuSans.ttf");
    const fontDestDir = path.resolve(lambdaDistDir, "assets/fonts");
    fs.mkdirSync(fontDestDir, { recursive: true });
    if (fs.existsSync(fontSource)) {
      fs.copyFileSync(fontSource, path.resolve(fontDestDir, "DejaVuSans.ttf"));
      log.info(`build_lambda.${name}.font_copied`);
    }

    // Standard fonts pour PDFKit (requis par #standard-fonts/*)
    const stdFontsSource = path.resolve(ROOT_DIR, "node_modules/pdfkit/js/standard-fonts");
    const stdFontsDest = path.resolve(lambdaDistDir, "standard-fonts");
    if (fs.existsSync(stdFontsSource)) {
      fs.cpSync(stdFontsSource, stdFontsDest, { recursive: true });
      log.info(`build_lambda.${name}.std_fonts_copied`);
    }

    // package.json pour résoudre les sous-chemins #standard-fonts/*
    fs.writeFileSync(
      path.resolve(lambdaDistDir, "package.json"),
      JSON.stringify(
        {
          name: "pdf-worker",
          type: "commonjs",
          imports: {
            "#standard-fonts/*": "./standard-fonts/*.cjs",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  // Création du zip
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }

  execSync(`cd "${lambdaDistDir}" && zip -r "${zipPath}" .`, {
    stdio: "inherit",
  });

  const stats = fs.statSync(zipPath);
  if (name === "download-api" && stats.size >= 3 * 1024 * 1024) {
    throw new Error(`[C-04] La taille du zip download-api (${(stats.size / 1024 / 1024).toFixed(2)} Mo) doit être < 3 Mo`);
  }
  log.info(`build_lambda.${name}.completed`, {
    zipPath,
    sizeBytes: stats.size,
    sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
  });
}

async function main() {
  log.info("build_lambdas.started", { lambdas: LAMBDAS });

  fs.mkdirSync(DIST_DIR, { recursive: true });

  for (const lambda of LAMBDAS) {
    await buildLambda(lambda);
  }

  log.info("build_lambdas.finished_all");
}

main().catch((err) => {
  log.error("build_lambdas.failed", { error: err });
  process.exit(1);
});
