"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Logo } from "@/src/components/brand/Logo";
import { ThemeToggle } from "@/src/components/ui/ThemeToggle";

interface OpenDoc {
  docId: string;
  title: string;
  connections: number;
  lastActivityAt: number;
}

interface ActiveLink {
  linkId: string;
  docId: string;
  title: string;
  maxDownloads: number;
  issued: number;
  remaining: number;
  creator: string;
}

interface BlockedWriter {
  writerId: string;
  name: string;
  email: string;
  blockedUntil: number;
  reason: string;
}

interface OverviewData {
  openDocuments: OpenDoc[];
  activeLinks: ActiveLink[];
  blockedWriters: BlockedWriter[];
}

export default function AdminPage() {
  const [token, setToken] = useState<string>("");
  const [tokenInput, setTokenInput] = useState<string>("");
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [unblockingId, setUnblockingId] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string>("");

  useEffect(() => {
    const saved = sessionStorage.getItem("admin_token") || "";
    if (saved) {
      const timer = setTimeout(() => {
        setToken(saved);
        setTokenInput(saved);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, []);

  const fetchOverview = useCallback(
    async (adminToken: string) => {
      if (!adminToken) return;
      try {
        const res = await fetch("/api/admin/overview", {
          headers: {
            "x-admin-token": adminToken,
          },
        });
        if (!res.ok) {
          if (res.status === 401) {
            setError("Jeton administrateur invalide");
            setData(null);
            return;
          }
          throw new Error(`Erreur HTTP ${res.status}`);
        }
        const json = (await res.json()) as OverviewData;
        setData(json);
        setError(null);
        setLastRefreshedAt(new Date().toLocaleTimeString());
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Erreur de chargement");
      }
    },
    [],
  );

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = tokenInput.trim();
    if (!clean) return;
    setLoading(true);
    sessionStorage.setItem("admin_token", clean);
    setToken(clean);
    fetchOverview(clean).finally(() => setLoading(false));
  };

  const handleLogout = () => {
    sessionStorage.removeItem("admin_token");
    setToken("");
    setData(null);
    setError(null);
  };

  // Rafraîchissement automatique toutes les 5 secondes (F10)
  useEffect(() => {
    if (!token) return;
    const initialTimer = setTimeout(() => {
      void fetchOverview(token);
    }, 0);
    const interval = setInterval(() => {
      void fetchOverview(token);
    }, 5000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [token, fetchOverview]);

  const handleUnblock = async (writerId: string) => {
    if (!token) return;
    setUnblockingId(writerId);
    try {
      const res = await fetch("/api/admin/unblock", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token,
        },
        body: JSON.stringify({ writerId }),
      });
      if (res.ok) {
        fetchOverview(token);
      } else {
        alert("Échec du déblocage");
      }
    } catch {
      alert("Erreur réseau");
    } finally {
      setUnblockingId(null);
    }
  };

  if (!token) {
    return (
      <main className="min-h-screen bg-slate-100/70 dark:bg-neutral-950 text-slate-900 dark:text-neutral-100 flex items-center justify-center p-4 relative transition-colors duration-150">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <div className="w-full max-w-md bg-white dark:bg-neutral-900/90 border border-slate-200 dark:border-neutral-800 p-8 rounded-3xl shadow-xl backdrop-blur-md">
          <Logo variant="stacked" size={52} className="mb-6" />
          <div className="flex items-center gap-3 mb-4">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse"></span>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">Supervision Association</h1>
          </div>
          <p className="text-xs sm:text-sm text-slate-600 dark:text-neutral-400 mb-6">
            Veuillez saisir votre jeton administrateur pour accéder au tableau de bord en temps réel.
          </p>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-neutral-400 mb-2">
                Jeton Administrateur (ADMIN_TOKEN)
              </label>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Entrez le jeton admin..."
                className="w-full px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-neutral-800 border border-slate-300 dark:border-neutral-700 text-slate-900 dark:text-neutral-100 placeholder-slate-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                autoFocus
              />
            </div>
            {error && <p className="text-xs text-rose-500 font-medium">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-semibold text-white transition-colors cursor-pointer shadow-lg shadow-indigo-600/30 disabled:opacity-50"
            >
              {loading ? "Vérification..." : "Accéder à la supervision"}
            </button>
          </form>

          <div className="mt-6 text-center">
            <Link href="/" className="text-xs text-slate-500 hover:text-slate-700 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors inline-flex items-center gap-1.5">
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Retour à l&apos;accueil rédacteur</span>
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-100/70 dark:bg-neutral-950 text-slate-900 dark:text-neutral-100 p-4 sm:p-6 md:p-10 font-sans transition-colors duration-150">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* En-tête */}
        <header className="flex flex-col md:flex-row md:items-center justify-between pb-6 border-b border-slate-200 dark:border-neutral-800 gap-4">
          <div className="flex items-center gap-4">
            <Logo variant="mark" size="lg" className="p-2 rounded-2xl bg-white dark:bg-neutral-900 border border-slate-200 dark:border-neutral-800 shadow-xs" />
            <div>
              <div className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping"></span>
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Supervision &amp; Administration</h1>
              </div>
              <p className="text-xs text-slate-500 dark:text-neutral-400 mt-1">
                Tableau rafraîchi toutes les 5 s • Dernière mise à jour : {lastRefreshedAt || "en cours..."}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle size="sm" />
            <button
              onClick={() => fetchOverview(token)}
              className="px-3.5 py-1.5 text-xs font-medium rounded-xl bg-white dark:bg-neutral-800 hover:bg-slate-100 dark:hover:bg-neutral-700 text-slate-700 dark:text-neutral-200 border border-slate-200 dark:border-neutral-700 transition cursor-pointer"
            >
              Rafraîchir
            </button>
            <Link
              href="/"
              className="px-3.5 py-1.5 text-xs font-medium rounded-xl bg-white dark:bg-neutral-800 hover:bg-slate-100 dark:hover:bg-neutral-700 text-slate-700 dark:text-neutral-200 border border-slate-200 dark:border-neutral-700 transition"
            >
              Espace rédacteur
            </Link>
            <button
              onClick={handleLogout}
              className="px-3.5 py-1.5 text-xs font-medium rounded-xl bg-rose-50 dark:bg-red-950/60 hover:bg-rose-100 dark:hover:bg-red-900/80 text-rose-700 dark:text-red-300 border border-rose-200 dark:border-red-800/60 transition cursor-pointer"
            >
              Déconnexion
            </button>
          </div>
        </header>

        {error && (
          <div className="p-4 rounded-xl bg-red-950/40 border border-red-800 text-red-200 text-sm">
            {error}
          </div>
        )}

        {/* 1. Documents ouverts */}
        <section className="bg-neutral-900/60 border border-neutral-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-indigo-500"></span>
              <h2 className="text-lg font-semibold tracking-tight">1. Documents ouverts en direct</h2>
            </div>
            <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              {data?.openDocuments.length || 0} actif(s)
            </span>
          </div>

          {data?.openDocuments.length === 0 ? (
            <p className="text-sm text-neutral-500 italic py-4">Aucun document n&apos;est actuellement ouvert.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-800 text-neutral-400 text-xs uppercase tracking-wider">
                    <th className="pb-3 font-medium">Titre du document</th>
                    <th className="pb-3 font-medium">Identifiant (docId)</th>
                    <th className="pb-3 font-medium text-center">Connexions actives</th>
                    <th className="pb-3 font-medium text-right">Dernière activité</th>
                    <th className="pb-3 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800/50">
                  {data?.openDocuments.map((doc) => (
                    <tr key={doc.docId} className="hover:bg-neutral-800/30 transition-colors">
                      <td className="py-3.5 font-medium text-neutral-100">{doc.title}</td>
                      <td className="py-3.5 font-mono text-xs text-neutral-400">{doc.docId}</td>
                      <td className="py-3.5 text-center">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800">
                          {doc.connections} en ligne
                        </span>
                      </td>
                      <td className="py-3.5 text-right text-xs text-neutral-400 font-mono">
                        {new Date(doc.lastActivityAt * 1000).toLocaleTimeString()}
                      </td>
                      <td className="py-3.5 text-right">
                        <Link
                          href={`/editor/${doc.docId}`}
                          className="text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors inline-flex items-center gap-1"
                        >
                          <span>Ouvrir l&apos;éditeur</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 2. Liens de téléchargement actifs */}
        <section className="bg-neutral-900/60 border border-neutral-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-500"></span>
              <h2 className="text-lg font-semibold tracking-tight">2. Liens de téléchargement actifs</h2>
            </div>
            <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
              {data?.activeLinks.length || 0} lien(s)
            </span>
          </div>

          {data?.activeLinks.length === 0 ? (
            <p className="text-sm text-neutral-500 italic py-4">Aucun lien de téléchargement actif.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-800 text-neutral-400 text-xs uppercase tracking-wider">
                    <th className="pb-3 font-medium">Document</th>
                    <th className="pb-3 font-medium">Lien public</th>
                    <th className="pb-3 font-medium">Créateur</th>
                    <th className="pb-3 font-medium text-center">Distribués</th>
                    <th className="pb-3 font-medium text-center">Restants</th>
                    <th className="pb-3 font-medium text-right">Statut</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800/50">
                  {data?.activeLinks.map((link) => (
                    <tr key={link.linkId} className="hover:bg-neutral-800/30 transition-colors">
                      <td className="py-3.5 font-medium text-neutral-100">{link.title}</td>
                      <td className="py-3.5">
                        <Link
                          href={`/d/${link.linkId}`}
                          target="_blank"
                          className="font-mono text-xs text-indigo-400 hover:underline"
                        >
                          /d/{link.linkId}
                        </Link>
                      </td>
                      <td className="py-3.5 text-xs text-neutral-300">{link.creator}</td>
                      <td className="py-3.5 text-center font-mono text-xs text-neutral-300">
                        {link.issued} / {link.maxDownloads}
                      </td>
                      <td className="py-3.5 text-center">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
                            link.remaining > 0
                              ? "bg-cyan-950 text-cyan-400 border border-cyan-800"
                              : "bg-red-950 text-red-400 border border-red-800"
                          }`}
                        >
                          {link.remaining} restant(s)
                        </span>
                      </td>
                      <td className="py-3.5 text-right">
                        <span className="text-xs text-emerald-400 font-medium">Actif</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 3. Rédacteurs bloqués pour abus */}
        <section className="bg-neutral-900/60 border border-neutral-800/80 rounded-2xl p-6 shadow-xl backdrop-blur-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500"></span>
              <h2 className="text-lg font-semibold tracking-tight">3. Rédacteurs bloqués pour abus (F08, F10)</h2>
            </div>
            <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-red-500/20 text-red-300 border border-red-500/30">
              {data?.blockedWriters.length || 0} sanctionné(s)
            </span>
          </div>

          {data?.blockedWriters.length === 0 ? (
            <p className="text-sm text-neutral-500 italic py-4">Aucun rédacteur n&apos;est actuellement bloqué.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-800 text-neutral-400 text-xs uppercase tracking-wider">
                    <th className="pb-3 font-medium">Rédacteur</th>
                    <th className="pb-3 font-medium">E-mail</th>
                    <th className="pb-3 font-medium">Raison</th>
                    <th className="pb-3 font-medium">Fin de blocage (UTC / locale)</th>
                    <th className="pb-3 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800/50">
                  {data?.blockedWriters.map((writer) => {
                    const blockDate = new Date(writer.blockedUntil * 1000);
                    return (
                      <tr key={writer.writerId} className="hover:bg-neutral-800/30 transition-colors">
                        <td className="py-3.5 font-medium text-neutral-100">{writer.name}</td>
                        <td className="py-3.5 text-xs text-neutral-400 font-mono">{writer.email}</td>
                        <td className="py-3.5 text-xs text-red-300 max-w-xs">{writer.reason}</td>
                        <td className="py-3.5 text-xs text-neutral-300 font-mono">
                          {blockDate.toISOString().slice(11, 19)} UTC ({blockDate.toLocaleTimeString()})
                        </td>
                        <td className="py-3.5 text-right">
                          <button
                            onClick={() => handleUnblock(writer.writerId)}
                            disabled={unblockingId === writer.writerId}
                            className="px-3 py-1 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition cursor-pointer disabled:opacity-50"
                          >
                            {unblockingId === writer.writerId ? "Déblocage..." : "Débloquer"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
