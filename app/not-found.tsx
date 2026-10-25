import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Logo } from "@/src/components/brand/Logo";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 text-center font-sans">
      <div className="max-w-md w-full bg-slate-900/90 border border-slate-800 rounded-2xl p-8 shadow-2xl backdrop-blur-xl space-y-6">
        <Logo variant="stacked" size={56} className="mx-auto" />

        <div className="space-y-2">
          <span className="inline-block px-3 py-1 text-xs font-semibold uppercase tracking-wider bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded-full">
            Erreur 404
          </span>
          <h1 className="text-xl font-bold text-white tracking-tight">
            Page introuvable
          </h1>
          <p className="text-sm text-slate-400">
            Le document ou la page que vous recherchez n&apos;existe pas ou a été déplacé.
          </p>
        </div>

        <Link
          href="/"
          className="inline-flex items-center justify-center gap-2 w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-xl transition text-sm shadow-lg shadow-indigo-600/30"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Retour au tableau de bord</span>
        </Link>
      </div>
    </div>
  );
}
