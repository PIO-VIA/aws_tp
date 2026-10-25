import { notFound } from "next/navigation";
import Link from "next/link";
import { Logo, LogoMark, LogoTrack } from "@/src/components/brand/Logo";

export const metadata = {
  title: "UI Kit & Identité Visuelle — Éditeur Collaboratif",
  description: "Démonstration des pistes du logo et validation visuelle des composants",
};

export default function UiKitPage() {
  // Page accessible uniquement hors production (SPEC_UI_AGENT.txt § 2.6)
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  const tracks: Array<{
    id: LogoTrack;
    name: string;
    badge: string;
    description: string;
    recommended?: boolean;
  }> = [
    {
      id: "A",
      name: "Piste A : Curseurs Croisés (Dynamic Carets)",
      badge: "Recommandée",
      description:
        "Feuille avec coin replié, 3 lignes stylisées et 2 curseurs de texte verticaux avec pastille de présence (Indigo & Ambre) se croisant sur le texte. Équilibre parfait entre clarté géométrique et narration collaborative.",
      recommended: true,
    },
    {
      id: "B",
      name: "Piste B : Pointeurs Carets (Wedge Carets)",
      badge: "Alternative 1",
      description:
        "Curseurs munis d'un chevron de caret traditionnel marquant les points d'insertion simultanés de chaque rédacteur.",
    },
    {
      id: "C",
      name: "Piste C : Duo Minimaliste (Geometric Minimal)",
      badge: "Alternative 2",
      description:
        "Formes pures et massives maximisant le contraste aux dimensions ultra-réduites (favicon 16x16 px).",
    },
  ];

  const sizes: number[] = [16, 24, 32, 64, 128];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12 font-sans">
      <div className="max-w-6xl mx-auto space-y-12">
        {/* En-tête de la page */}
        <header className="border-b border-slate-800 pb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <span className="py-1 px-2.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-semibold uppercase tracking-wider">
                Kit de Marque &amp; Identité Visuelle
              </span>
              <span className="text-xs text-amber-400 font-medium">Hors production</span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white mt-2">
              Présentation des Pistes de Logo
            </h1>
            <p className="text-sm text-slate-400 mt-1 max-w-2xl">
              Comparaison des 3 propositions de symboles selon les critères de lisibilité à 16 px,
              sur fond clair (&ldquo;Papier&rdquo;) et fond sombre (&ldquo;Nuit&rdquo;), en couleur et monochrome.
            </p>
          </div>

          <Link
            href="/"
            className="self-start md:self-auto px-4 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-xl transition flex items-center gap-1.5"
          >
            <span>Retour à l&apos;accueil</span>
          </Link>
        </header>

        {/* Section 1 : Pistes A, B, C */}
        {tracks.map((track) => (
          <section
            key={track.id}
            className={`rounded-2xl border p-6 md:p-8 space-y-6 ${
              track.recommended
                ? "bg-slate-900/90 border-indigo-500/40 shadow-xl shadow-indigo-950/20 ring-1 ring-indigo-500/30"
                : "bg-slate-900/50 border-slate-800"
            }`}
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-4">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-xl font-bold text-white">{track.name}</h2>
                  <span
                    className={`text-xs px-2.5 py-0.5 rounded-full font-semibold uppercase tracking-wider ${
                      track.recommended
                        ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                        : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    {track.badge}
                  </span>
                </div>
                <p className="text-sm text-slate-400 mt-1">{track.description}</p>
              </div>
            </div>

            {/* Grille : Fond clair vs Fond sombre */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Fond Clair (Papier) */}
              <div className="rounded-xl p-6 bg-slate-50 border border-slate-200 text-slate-900 shadow-sm space-y-4">
                <div className="flex items-center justify-between border-b border-slate-200/80 pb-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-600">
                    Fond Clair — Thème &ldquo;Papier&rdquo;
                  </span>
                  <span className="text-xs text-slate-500 font-mono">bg-slate-50 (#F8FAFC)</span>
                </div>

                <div className="flex flex-wrap items-end gap-6 pt-2">
                  {sizes.map((s) => (
                    <div key={`light-${track.id}-${s}`} className="flex flex-col items-center gap-2">
                      <div className="p-3 rounded-lg bg-white border border-slate-200/60 shadow-xs flex items-center justify-center">
                        <LogoMark size={s} track={track.id} />
                      </div>
                      <span className="text-[11px] font-mono text-slate-500">{s}px</span>
                    </div>
                  ))}
                </div>

                {/* Monochrome sur fond clair */}
                <div className="pt-3 border-t border-slate-200/60">
                  <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block mb-2">
                    Version monochrome (currentColor)
                  </span>
                  <div className="flex items-center gap-4 text-slate-800">
                    <LogoMark size={16} track={track.id} mono />
                    <LogoMark size={24} track={track.id} mono />
                    <LogoMark size={32} track={track.id} mono />
                  </div>
                </div>
              </div>

              {/* Fond Sombre (Nuit) */}
              <div className="rounded-xl p-6 bg-slate-950 border border-slate-800 text-slate-100 shadow-sm space-y-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Fond Sombre — Thème &ldquo;Nuit&rdquo;
                  </span>
                  <span className="text-xs text-slate-500 font-mono">bg-slate-950 (#020617)</span>
                </div>

                <div className="flex flex-wrap items-end gap-6 pt-2">
                  {sizes.map((s) => (
                    <div key={`dark-${track.id}-${s}`} className="flex flex-col items-center gap-2">
                      <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 shadow-xs flex items-center justify-center">
                        <LogoMark size={s} track={track.id} />
                      </div>
                      <span className="text-[11px] font-mono text-slate-500">{s}px</span>
                    </div>
                  ))}
                </div>

                {/* Monochrome sur fond sombre */}
                <div className="pt-3 border-t border-slate-800">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-2">
                    Version monochrome (currentColor)
                  </span>
                  <div className="flex items-center gap-4 text-slate-300">
                    <LogoMark size={16} track={track.id} mono />
                    <LogoMark size={24} track={track.id} mono />
                    <LogoMark size={32} track={track.id} mono />
                  </div>
                </div>
              </div>
            </div>

            {/* Aperçu des variantes du composant Logo */}
            <div className="pt-4 border-t border-slate-800/80">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-4">
                Variantes du composant Logo (mot-symbole en texte HTML Geist)
              </span>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 flex flex-col justify-center items-center text-center">
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider mb-2 font-mono">
                    variant=&quot;mark&quot; (md: 32px)
                  </span>
                  <Logo variant="mark" size="md" track={track.id} />
                </div>

                <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 flex flex-col justify-center items-center text-center">
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider mb-2 font-mono">
                    variant=&quot;wordmark&quot; (en-têtes)
                  </span>
                  <Logo variant="wordmark" size="md" track={track.id} />
                </div>

                <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 flex flex-col justify-center items-center text-center">
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider mb-2 font-mono">
                    variant=&quot;stacked&quot; (connexion, erreurs)
                  </span>
                  <Logo variant="stacked" size="md" track={track.id} />
                </div>
              </div>
            </div>
          </section>
        ))}

        {/* Section 2 : Justification du choix retenu */}
        <section className="rounded-2xl border border-indigo-500/30 bg-indigo-950/20 p-6 md:p-8 space-y-4">
          <div className="flex items-center gap-2 text-indigo-400 font-bold">
            <h3 className="text-lg">Recommandation Officielle : Piste A</h3>
          </div>
          <p className="text-sm text-slate-300 leading-relaxed">
            La <strong>Piste A</strong> allie clarté géométrique et puissance narrative : la pastille
            circulaire surmonte le curseur vertical, évoquant immédiatement l&apos;awareness temps réel
            et les avatars de collaborateurs de l&apos;éditeur.
            À 16 px, la version simplifiée conserve deux lignes et deux curseurs nets, restant
            parfaitement reconnaissable dans l&apos;onglet du navigateur.
            Ses contrastes équilibrés (Indigo #4F46E5 / Ambre #F59E0B) garantissent une excellente
            lisibilité sur fond blanc comme sur fond sombre.
          </p>
        </section>
      </div>
    </div>
  );
}
