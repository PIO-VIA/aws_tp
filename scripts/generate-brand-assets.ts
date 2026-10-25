import fs from "fs";
import path from "path";
import sharp from "sharp";

/**
 * Script de génération des fichiers d'icônes et d'OpenGraph (npm run brand:build).
 * - app/favicon.ico (16, 32, 48 px multi-résolution)
 * - app/apple-icon.png (180 x 180 px)
 * - public/brand/icon-192.png (192 x 192 px, any)
 * - public/brand/icon-512.png (512 x 512 px, any)
 * - public/brand/icon-maskable-192.png (192 x 192 px, maskable avec marge de sécurité)
 * - public/brand/icon-maskable-512.png (512 x 512 px, maskable avec marge de sécurité)
 * - app/opengraph-image.png (1200 x 630 px)
 */

const ROOT_DIR = path.join(__dirname, "..");
const BRAND_DIR = path.join(ROOT_DIR, "public", "brand");
const APP_DIR = path.join(ROOT_DIR, "app");

// Construction d'un fichier .ico multi-résolution valide
function createIco(pngBuffers: Buffer[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Réservé (0)
  header.writeUInt16LE(1, 2); // Type 1 = ICO
  header.writeUInt16LE(pngBuffers.length, 4); // Nombre d'images

  let offset = 6 + pngBuffers.length * 16;
  const dirEntries: Buffer[] = [];

  for (const img of pngBuffers) {
    const entry = Buffer.alloc(16);
    const width = img.readUInt32BE(16);
    const height = img.readUInt32BE(20);

    entry.writeUInt8(width >= 256 ? 0 : width, 0);
    entry.writeUInt8(height >= 256 ? 0 : height, 1);
    entry.writeUInt8(0, 2); // Palette
    entry.writeUInt8(0, 3); // Réservé
    entry.writeUInt16LE(1, 4); // Plans de couleur
    entry.writeUInt16LE(32, 6); // Bits par pixel (32 = RGBA)
    entry.writeUInt32LE(img.length, 8); // Taille des données
    entry.writeUInt32LE(offset, 12); // Décalage dans le fichier

    dirEntries.push(entry);
    offset += img.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers]);
}

// SVG du symbole vectoriel autonome haute fidélité (Piste A)
function getSymbolSvg(size = 512): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none">
    <path d="M9 3h10l7 7v16a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z" fill="#EEF2FF" stroke="#4F46E5" stroke-width="1.75" stroke-linejoin="round"/>
    <path d="M19 3v6a1 1 0 0 0 1 1h6" fill="#C7D2FE" stroke="#4F46E5" stroke-width="1.75" stroke-linejoin="round"/>
    <path d="M10 13h12M10 18h12M10 23h7" stroke="#94A3B8" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M13 10v6.5" stroke="#4F46E5" stroke-width="1.75" stroke-linecap="round"/>
    <circle cx="13" cy="8.5" r="1.5" fill="#4F46E5"/>
    <path d="M19 15v6.5" stroke="#F59E0B" stroke-width="1.75" stroke-linecap="round"/>
    <circle cx="19" cy="13.5" r="1.5" fill="#F59E0B"/>
  </svg>`;
}

// SVG pour l'icône d'application (sur fond dégradé sombre squircle)
function getAppIconSvg(size = 512): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none">
    <defs>
      <linearGradient id="ecBg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#312E81"/>
        <stop offset="100%" stop-color="#0F172A"/>
      </linearGradient>
    </defs>
    <rect width="32" height="32" rx="7" fill="url(#ecBg)"/>
    <path d="M10 5h8l6 6v13a2.5 2.5 0 0 1-2.5 2.5h-11.5A2.5 2.5 0 0 1 7.5 24V7.5A2.5 2.5 0 0 1 10 5z" fill="#FFFFFF" stroke="#818CF8" stroke-width="1.25" stroke-linejoin="round"/>
    <path d="M18 5v5a1 1 0 0 0 1 1h5" fill="#E0E7FF" stroke="#818CF8" stroke-width="1.25" stroke-linejoin="round"/>
    <path d="M11 13.5h10M11 17.5h10M11 21.5h6" stroke="#94A3B8" stroke-width="1.25" stroke-linecap="round"/>
    <path d="M13.5 11v5" stroke="#4F46E5" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="13.5" cy="9.5" r="1.2" fill="#4F46E5"/>
    <path d="M18.5 15v5" stroke="#F59E0B" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="18.5" cy="13.5" r="1.2" fill="#F59E0B"/>
  </svg>`;
}

