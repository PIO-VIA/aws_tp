import React from "react";

export type LogoTrack = "A" | "B" | "C";
export type LogoVariant = "mark" | "wordmark" | "stacked";
export type LogoSize = "xs" | "sm" | "md" | "lg" | "xl" | number;

export interface LogoProps {
  /**
   * Variante d'affichage :
   * - "mark" : Symbole seul
   * - "wordmark" : Symbole + nom en ligne (texte HTML)
   * - "stacked" : Symbole + nom empilé centré (connexion, erreurs)
   */
  variant?: LogoVariant;
  /**
   * Taille du symbole (xs: 16px, sm: 24px, md: 32px, lg: 48px, xl: 64px, ou nombre en px).
   */
  size?: LogoSize;
  /**
   * Piste du symbole (A, B ou C). Recommandée par défaut : A.
   */
  track?: LogoTrack;
  /**
   * Mode monochrome (utilise currentColor au lieu des couleurs d'accent).
   */
  mono?: boolean;
  /**
   * Si true, marque l'élément comme purement décoratif (aria-hidden).
   * Sinon, applique role="img" avec le libellé accessible.
   */
  decorative?: boolean;
  /**
   * Si true, masque le mot-symbole sur les écrans très étroits (< 640px).
   */
  hideTextOnMobile?: boolean;
  /**
   * Classes CSS additionnelles pour le conteneur.
   */
  className?: string;
  /**
   * Classes CSS additionnelles pour le symbole SVG.
   */
  markClassName?: string;
}

const SIZE_MAP: Record<string, number> = {
  xs: 16,
  sm: 24,
  md: 32,
  lg: 48,
  xl: 64,
};

/**
 * Rendu vectoriel SVG du symbole selon la piste choisie (A, B ou C).
 */
