"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";

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

  // Modal Partage
  const [shareDoc, setShareDoc] = useState<DocumentItem | null>(null);
  const [shareEmail, setShareEmail] = useState("");
  const [shareRole, setShareRole] = useState<"editor" | "viewer">("editor");
  const [shareLoading, setShareLoading] = useState(false);
  const [shareMessage, setShareMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

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
      // Ignorer
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
      // Erreur
    } finally {
      setCreatingDoc(false);
    }
  }

  async function handleShare(e: React.FormEvent) {
    e.preventDefault();
    if (!shareDoc) return;
    setShareLoading(true);
    setShareMessage(null);

    try {
      const res = await fetch(`/api/documents/${shareDoc.docId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: shareEmail, role: shareRole }),
      });
      const data = await res.json();
      if (!res.ok) {
        setShareMessage({ type: "error", text: data.error?.message || "Erreur lors du partage" });
      } else {
        setShareMessage({ type: "success", text: `Partagé avec succès avec ${shareEmail} (${shareRole})` });
        setShareEmail("");
      }
    } catch {
      setShareMessage({ type: "error", text: "Erreur réseau" });
    } finally {
      setShareLoading(false);
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
      // Ignorer
    } finally {
      setLoadingLinks(false);
    }
  }

  async function handleCreateLink(e: React.FormEvent) {
    e.preventDefault();
    if (!linksDoc) return;
    setCreatingLink(true);

    try {
      const res = await fetch(`/api/documents/${linksDoc.docId}/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxDownloads: Number(maxCopies) }),
      });
      if (res.ok) {
        // Rafraîchir les liens
        const refresh = await fetch(`/api/documents/${linksDoc.docId}/links`);
        if (refresh.ok) {
          const data = await refresh.json();
          setDocLinks(data.links || []);
        }
      }
    } catch {
      // Erreur
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
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  // ÉCRAN 1 : FORMULAIRE DE CONNEXION
  if (!session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8 bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950">
        <div className="w-full max-w-md bg-slate-900/90 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl backdrop-blur-xl">
          <div className="text-center mb-6">
            <span className="inline-block py-1 px-3 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-full text-xs font-medium tracking-wide uppercase mb-3">
              Association Étudiante AWS
            </span>
            <h1 className="text-2xl font-bold text-white tracking-tight">
              Éditeur Collaboratif
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Synchronisation CRDT Yjs temps réel &amp; diffusion à tirage limité
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            {loginError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-300 text-sm">
                {loginError}
              </div>
            )}

            <div>
              <label htmlFor="name-input" className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
                Nom complet
              </label>
              <input
                id="name-input"
                type="text"
                required
                value={loginName}
                onChange={(e) => setLoginName(e.target.value)}
                placeholder="Ex. Alice Dupont"
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-slate-700/80 rounded-xl text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
              />
            </div>

            <div>
              <label htmlFor="email-input" className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
                Adresse e-mail
              </label>
              <input
                id="email-input"
                type="email"
                required
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                placeholder="alice@asso.fr"
                className="w-full px-3.5 py-2.5 bg-slate-950/70 border border-slate-700/80 rounded-xl text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 text-white rounded-xl font-medium text-sm transition shadow-lg shadow-indigo-600/25 flex items-center justify-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white"></div>
                  <span>Connexion en cours...</span>
                </>
              ) : (
                "Accéder à l'espace de travail"
              )}
            </button>
          </form>

          {/* Raccourcis de test rapide */}
          <div className="mt-6 pt-5 border-t border-slate-800">
            <p className="text-xs text-slate-400 font-medium mb-2 text-center">
              Comptes préconfigurés (après <code className="text-indigo-400 font-mono">npm run seed</code>) :
            </p>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => {
                  setLoginName("Alice Dupont");
                  setLoginEmail("alice@asso.fr");
                }}
                className="px-2 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded-lg transition text-center"
              >
                Alice (Owner)
              </button>
              <button
                type="button"
                onClick={() => {
                  setLoginName("Bob Martin");
                  setLoginEmail("bob@asso.fr");
                }}
                className="px-2 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded-lg transition text-center"
              >
                Bob (Editor)
              </button>
              <button
                type="button"
                onClick={() => {
                  setLoginName("Charlie Dubois");
                  setLoginEmail("charlie@asso.fr");
                }}
                className="px-2 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded-lg transition text-center"
              >
                Charlie (Viewer)
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ÉCRAN 2 : TABLEAU DE BORD AUTHENTIFIÉ
  const isBlocked = session.blockedUntil && session.blockedUntil > now;
  const creditPercent = Math.min(100, Math.round((session.credit.used / 10000) * 100));

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Barre de navigation */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md sticky top-0 z-30 px-4 sm:px-8 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center font-bold text-white shadow-md shadow-indigo-600/30">
            EC
          </div>
          <div>
            <h1 className="font-semibold text-sm text-white leading-tight">Éditeur Collaboratif</h1>
            <p className="text-xs text-slate-400">Association Étudiante AWS</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right hidden sm:block">
            <p className="text-sm font-medium text-slate-200">{session.writer.name}</p>
            <p className="text-xs text-slate-400">{session.writer.email}</p>
          </div>

          <button
            onClick={handleLogout}
            className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg transition"
          >
            Déconnexion
          </button>
        </div>
      </header>

      {/* Contenu principal */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 sm:p-8 space-y-6">
        {/* Alerte blocage si actif */}
        {isBlocked && (
          <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-sm flex items-start gap-3">
            <span className="text-lg">⚠️</span>
            <div>
              <p className="font-semibold">Compte rédacteur temporairement bloqué</p>
              <p className="text-xs text-rose-300/80 mt-0.5">
                Vous ne pouvez pas apporter de modifications ou créer de liens jusqu&apos;à expiration de la sanction le{" "}
                {new Date(session.blockedUntil! * 1000).toLocaleTimeString("fr-FR")} (heure locale).
              </p>
            </div>
          </div>
        )}

        {/* Jauge de crédit d'écriture (10 000 car/jour - Section 14.4 (2) & C4) */}
        <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5 shadow-lg">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-200">Crédit d&apos;écriture quotidien</h2>
              <p className="text-xs text-slate-400">
                Chaque insertion de caractère UTF-16 consomme du crédit. Remise à zéro à 00:00 UTC.
              </p>
            </div>
            <div className="text-right">
              <span className="text-base font-bold text-indigo-400">
                {session.credit.remaining.toLocaleString("fr-FR")}
              </span>
              <span className="text-xs text-slate-400"> / 10 000 caractères restants</span>
            </div>
          </div>

          {/* Barre de progression */}
          <div className="w-full bg-slate-800/80 rounded-full h-3 overflow-hidden p-0.5 border border-slate-700/50">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                creditPercent > 90
                  ? "bg-rose-500"
                  : creditPercent > 70
                  ? "bg-amber-500"
                  : "bg-indigo-500"
              }`}
              style={{ width: `${Math.min(100, Math.max(3, creditPercent))}%` }}
            ></div>
          </div>

          <div className="flex justify-between items-center text-[11px] text-slate-400 mt-2">
            <span>Consommés : {session.credit.used.toLocaleString("fr-FR")} car. ({creditPercent}%)</span>
            <span>Réinitialisation : {new Date(session.credit.resetAt).toLocaleTimeString("fr-FR", { timeZone: "UTC" })} UTC</span>
          </div>
        </div>

        {/* Section Documents */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">Documents</h2>
              <p className="text-xs text-slate-400">Documents créés ou partagés avec vous</p>
            </div>

            <button
              onClick={() => setShowCreateModal(true)}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition shadow-md shadow-indigo-600/20 flex items-center gap-1.5"
            >
              <span>+</span>
              <span>Nouveau document</span>
            </button>
          </div>

          {loadingDocs ? (
            <div className="p-8 text-center text-slate-500 text-sm">Chargement des documents...</div>
          ) : documents.length === 0 ? (
            <div className="bg-slate-900/40 border border-slate-800/80 border-dashed rounded-2xl p-12 text-center">
              <p className="text-sm font-medium text-slate-300">Aucun document disponible</p>
              <p className="text-xs text-slate-400 mt-1">Créez votre premier document pour commencer à écrire.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {documents.map((doc) => (
                <div
                  key={doc.docId}
                  className="bg-slate-900/70 border border-slate-800/80 hover:border-slate-700 rounded-2xl p-5 flex flex-col justify-between transition shadow-md group"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <h3 className="font-semibold text-white text-base group-hover:text-indigo-300 transition line-clamp-2">
                        {doc.title}
                      </h3>
                      <span
                        className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0 border ${
                          doc.role === "owner"
                            ? "bg-purple-500/10 text-purple-300 border-purple-500/30"
                            : doc.role === "editor"
                            ? "bg-indigo-500/10 text-indigo-300 border-indigo-500/30"
                            : "bg-slate-700/30 text-slate-400 border-slate-600/30"
                        }`}
                      >
                        {doc.role === "owner" ? "Propriétaire" : doc.role === "editor" ? "Éditeur" : "Lecteur"}
                      </span>
                    </div>

                    <p className="text-xs text-slate-400">
                      ID : <span className="font-mono text-slate-400">{doc.docId}</span>
                    </p>
                    <p className="text-xs text-slate-400 mt-1">
                      Mis à jour : {new Date(doc.updatedAt * 1000).toLocaleString("fr-FR")}
                    </p>
                  </div>

                  <div className="pt-4 mt-4 border-t border-slate-800/80 flex items-center gap-2">
                    <Link
                      href={`/editor/${doc.docId}`}
                      className="flex-1 py-1.5 px-3 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg text-center transition"
                    >
                      Ouvrir l&apos;éditeur
                    </Link>

                    {doc.role === "owner" && (
                      <button
                        onClick={() => {
                          setShareDoc(doc);
                          setShareMessage(null);
                        }}
                        className="py-1.5 px-2.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs rounded-lg transition"
                        title="Gérer les partages"
                      >
                        Partager
                      </button>
                    )}

                    {doc.role !== "viewer" && (
                      <button
                        onClick={() => openLinksModal(doc)}
                        className="py-1.5 px-2.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs rounded-lg transition"
                        title="Liens de diffusion PDF"
                      >
                        Liens
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-1">Nouveau document</h3>
            <p className="text-xs text-slate-400 mb-4">Donnez un titre à votre journal ou document de travail.</p>

            <form onSubmit={handleCreateDocument} className="space-y-4">
              <div>
                <label htmlFor="doc-title-input" className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
                  Titre du document
                </label>
                <input
                  id="doc-title-input"
                  type="text"
                  required
                  autoFocus
                  placeholder="Ex. Journal de la rentrée 2026"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl transition"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={creatingDoc}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-xl transition disabled:opacity-50"
                >
                  {creatingDoc ? "Création..." : "Créer le document"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL : PARTAGER UN DOCUMENT */}
      {shareDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-1">Partager le document</h3>
            <p className="text-xs text-slate-400 mb-4 font-mono truncate">{shareDoc.title}</p>

            {shareMessage && (
              <div
                className={`p-3 rounded-lg text-xs mb-4 ${
                  shareMessage.type === "success"
                    ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                    : "bg-rose-500/10 text-rose-300 border border-rose-500/30"
                }`}
              >
                {shareMessage.text}
              </div>
            )}

            <form onSubmit={handleShare} className="space-y-4">
              <div>
                <label htmlFor="share-email-input" className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
                  Adresse e-mail du rédacteur
                </label>
                <input
                  id="share-email-input"
                  type="email"
                  required
                  placeholder="nom@asso.fr"
                  value={shareEmail}
                  onChange={(e) => setShareEmail(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label htmlFor="share-role-select" className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
                  Rôle accordé
                </label>
                <select
                  id="share-role-select"
                  value={shareRole}
                  onChange={(e) => setShareRole(e.target.value as "editor" | "viewer")}
                  className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="editor">Éditeur (peut modifier et créer des liens)</option>
                  <option value="viewer">Lecteur (lecture seule)</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShareDoc(null)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl transition"
                >
                  Fermer
                </button>
                <button
                  type="submit"
                  disabled={shareLoading}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-xl transition disabled:opacity-50"
                >
                  {shareLoading ? "Partage..." : "Accorder l'accès"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL : LIENS DE TÉLÉCHARGEMENT */}
      {linksDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl max-h-[85vh] flex flex-col">
            <h3 className="text-lg font-bold text-white mb-1">Liens de diffusion (Tirage limité)</h3>
            <p className="text-xs text-slate-400 mb-4 truncate font-mono">{linksDoc.title}</p>

            {/* Formulaire de création d'un lien */}
            <form onSubmit={handleCreateLink} className="p-3 bg-slate-950/70 border border-slate-800 rounded-xl mb-4">
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label htmlFor="copies-input" className="block text-[11px] font-semibold text-slate-300 mb-1 uppercase tracking-wider">
                    Nombre d&apos;exemplaires autorisés (1..1000)
                  </label>
                  <input
                    id="copies-input"
                    type="number"
                    min={1}
                    max={1000}
                    value={maxCopies}
                    onChange={(e) => setMaxCopies(Number(e.target.value))}
                    className="w-full px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <button
                  type="submit"
                  disabled={creatingLink}
                  className="py-2 px-3 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg transition disabled:opacity-50 shrink-0"
                >
                  {creatingLink ? "Création..." : "Générer le lien"}
                </button>
              </div>
            </form>

            {/* Liste des liens existants */}
            <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
              <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Liens actifs</h4>
              {loadingLinks ? (
                <p className="text-xs text-slate-400 text-center py-4">Chargement des liens...</p>
              ) : docLinks.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-4">Aucun lien généré pour le moment.</p>
              ) : (
                docLinks.map((l) => (
                  <div
                    key={l.linkId}
                    className="p-3 bg-slate-950 border border-slate-800 rounded-xl flex items-center justify-between gap-3 text-xs"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-medium text-indigo-400">/d/{l.linkId}</span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                            l.remaining === 0
                              ? "bg-rose-500/10 text-rose-300 border border-rose-500/30"
                              : "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                          }`}
                        >
                          {l.remaining === 0 ? "Épuisé" : `${l.remaining} restant(s)`}
                        </span>
                      </div>
                      <p className="text-slate-400 text-[11px] mt-0.5">
                        Consommés : {l.issued} / {l.maxDownloads} exemplaires
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => copyLinkUrl(l.linkId)}
                        className="py-1 px-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition"
                      >
                        {linkCopied === l.linkId ? "Copié !" : "Copier"}
                      </button>
                      <a
                        href={`/d/${l.linkId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="py-1 px-2.5 bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 rounded-lg transition"
                      >
                        Tester
                      </a>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="pt-4 mt-2 border-t border-slate-800 flex justify-end">
              <button
                type="button"
                onClick={() => setLinksDoc(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl transition"
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