// SVG pour les icônes "maskable" (fond plein bord-à-bord + symbole au centre dans la safe zone 60%)
function getMaskableIconSvg(size = 512): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100" fill="none">
    <defs>
      <linearGradient id="maskableBg" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#312E81"/>
        <stop offset="100%" stop-color="#0F172A"/>
      </linearGradient>
    </defs>
    <rect width="100" height="100" fill="url(#maskableBg)"/>
    <!-- Symbole centré dans la safe zone (20% de marge tout autour) -->
    <g transform="translate(20, 20) scale(1.875)">
      <path d="M10 5h8l6 6v13a2.5 2.5 0 0 1-2.5 2.5h-11.5A2.5 2.5 0 0 1 7.5 24V7.5A2.5 2.5 0 0 1 10 5z" fill="#FFFFFF" stroke="#818CF8" stroke-width="1.25" stroke-linejoin="round"/>
      <path d="M18 5v5a1 1 0 0 0 1 1h5" fill="#E0E7FF" stroke="#818CF8" stroke-width="1.25" stroke-linejoin="round"/>
      <path d="M11 13.5h10M11 17.5h10M11 21.5h6" stroke="#94A3B8" stroke-width="1.25" stroke-linecap="round"/>
      <path d="M13.5 11v5" stroke="#4F46E5" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="13.5" cy="9.5" r="1.2" fill="#4F46E5"/>
      <path d="M18.5 15v5" stroke="#F59E0B" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="18.5" cy="13.5" r="1.2" fill="#F59E0B"/>
    </g>
  </svg>`;
}

// SVG pour la carte OpenGraph 1200 x 630
function getOpenGraphSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" fill="none">
    <defs>
      <linearGradient id="ogBg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#0F172A"/>
        <stop offset="50%" stop-color="#090D16"/>
        <stop offset="100%" stop-color="#020617"/>
      </linearGradient>
      <radialGradient id="ogGlow" cx="240" cy="315" r="320" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#4F46E5" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#4F46E5" stop-opacity="0"/>
      </radialGradient>
    </defs>

    <!-- Fond sombre dégradé avec halo lumineux doux -->
    <rect width="1200" height="630" fill="url(#ogBg)"/>
    <rect width="1200" height="630" fill="url(#ogGlow)"/>

    <!-- Lignes de grille subtiles d'arrière-plan -->
    <g opacity="0.06" stroke="#FFFFFF" stroke-width="1">
      <line x1="0" y1="120" x2="1200" y2="120"/>
      <line x1="0" y1="240" x2="1200" y2="240"/>
      <line x1="0" y1="360" x2="1200" y2="360"/>
      <line x1="0" y1="480" x2="1200" y2="480"/>
      <line x1="400" y1="0" x2="400" y2="630"/>
      <line x1="800" y1="0" x2="800" y2="630"/>
    </g>

    <!-- Symbole de marque (grande taille, gauche) -->
    <g transform="translate(100, 185) scale(8)">
      <path d="M9 3h10l7 7v16a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z" fill="#EEF2FF" stroke="#4F46E5" stroke-width="1.75" stroke-linejoin="round"/>
      <path d="M19 3v6a1 1 0 0 0 1 1h6" fill="#C7D2FE" stroke="#4F46E5" stroke-width="1.75" stroke-linejoin="round"/>
      <path d="M10 13h12M10 18h12M10 23h7" stroke="#94A3B8" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M13 10v6.5" stroke="#4F46E5" stroke-width="1.75" stroke-linecap="round"/>
      <circle cx="13" cy="8.5" r="1.5" fill="#4F46E5"/>
      <path d="M19 15v6.5" stroke="#F59E0B" stroke-width="1.75" stroke-linecap="round"/>
      <circle cx="19" cy="13.5" r="1.5" fill="#F59E0B"/>
    </g>

    <!-- Textes et Slogan (droite) -->
    <g transform="translate(420, 200)">
      <!-- Badge Association -->
      <rect width="250" height="34" rx="17" fill="#4F46E5" fill-opacity="0.15" stroke="#4F46E5" stroke-width="1.5"/>
      <text x="125" y="22" fill="#818CF8" font-size="13" font-family="system-ui, -apple-system, sans-serif" font-weight="700" letter-spacing="1.5" text-anchor="middle">
        ASSOCIATION ÉTUDIANTE
      </text>

      <!-- Titre de l'application -->
      <text x="0" y="110" font-family="system-ui, -apple-system, sans-serif" font-size="64" letter-spacing="-1.5">
        <tspan fill="#FFFFFF" font-weight="800">Éditeur </tspan>
        <tspan fill="#94A3B8" font-weight="400">Collaboratif</tspan>
      </text>

      <!-- Slogan officiel court demandé -->
      <text x="0" y="165" fill="#E2E8F0" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-weight="500">
        Écrivez à plusieurs, publiez en un clic
      </text>

      <!-- Puces de fonctionnalités clés -->
      <g transform="translate(0, 220)">
        <circle cx="6" cy="0" r="4" fill="#10B981"/>
        <text x="20" y="5" fill="#94A3B8" font-family="system-ui, -apple-system, sans-serif" font-size="16">
          Synchronisation temps réel CRDT Yjs
        </text>

        <circle cx="360" cy="0" r="4" fill="#6366F1"/>
        <text x="374" y="5" fill="#94A3B8" font-family="system-ui, -apple-system, sans-serif" font-size="16">
          Diffusion PDF à tirage limité
        </text>
      </g>
    </g>
  </svg>`;
}