export function LogoMark({
  size = 32,
  track = "A",
  mono = false,
  className = "",
  decorative = true,
}: {
  size?: number;
  track?: LogoTrack;
  mono?: boolean;
  className?: string;
  decorative?: boolean;
}) {
  const isSmall = size <= 20;

  // Couleurs sémantiques ou monochrome
  const sheetFill = mono ? "currentColor" : "var(--color-brand-sheet-fill, #EEF2FF)";
  const sheetStroke = mono ? "currentColor" : "var(--color-brand-sheet-stroke, #4F46E5)";
  const foldFill = mono ? "currentColor" : "var(--color-brand-fold-fill, #C7D2FE)";
  const lineStroke = mono ? "currentColor" : "var(--color-brand-lines, #94A3B8)";
  const cur1Color = mono ? "currentColor" : "var(--color-brand-cur1, #4F46E5)";
  const cur2Color = mono ? "currentColor" : "var(--color-brand-cur2, #F59E0B)";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 transition-transform ${className}`}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "Symbole Éditeur Collaboratif" })}
    >
      <title>Éditeur Collaboratif</title>

      {/* PISTE A : "Curseurs croisés / Dynamic Carets" (Recommandée) */}
      {track === "A" && (
        <g>
          {/* Feuille avec coin replié */}
          <path
            d="M9 3h10l7 7v16a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"
            className="logo-sheet"
            fill={sheetFill}
            fillOpacity={mono ? 0.08 : 0.85}
            stroke={sheetStroke}
            strokeWidth={isSmall ? 2 : 1.75}
            strokeLinejoin="round"
          />
          {/* Coin replié */}
          <path
            d="M19 3v6a1 1 0 0 0 1 1h6"
            className="logo-fold"
            fill={foldFill}
            fillOpacity={mono ? 0.25 : 0.9}
            stroke={sheetStroke}
            strokeWidth={isSmall ? 2 : 1.75}
            strokeLinejoin="round"
          />
          {/* Lignes de texte */}
          {!isSmall ? (
            <path
              d="M10 13h12M10 18h12M10 23h7"
              stroke={lineStroke}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeOpacity={mono ? 0.35 : 0.7}
            />
          ) : (
            /* Version simplifiée 16px : 2 lignes renforcées pour une lisibilité parfaite */
            <path
              d="M10 14h12M10 20h9"
              stroke={lineStroke}
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeOpacity={mono ? 0.4 : 0.8}
            />
          )}

          {/* Curseur collaborateur 1 (Indigo) */}
          <path
            d={isSmall ? "M12.5 11v6" : "M13 10v6.5"}
            stroke={cur1Color}
            strokeWidth={isSmall ? 2 : 1.75}
            strokeLinecap="round"
          />
          <circle cx={isSmall ? 12.5 : 13} cy={isSmall ? 9.5 : 8.5} r={isSmall ? 1.25 : 1.5} fill={cur1Color} />

          {/* Curseur collaborateur 2 (Ambre) */}
          <path
            d={isSmall ? "M19 16v6" : "M19 15v6.5"}
            stroke={cur2Color}
            strokeWidth={isSmall ? 2 : 1.75}
            strokeLinecap="round"
            strokeDasharray={mono ? "1.5 1" : undefined}
          />
          <circle cx={19} cy={isSmall ? 14.5 : 13.5} r={isSmall ? 1.25 : 1.5} fill={cur2Color} />
        </g>
      )}

      {/* PISTE B : "Pointeurs Carets / Wedge Carets" */}
      {track === "B" && (
        <g>
          {/* Feuille avec coin replié */}
          <path
            d="M9 3h10l7 7v16a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"
            fill={sheetFill}
            fillOpacity={mono ? 0.08 : 0.85}
            stroke={sheetStroke}
            strokeWidth={isSmall ? 2 : 1.75}
            strokeLinejoin="round"
          />
          <path
            d="M19 3v6a1 1 0 0 0 1 1h6"
            fill={foldFill}
            fillOpacity={mono ? 0.25 : 0.9}
            stroke={sheetStroke}
            strokeWidth={isSmall ? 2 : 1.75}
            strokeLinejoin="round"
          />
          {/* Lignes de texte */}
          <path
            d={isSmall ? "M10 14h12M10 20h8" : "M10 13h12M10 18h12M10 23h7"}
            stroke={lineStroke}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeOpacity={mono ? 0.35 : 0.7}
          />
          {/* Curseur 1 avec tête en chevron */}
          <path
            d="M12.5 10v7"
            stroke={cur1Color}
            strokeWidth={1.75}
            strokeLinecap="round"
          />
          <path
            d="M10.5 8.5 L12.5 10.5 L14.5 8.5"
            stroke={cur1Color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Curseur 2 avec tête en chevron */}
          <path
            d="M18.5 15v7"
            stroke={cur2Color}
            strokeWidth={1.75}
            strokeLinecap="round"
          />
          <path
            d="M16.5 13.5 L18.5 15.5 L20.5 13.5"
            stroke={cur2Color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      )}

      {/* PISTE C : "Duo Minimaliste / Geometric" */}
      {track === "C" && (
        <g>
          {/* Silhouette de page épurée */}
          <path
            d="M9 3h10l7 7v16a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"
            fill={sheetFill}
            fillOpacity={mono ? 0.08 : 0.9}
            stroke={sheetStroke}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          <path
            d="M19 3v7h7"
            fill={foldFill}
            fillOpacity={mono ? 0.3 : 0.95}
            stroke={sheetStroke}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {/* Deux barres épaisses collaboratives */}
          <rect x="10" y="14" width="6" height="3" rx="1.5" fill={cur1Color} />
          <rect x="18" y="14" width="4" height="3" rx="1.5" fill={lineStroke} fillOpacity={0.5} />
          <rect x="10" y="20" width="5" height="3" rx="1.5" fill={lineStroke} fillOpacity={0.5} />
          <rect x="17" y="20" width="6" height="3" rx="1.5" fill={cur2Color} />
        </g>
      )}
    </svg>
  );
}

/**
 * Composant Logo officiel "Éditeur Collaboratif".
 * Conforme aux spécifications : mot-symbole en texte HTML (police Geist),
 * jamais en SVG, avec "Éditeur" en gras et "Collaboratif" en plus léger.
 */
export function Logo({
  variant = "wordmark",
  size = "md",
  track = "A",
  mono = false,
  decorative = false,
  hideTextOnMobile = false,
  className = "",
  markClassName = "",
}: LogoProps) {
  const pixelSize = typeof size === "number" ? size : SIZE_MAP[size] ?? 32;

  // Calcul proportionnel des polices pour le mot-symbole
  const textClasses =
    pixelSize <= 20
      ? "text-xs tracking-tight"
      : pixelSize <= 28
      ? "text-sm tracking-tight"
      : pixelSize <= 36
      ? "text-base tracking-tight"
      : pixelSize <= 52
      ? "text-xl tracking-tight"
      : "text-2xl sm:text-3xl tracking-tight";

  const gapClasses =
    pixelSize <= 20 ? "gap-1.5" : pixelSize <= 32 ? "gap-2.5" : pixelSize <= 48 ? "gap-3" : "gap-4";

  // 1. VARIANTE : MARQUE SEULE (SYMBOLE)
  if (variant === "mark") {
    return (
      <div
        className={`inline-flex items-center justify-center shrink-0 ${className}`}
        {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "Éditeur Collaboratif" })}
      >
        <LogoMark
          size={pixelSize}
          track={track}
          mono={mono}
          className={markClassName}
          decorative={decorative}
        />
      </div>
    );
  }

  // Mot-symbole en texte HTML (Geist Sans) : "Éditeur" en gras, "Collaboratif" en plus léger
  const wordmarkNode = (
    <span
      className={`font-sans select-none leading-none ${textClasses} ${
        hideTextOnMobile ? "hidden sm:inline-flex sm:items-baseline" : "inline-flex items-baseline"
      }`}
    >
      <span className="font-bold text-slate-900 dark:text-white mr-1.5">
        Éditeur
      </span>
      <span className="font-normal text-slate-600 dark:text-slate-300">
        Collaboratif
      </span>
    </span>
  );

  // 2. VARIANTE : EMPILÉ (STACKED) POUR ÉCRANS DE CONNEXION ET D'ERREUR
  if (variant === "stacked") {
    return (
      <div
        className={`flex flex-col items-center text-center ${gapClasses} ${className}`}
        {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "Éditeur Collaboratif" })}
      >
        <div className="p-3 rounded-2xl bg-indigo-50/60 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-900/60 shadow-sm backdrop-blur-sm">
          <LogoMark
            size={pixelSize}
            track={track}
            mono={mono}
            className={markClassName}
            decorative={decorative}
          />
        </div>
        <div>
          <span className={`block font-sans select-none leading-tight ${textClasses}`}>
            <span className="font-bold text-slate-900 dark:text-white block sm:inline mr-1.5">
              Éditeur
            </span>
            <span className="font-normal text-slate-600 dark:text-slate-300">
              Collaboratif
            </span>
          </span>
        </div>
      </div>
    );
  }

  // 3. VARIANTE PAR DÉFAUT : WORDMARK EN LIGNE (EN-TÊTES ET BARRES DE NAVIGATION)
  return (
    <div
      className={`inline-flex items-center ${gapClasses} ${className}`}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "Éditeur Collaboratif" })}
    >
      <LogoMark
        size={pixelSize}
        track={track}
        mono={mono}
        className={markClassName}
        decorative={decorative}
      />
      {wordmarkNode}
    </div>
  );
}

export default Logo;
