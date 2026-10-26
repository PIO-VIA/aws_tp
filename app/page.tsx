"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  TriangleAlert,
  Plus,
  FileText,
  Users,
  Link as LinkIcon,
  ExternalLink,
  Sparkles,
  LogOut,
} from "lucide-react";
import { Logo } from "@/src/components/brand/Logo";
import { ThemeToggle } from "@/src/components/ui/ThemeToggle";
import { EditorsModal } from "@/src/components/documents/EditorsModal";

interface Writer {
  id: string;
  name: string;
  email: string;
}

interface Credit {
  used: number;
  remaining: number;
  resetAt: string;
}

interface SessionData {
  writer: Writer;
  credit: Credit;
  blockedUntil?: number;
}

interface DocumentItem {
  docId: string;
  title: string;
  ownerId: string;
  role: "owner" | "editor" | "viewer";
  createdAt: number;
  updatedAt: number;
}

interface LinkItem {
  linkId: string;
  maxDownloads: number;
  issued: number;
  remaining: number;
  status: string;
  createdAt: number;
}

export default function HomePage() {
  const [session, setSession] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loginName, setLoginName] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Documents
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);

  // Modal Nouveau Document
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [creatingDoc, setCreatingDoc] = useState(false);

  // Modal Rédacteurs & Crédits
  const [shareDoc, setShareDoc] = useState<DocumentItem | null>(null);

  // Modal Liens
  const [linksDoc, setLinksDoc] = useState<DocumentItem | null>(null);
  const [docLinks, setDocLinks] = useState<LinkItem[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [maxCopies, setMaxCopies] = useState<number>(10);
  const [creatingLink, setCreatingLink] = useState(false);
  const [linkCopied, setLinkCopied] = useState<string | null>(null);

  const [now] = useState(() => Math.floor(Date.now() / 1000));

  const fetchDocuments = useCallback(async () => {
    try {
      const res = await fetch("/api/documents");
      if (res.ok) {
        const data = await res.json();
        setDocuments(data.documents || []);
      }
    } catch {
      /* Session non encore active ou indisponible */
    } finally {
      setLoadingDocs(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/session")
      .then(async (res) => {
        if (!active) return;
        if (res.ok) {
          const data = await res.json();
          setSession(data);
        } else {
          setSession(null);
        }
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setSession(null);
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    let active = true;
    fetch("/api/documents")
      .then(async (res) => {
        if (!active) return;
        if (res.ok) {
          const data = await res.json();
          setDocuments(data.documents || []);
        }
        setLoadingDocs(false);
      })
      .catch(() => {
        if (active) setLoadingDocs(false);
      });

    return () => {
      active = false;
    };
  }, [session]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    setIsSubmitting(true);

    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: loginName, email: loginEmail }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.error?.message || "Erreur de connexion");
      } else {
        setSession(data);
      }
    } catch {
      setLoginError("Impossible de se connecter au serveur");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/session", { method: "DELETE" });
    setSession(null);
    setDocuments([]);
  }

  async function handleCreateDocument(e: React.FormEvent) {
    e.preventDefault();
    setCreatingDoc(true);
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      });
      if (res.ok) {
        setNewTitle("");
        setShowCreateModal(false);
        fetchDocuments();
      }
    } catch {
      /* Erreur réseau lors de la création du document */
    } finally {
      setCreatingDoc(false);
    }
  }

  async function openLinksModal(doc: DocumentItem) {
    setLinksDoc(doc);
    setLoadingLinks(true);
    try {
      const res = await fetch(`/api/documents/${doc.docId}/links`);
      if (res.ok) {
        const data = await res.json();
        setDocLinks(data.links || []);
      }
    } catch {
      /* Document ou utilisateur non trouvé */
    } finally {
      setLoadingLinks(false);
    }
  }

  async function handleCreateLink(e: React.FormEvent) {
    e.preventDefault();
    if (!linksDoc || linksDoc.role !== "owner") return;
    setCreatingLink(true);

    try {
      const res = await fetch(`/api/documents/${linksDoc.docId}/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxDownloads: Number(maxCopies) }),
      });
      if (res.ok) {
        const refresh = await fetch(`/api/documents/${linksDoc.docId}/links`);
        if (refresh.ok) {
          const data = await refresh.json();
          setDocLinks(data.links || []);
        }
      }
    } catch {
      /* Erreur réseau lors de la création du lien */
    } finally {
      setCreatingLink(false);
    }
  }

  function copyLinkUrl(linkId: string) {
    const url = `${window.location.origin}/d/${linkId}`;
    navigator.clipboard.writeText(url);
    setLinkCopied(linkId);
    setTimeout(() => setLinkCopied(null), 2500);
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8 bg-slate-50 dark:bg-slate-950">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-indigo-600 border-t-transparent"></div>
      </div>
    );
  }

  // Écran d'authentification plein écran avec image de fond et carte centrée
  if (!session) {
    return (
      <div className="min-h-screen relative flex items-center justify-center p-4 sm:p-6 lg:p-8 overflow-hidden bg-slate-950 text-slate-900 dark:text-slate-100">
        {/* Image de fond plein écran avec superposition élégante */}
        <div className="absolute inset-0 z-0">
          <Image
            src="/brand/login-editorial.jpg"
            alt="Rédaction collaborative pour le journal étudiant"
            fill
            className="object-cover object-center scale-105 transform transition duration-1000 ease-out"
            priority
          />
          {/* Dégradés et voiles pour lisibilité parfaite et contraste premium */}
          <div className="absolute inset-0 bg-slate-950/65 dark:bg-slate-950/80 backdrop-blur-[2px]" />
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-slate-950/80" />
        </div>

        {/* Barre supérieure discrète (Badge à gauche, bascule de thème à droite) */}
        <div className="absolute top-5 left-5 right-5 z-20 flex items-center justify-between pointer-events-none">
          <div className="pointer-events-auto inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900/60 dark:bg-slate-900/80 border border-white/10 text-white/90 text-xs font-medium backdrop-blur-md shadow-lg">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Journal étudiant — Plateforme AWS</span>
          </div>
          <div className="pointer-events-auto bg-slate-900/60 dark:bg-slate-900/80 border border-white/10 rounded-full p-1 backdrop-blur-md shadow-lg">
            <ThemeToggle />
          </div>
        </div>

        {/* Carte formulaire centrée au milieu de l'écran avec effet glassmorphism */}
        <div className="w-full max-w-md relative z-10 my-auto">
          <div className="bg-white/95 dark:bg-slate-900/90 backdrop-blur-xl border border-white/40 dark:border-slate-800/80 rounded-3xl shadow-2xl shadow-black/40 p-6 sm:p-8 transition-all">
            {/* En-tête avec logo et description */}
            <div className="text-center mb-6">
              <div className="flex justify-center mb-3">
                <Logo variant="stacked" size={48} />
              </div>
              <h1 className="text-xl font-bold font-serif text-slate-950 dark:text-white tracking-tight">
                Connexion Rédacteur
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-xs mx-auto">
                Espace de rédaction collaborative et diffusion de tirages limités
              </p>
            </div>

            {/* Formulaire de connexion */}
            <form onSubmit={handleLogin} className="space-y-4">
              {loginError && (
                <div className="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-xl text-rose-700 dark:text-rose-300 text-xs flex items-center gap-2">
                  <TriangleAlert className="w-4 h-4 shrink-0" />
                  <span>{loginError}</span>
                </div>
              )}

              <div>
                <label
                  htmlFor="name-input"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5 uppercase tracking-wider"
                >
                  Nom complet
                </label>
                <input
                  id="name-input"
                  type="text"
                  required
                  value={loginName}
                  onChange={(e) => setLoginName(e.target.value)}
                  placeholder="Ex. Alice Dupont"
                  className="w-full px-3.5 py-2.5 bg-slate-50 dark:bg-slate-950/70 border border-slate-300 dark:border-slate-700 rounded-xl text-slate-900 dark:text-white placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition shadow-xs"
                />
              </div>

              <div>
                <label
                  htmlFor="email-input"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5 uppercase tracking-wider"
                >
                  Adresse e-mail
                </label>
                <input
                  id="email-input"
                  type="email"
                  required
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="alice@asso.fr"
                  className="w-full px-3.5 py-2.5 bg-slate-50 dark:bg-slate-950/70 border border-slate-300 dark:border-slate-700 rounded-xl text-slate-900 dark:text-white placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition shadow-xs"
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 text-white rounded-xl font-semibold text-sm transition shadow-md shadow-indigo-600/30 flex items-center justify-center gap-2 cursor-pointer mt-2"
              >
                {isSubmitting ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white"></div>
                    <span>Connexion en cours...</span>
                  </>
                ) : (
                  "Accéder à la rédaction"
                )}
              </button>
            </form>

            {/* Comptes de test rapide */}
            <div className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-800/80">
              <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium mb-2.5 text-center">
                Comptes de test rapide :
              </p>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setLoginName("Alice Dupont");
                    setLoginEmail("alice@asso.fr");
                  }}
                  className="px-2 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800/90 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs rounded-xl transition text-center cursor-pointer font-medium border border-transparent hover:border-slate-300 dark:hover:border-slate-600"
                >
                  Alice
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLoginName("Bob Martin");
                    setLoginEmail("bob@asso.fr");
                  }}
                  className="px-2 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800/90 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs rounded-xl transition text-center cursor-pointer font-medium border border-transparent hover:border-slate-300 dark:hover:border-slate-600"
                >
                  Bob
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLoginName("Charlie Dubois");
                    setLoginEmail("charlie@asso.fr");
                  }}
                  className="px-2 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800/90 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs rounded-xl transition text-center cursor-pointer font-medium border border-transparent hover:border-slate-300 dark:hover:border-slate-600"
                >
                  Charlie
                </button>
              </div>
            </div>

            {/* Note éditoriale discrète en bas de carte */}
            <div className="mt-5 text-center">
              <p className="text-[10px] text-slate-400 dark:text-slate-500">
                Solution sécurisée hébergée sur AWS Cloud
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Tableau de bord principal
  const isBlocked = session.blockedUntil && session.blockedUntil > now;
  const creditPercent = Math.min(100, Math.round((session.credit.used / 10000) * 100));

  return (
    <div className="min-h-screen flex flex-col bg-slate-100/70 dark:bg-slate-950 text-slate-900 dark:text-slate-100 transition-colors duration-150">
      {/* Barre de navigation */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/80 backdrop-blur-md sticky top-0 z-30 px-4 sm:px-8 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Logo variant="wordmark" size="md" hideTextOnMobile />
          <span className="hidden md:inline-block text-xs py-0.5 px-2.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 font-medium">
            Association AWS
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <p className="text-xs font-bold text-slate-900 dark:text-white leading-tight">{session.writer.name}</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">{session.writer.email}</p>
          </div>

          <ThemeToggle size="sm" />

          <button
            onClick={handleLogout}
            className="p-2 sm:px-3 sm:py-1.5 text-xs bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-xl transition cursor-pointer inline-flex items-center gap-1.5"
            title="Se déconnecter"
            aria-label="Déconnexion"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Déconnexion</span>
          </button>
        </div>
      </header>

      {/* Contenu principal */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 sm:p-8 space-y-6">
        {/* Alerte blocage si actif */}
        {isBlocked && (
          <div className="p-4 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 rounded-2xl text-rose-800 dark:text-rose-200 text-xs flex items-start gap-3 shadow-xs">
            <TriangleAlert className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-sm">Compte rédacteur temporairement bloqué</p>
              <p className="mt-0.5 leading-relaxed">
                Vous ne pouvez pas apporter de modifications ou créer de liens jusqu&apos;à expiration de la sanction le{" "}
                {new Date(session.blockedUntil! * 1000).toLocaleTimeString("fr-FR")} (heure locale).
              </p>
            </div>
          </div>
        )}

        {/* Bannière héroïque éditoriale pleine largeur avec image en arrière-plan */}
        <div className="relative overflow-hidden rounded-3xl min-h-[220px] sm:min-h-[250px] p-6 sm:p-10 flex flex-col justify-center border border-slate-200 dark:border-slate-800 shadow-md">
          {/* Image de fond avec superposition de dégradé cinématique */}
          <div className="absolute inset-0 z-0">
            <Image
              src="/brand/dashboard-editorial.jpg"
              alt="Atelier éditorial du journal étudiant"
              fill
              className="object-cover object-center scale-105 transition duration-700 ease-out"
              priority
            />
            {/* Voile sombre et dégradé latéral pour une lisibilité parfaite des textes */}
            <div className="absolute inset-0 bg-slate-950/75 dark:bg-slate-950/80 backdrop-blur-[1px]" />
            <div className="absolute inset-0 bg-gradient-to-r from-slate-950 via-slate-950/80 to-transparent" />
          </div>

          {/* Contenu textuel et actions au-dessus du fond */}
          <div className="relative z-10 space-y-3 max-w-xl">
            <div className="inline-flex items-center gap-1.5 py-1 px-3 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-400/30 backdrop-blur-md w-fit shadow-xs">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Salle de rédaction</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold font-serif text-white leading-tight tracking-tight">
              Bonjour, {session.writer.name}
            </h2>
            <p className="text-xs sm:text-sm text-slate-200 leading-relaxed font-sans">
              Bienvenue dans votre atelier de rédaction collaborative. Écrivez à plusieurs sur les articles en temps réel et générez vos liens de tirage à diffusion limitée.
            </p>
            <div className="pt-2">
              <button
                onClick={() => setShowCreateModal(true)}
                className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white rounded-xl text-xs sm:text-sm font-semibold transition shadow-md shadow-indigo-600/40 flex items-center gap-2 cursor-pointer w-fit"
              >
                <Plus className="w-4 h-4" />
                <span>Nouveau document</span>
              </button>
            </div>
          </div>
        </div>

        {/* Jauge de crédit d'écriture (10 000 car/jour - Section 14.4 (2) & C4) */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Crédit d&apos;écriture quotidien</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Chaque insertion de caractère UTF-16 consomme du crédit. Remise à zéro à 00:00 UTC.
              </p>
            </div>
            <div className="text-left sm:text-right">
              <span className="text-base font-bold text-indigo-600 dark:text-indigo-400">
                {session.credit.remaining.toLocaleString("fr-FR")}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400"> / 10 000 caractères restants</span>
            </div>
          </div>

          {/* Barre de progression */}
          <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-3 overflow-hidden p-0.5 border border-slate-200 dark:border-slate-700">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                creditPercent > 90
                  ? "bg-rose-500"
                  : creditPercent > 70
                  ? "bg-amber-500"
                  : "bg-indigo-600 dark:bg-indigo-500"
              }`}
              style={{ width: `${Math.min(100, Math.max(3, creditPercent))}%` }}
            ></div>
          </div>

          <div className="flex justify-between items-center text-[11px] text-slate-500 dark:text-slate-400 mt-2">
            <span>Consommés : {session.credit.used.toLocaleString("fr-FR")} car. ({creditPercent}%)</span>
            <span>Réinitialisation : {new Date(session.credit.resetAt).toLocaleTimeString("fr-FR", { timeZone: "UTC" })} UTC</span>
          </div>
        </div>

        {/* Section Documents */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">Documents de travail</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">Articles créés ou partagés avec votre équipe</p>
            </div>

            <button
              onClick={() => setShowCreateModal(true)}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition shadow-xs flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Créer un article</span>
            </button>
          </div>

          {loadingDocs ? (
            <div className="p-8 text-center text-slate-400 text-xs">Chargement des documents…</div>
          ) : documents.length === 0 ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 border-dashed rounded-3xl p-12 text-center shadow-xs">
              <FileText className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Aucun document pour l&apos;instant</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
                Créez votre premier article pour commencer à collaborer en direct avec vos collègues.
              </p>
              <button
                onClick={() => setShowCreateModal(true)}
                className="mt-4 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition shadow-xs cursor-pointer inline-flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>Nouveau document</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {documents.map((doc) => (
                <div
                  key={doc.docId}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-indigo-400 dark:hover:border-indigo-600 rounded-2xl p-5 flex flex-col justify-between transition shadow-xs hover:shadow-md group"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <h4 className="font-semibold text-slate-900 dark:text-white text-base group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition line-clamp-2">
                        {doc.title}
                      </h4>
                      <span
                        className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0 border ${
                          doc.role === "owner"
                            ? "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/60 dark:text-purple-300 dark:border-purple-800"
                            : doc.role === "editor"
                            ? "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-800"
                            : "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700"
                        }`}
                      >
                        {doc.role === "owner" ? "Propriétaire" : doc.role === "editor" ? "Éditeur" : "Lecteur"}
                      </span>
                    </div>

                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                      Mis à jour le {new Date(doc.updatedAt * 1000).toLocaleString("fr-FR")}
                    </p>
                  </div>

                  <div className="pt-4 mt-4 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2">
                    <Link
                      href={`/editor/${doc.docId}`}
                      className="flex-1 py-1.5 px-3 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl text-center transition shadow-xs"
                    >
                      Ouvrir
                    </Link>

                    {doc.role === "owner" && (
                      <button
                        onClick={() => setShareDoc(doc)}
                        className="py-1.5 px-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-xs rounded-xl transition cursor-pointer flex items-center gap-1.5"
                        title="Consulter les rédacteurs et leurs crédits restants"
                        aria-label="Rédacteurs et crédits"
                      >
                        <Users className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                        <span className="hidden sm:inline font-medium">Rédacteurs</span>
                      </button>
                    )}

                    {doc.role !== "viewer" && (
                      <button
                        onClick={() => openLinksModal(doc)}
                        className="p-1.5 px-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-xs rounded-xl transition cursor-pointer"
                        title="Gérer les liens de tirage PDF"
                        aria-label="Liens"
                      >
                        <LinkIcon className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* MODAL : CRÉER UN DOCUMENT */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-2xl animate-in zoom-in-95 duration-150">
            <h3 className="text-base font-bold text-slate-900 dark:text-white mb-1">Nouveau document</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">Donnez un titre à votre journal ou article de rédaction.</p>

            <form onSubmit={handleCreateDocument} className="space-y-4">
              <div>
                <label htmlFor="doc-title-input" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1 uppercase tracking-wider">
                  Titre du document
                </label>
                <input
                  id="doc-title-input"
                  type="text"
                  required
                  autoFocus
                  placeholder="Ex. Édition spéciale de printemps 2026"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-slate-900 dark:text-white placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-xl transition cursor-pointer"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={creatingDoc}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl transition shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {creatingDoc ? "Création…" : "Créer le document"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL : RÉDACTEURS ET CRÉDITS D'ÉCRITURE */}
      {shareDoc && (
        <EditorsModal
          docId={shareDoc.docId}
          docTitle={shareDoc.title}
          isOpen={!!shareDoc}
          onClose={() => setShareDoc(null)}
          onEditorsChanged={fetchDocuments}
        />
      )}

      {/* MODAL : LIENS DE DIFFUSION DE TIRAGE */}
      {linksDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-2xl max-h-[85vh] flex flex-col animate-in zoom-in-95 duration-150">
            <h3 className="text-base font-bold text-slate-900 dark:text-white mb-1">Liens de diffusion (Tirage limité)</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4 truncate">{linksDoc.title}</p>

            {/* Formulaire de création d'un lien (réservé au propriétaire) */}
            {linksDoc.role === "owner" ? (
              <form onSubmit={handleCreateLink} className="p-3 bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-2xl mb-4">
                <div className="flex items-end gap-3">
                  <div className="flex-1">
                    <label htmlFor="copies-input" className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1 uppercase tracking-wider">
                      Nombre d&apos;exemplaires autorisés (1..1000)
                    </label>
                    <input
                      id="copies-input"
                      type="number"
                      min={1}
                      max={1000}
                      value={maxCopies}
                      onChange={(e) => setMaxCopies(Number(e.target.value))}
                      className="w-full px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={creatingLink}
                    className="py-2 px-3.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl transition shadow-xs disabled:opacity-50 shrink-0 cursor-pointer"
                  >
                    {creatingLink ? "Création…" : "Générer le lien"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="p-3 bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-2xl mb-4 text-xs text-slate-500 dark:text-slate-400">
                Seul le propriétaire du document peut générer de nouveaux liens de tirage. Vous pouvez consulter et tester les liens existants ci-dessous.
              </div>
            )}

            {/* Liste des liens existants */}
            <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
              <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">Liens actifs</h4>
              {loadingLinks ? (
                <p className="text-xs text-slate-400 text-center py-4">Chargement des liens…</p>
              ) : docLinks.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-4">Aucun lien généré pour le moment.</p>
              ) : (
                docLinks.map((l) => (
                  <div
                    key={l.linkId}
                    className="p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl flex items-center justify-between gap-3 text-xs"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-medium text-indigo-600 dark:text-indigo-400">/d/{l.linkId}</span>
                        <span
                          className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                            l.remaining === 0
                              ? "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300"
                              : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                          }`}
                        >
                          {l.remaining === 0 ? "Épuisé" : `${l.remaining} restant(s)`}
                        </span>
                      </div>
                      <p className="text-slate-500 dark:text-slate-400 text-[11px] mt-0.5">
                        Consommés : {l.issued} / {l.maxDownloads} exemplaires
                      </p>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => copyLinkUrl(l.linkId)}
                        className="py-1 px-2.5 bg-white hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-lg transition cursor-pointer"
                      >
                        {linkCopied === l.linkId ? "Copié !" : "Copier"}
                      </button>
                      <a
                        href={`/d/${l.linkId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="py-1 px-2.5 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/40 dark:hover:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 rounded-lg transition flex items-center gap-1"
                      >
                        <span>Tester</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="pt-4 mt-2 border-t border-slate-200 dark:border-slate-800 flex justify-end">
              <button
                type="button"
                onClick={() => setLinksDoc(null)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-xl transition cursor-pointer"
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