async function main() {
  console.log("==> Génération des fichiers d'icônes et d'image OpenGraph...");

  // Création des dossiers si nécessaire
  fs.mkdirSync(BRAND_DIR, { recursive: true });
  fs.mkdirSync(APP_DIR, { recursive: true });

  // 1. Génération de app/favicon.ico (16, 32, 48)
  console.log("--> Génération de app/favicon.ico (16, 32, 48 px)...");
  const symbolSvg = Buffer.from(getSymbolSvg(64));
  const p16 = await sharp(symbolSvg).resize(16, 16).png().toBuffer();
  const p32 = await sharp(symbolSvg).resize(32, 32).png().toBuffer();
  const p48 = await sharp(symbolSvg).resize(48, 48).png().toBuffer();
  const icoBuffer = createIco([p16, p32, p48]);
  fs.writeFileSync(path.join(APP_DIR, "favicon.ico"), icoBuffer);
  console.log(`    ✓ app/favicon.ico créé (${icoBuffer.length} octets)`);

  // 2. Génération de app/apple-icon.png (180 x 180)
  console.log("--> Génération de app/apple-icon.png (180 x 180 px)...");
  const appIconSvg = Buffer.from(getAppIconSvg(512));
  await sharp(appIconSvg).resize(180, 180).png().toFile(path.join(APP_DIR, "apple-icon.png"));
  console.log("    ✓ app/apple-icon.png créé");

  // 3. Génération des icônes PWA pour manifest : icon-192.png et icon-512.png (any)
  console.log("--> Génération de public/brand/icon-192.png et icon-512.png (any)...");
  await sharp(appIconSvg).resize(192, 192).png().toFile(path.join(BRAND_DIR, "icon-192.png"));
  await sharp(appIconSvg).resize(512, 512).png().toFile(path.join(BRAND_DIR, "icon-512.png"));
  console.log("    ✓ public/brand/icon-192.png et icon-512.png créés");

  // 4. Génération des icônes maskable : icon-maskable-192.png et icon-maskable-512.png
  console.log("--> Génération des icônes maskable avec marge de sécurité...");
  const maskableSvg = Buffer.from(getMaskableIconSvg(512));
  await sharp(maskableSvg).resize(192, 192).png().toFile(path.join(BRAND_DIR, "icon-maskable-192.png"));
  await sharp(maskableSvg).resize(512, 512).png().toFile(path.join(BRAND_DIR, "icon-maskable-512.png"));
  console.log("    ✓ public/brand/icon-maskable-192.png et icon-maskable-512.png créés");

  // 5. Génération de app/opengraph-image.png (1200 x 630)
  console.log("--> Génération de app/opengraph-image.png (1200 x 630 px)...");
  const ogSvg = Buffer.from(getOpenGraphSvg());
  await sharp(ogSvg).resize(1200, 630).png().toFile(path.join(APP_DIR, "opengraph-image.png"));
  console.log("    ✓ app/opengraph-image.png créé");

  console.log("==> Tous les assets de marque ont été générés avec succès !");
}

main().catch((err) => {
  console.error("Erreur lors de la génération des assets de marque :", err);
  process.exit(1);
});
