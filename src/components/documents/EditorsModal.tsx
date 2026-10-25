"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
  Users,
  UserPlus,
  UserX,
  Loader2,
  X,
  ShieldCheck,
  Clock,
} from "lucide-react";

export interface DocumentEditor {
  writerId: string;
  name: string;
  email: string;
  role: "owner" | "editor" | "viewer";
  createdAt: number;
  credit: {
    used: number;
    remaining: number;
    dailyLimit: number;
    resetAt: number;
  };
}

interface EditorsModalProps {
  docId: string;
  docTitle: string;
  isOpen: boolean;
  onClose: () => void;
  onEditorsChanged?: () => void;
}

const COLLAB_COLORS = [
  "#4f46e5", // indigo
  "#0891b2", // cyan
  "#059669", // emerald
  "#d97706", // amber
  "#dc2626", // rose
  "#7c3aed", // violet
  "#db2777", // pink
  "#2563eb", // blue
];

function getDeterministicColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLLAB_COLORS[Math.abs(hash) % COLLAB_COLORS.length];
}

function EditorsModalContent({
  docId,
  docTitle,
  onClose,
  onEditorsChanged,
}: Omit<EditorsModalProps, "isOpen">) {
  const [editors, setEditors] = useState<DocumentEditor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Formulaire d'invitation
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [inviting, setInviting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Révocation
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const fetchEditors = useCallback(async () => {
    try {
      const res = await fetch(`/api/documents/${docId}/share`);
      if (res.ok) {
        const data = await res.json();
        setEditors(data.editors || []);
      } else {
        const data = await res.json();
        setError(data.error?.message || "Impossible de charger les rédacteurs");
      }
    } catch {
      setError("Erreur réseau lors du chargement des rédacteurs");
    } finally {
      setLoading(false);
    }
  }, [docId]);

  useEffect(() => {
    let active = true;
    fetch(`/api/documents/${docId}/share`)
      .then(async (res) => {
        if (!active) return;
        if (res.ok) {
          const data = await res.json();
          setEditors(data.editors || []);
        } else {
          const data = await res.json();
          setError(data.error?.message || "Impossible de charger les rédacteurs");
        }
      })
      .catch(() => {
        if (active) setError("Erreur réseau lors du chargement des rédacteurs");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [docId]);

  // Fermeture par touche Échap
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setInviting(true);
    setFeedback(null);

    try {
      const res = await fetch(`/api/documents/${docId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role }),
      });
      const data = await res.json();

      if (!res.ok) {
        setFeedback({
          type: "error",
          text: data.error?.message || "Erreur lors de l'ajout du rédacteur",
        });
      } else {
        setFeedback({
          type: "success",
          text: `Accès accordé avec succès à ${email} (${role === "editor" ? "Éditeur" : "Lecteur"}).`,
        });
        setEmail("");
        fetchEditors();
        onEditorsChanged?.();
      }
    } catch {
      setFeedback({ type: "error", text: "Erreur réseau lors de l'invitation" });
    } finally {
      setInviting(false);
    }
  }

  async function handleRevoke(writerId: string, writerName: string) {
    if (!confirm(`Confirmez-vous le retrait des accès pour ${writerName} ?`)) {
      return;
    }

    setRevokingId(writerId);
    setFeedback(null);

    try {
      const res = await fetch(`/api/documents/${docId}/share`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ writerId }),
      });

      if (res.ok) {
        setFeedback({
          type: "success",
          text: `Accès retiré pour ${writerName}.`,
        });
        fetchEditors();
        onEditorsChanged?.();
      } else {
        const data = await res.json();
        setFeedback({
          type: "error",
          text: data.error?.message || "Impossible de retirer cet accès",
        });
      }
    } catch {
      setFeedback({ type: "error", text: "Erreur réseau lors du retrait d'accès" });
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
      <div
        className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-2xl max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-150"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-editors-title"
      >
        {/* En-tête */}
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="p-2 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400">
                <Users className="w-4 h-4" />
              </span>
              <h3 id="modal-editors-title" className="text-base font-bold text-slate-900 dark:text-white truncate">
                Rédacteurs et crédits d&apos;écriture
              </h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 truncate">
              Document : <span className="font-medium text-slate-700 dark:text-slate-200">{docTitle}</span>
            </p>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
            aria-label="Fermer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Message de notification */}
        {feedback && (
          <div
            className={`mt-4 p-3 rounded-2xl text-xs font-medium border shrink-0 ${
              feedback.type === "success"
                ? "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800"
                : "bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800"
            }`}
          >
            {feedback.text}
          </div>
        )}

        {/* Contenu principal défilable */}
        <div className="flex-1 overflow-y-auto py-4 space-y-6 pr-1">
          {/* Note explicative pour le propriétaire */}
          <div className="p-3 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 rounded-2xl flex items-start gap-2.5 text-xs text-slate-600 dark:text-slate-300">
            <ShieldCheck className="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <span className="font-semibold text-slate-900 dark:text-white">Suivi des quotas de rédaction</span>
              <p className="text-slate-500 dark:text-slate-400 text-[11px] leading-relaxed">
                Chaque rédacteur dispose d&apos;un plafond journalier de 10 000 caractères UTF-16. Vous visualisez ici la consommation et le solde restant de chacun en temps réel. Remise à zéro automatique chaque jour à 00:00 UTC.
              </p>
            </div>
          </div>

          {/* Liste des rédacteurs avec jauges de crédit */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                Membres autorisés ({editors.length})
              </h4>
              <span className="text-[11px] text-slate-400 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                <span>Plafond : 10 000 car./jour</span>
              </span>
            </div>

            {loading ? (
              <div className="py-8 flex flex-col items-center justify-center gap-2 text-slate-400">
                <Loader2 className="w-5 h-5 animate-spin text-indigo-600" />
                <span className="text-xs">Chargement des rédacteurs et des soldes…</span>
              </div>
            ) : error ? (
              <div className="p-4 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-2xl text-xs text-rose-700 dark:text-rose-300 text-center">
                {error}
              </div>
            ) : editors.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-4">Aucun rédacteur trouvé.</p>
            ) : (
              <div className="space-y-2.5">
                {editors.map((ed) => {
                  const used = ed.credit?.used ?? 0;
                  const remaining = ed.credit?.remaining ?? 0;
                  const limit = ed.credit?.dailyLimit ?? 10000;
                  const percentUsed = Math.min(100, Math.round((used / limit) * 100));
                  const isOwner = ed.role === "owner";
                  const avatarColor = getDeterministicColor(ed.writerId || ed.email);

                  return (
                    <div
                      key={ed.writerId}
                      className="p-3.5 bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 rounded-2xl space-y-2.5 transition hover:border-slate-300 dark:hover:border-slate-700"
                    >
                      {/* Ligne 1 : Utilisateur, badge de rôle et action */}
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0 shadow-xs"
                            style={{ backgroundColor: avatarColor }}
                          >
                            {(ed.name || ed.email).substring(0, 1).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-slate-900 dark:text-white truncate">
                                {ed.name || "Rédacteur"}
                              </span>
                              <span
                                className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                                  isOwner
                                    ? "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/60 dark:text-purple-300 dark:border-purple-800"
                                    : ed.role === "editor"
                                    ? "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-800"
                                    : "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700"
                                }`}
                              >
                                {isOwner ? "Propriétaire" : ed.role === "editor" ? "Éditeur" : "Lecteur"}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                              {ed.email}
                            </p>
                          </div>
                        </div>

                        {!isOwner && (
                          <button
                            onClick={() => handleRevoke(ed.writerId, ed.name || ed.email)}
                            disabled={revokingId === ed.writerId}
                            className="p-1.5 px-2 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-xl transition cursor-pointer disabled:opacity-40 flex items-center gap-1 text-[11px] shrink-0"
                            title="Retirer les droits de ce collaborateur"
                          >
                            {revokingId === ed.writerId ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <UserX className="w-3.5 h-3.5" />
                            )}
                            <span className="hidden sm:inline">Retirer</span>
                          </button>
                        )}
                      </div>

                      {/* Ligne 2 : Jauge de crédit d'écriture */}
                      <div className="pt-2 border-t border-slate-200/60 dark:border-slate-800/60">
                        <div className="flex items-center justify-between text-xs mb-1.5">
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">
                            Crédit restant :
                          </span>
                          <span className="font-semibold text-xs">
                            <span
                              className={
                                remaining < 1000
                                  ? "text-rose-600 dark:text-rose-400"
                                  : remaining < 3000
                                  ? "text-amber-600 dark:text-amber-400"
                                  : "text-emerald-600 dark:text-emerald-400"
                              }
                            >
                              {remaining.toLocaleString("fr-FR")} car.
                            </span>
                            <span className="text-slate-400 text-[11px]"> / {limit.toLocaleString("fr-FR")}</span>
                          </span>
                        </div>

                        {/* Barre de progression */}
                        <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-2 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${
                              percentUsed > 90
                                ? "bg-rose-500"
                                : percentUsed > 70
                                ? "bg-amber-500"
                                : "bg-emerald-500"
                            }`}
                            style={{ width: `${Math.min(100, Math.max(3, percentUsed))}%` }}
                          />
                        </div>

                        <div className="flex items-center justify-between text-[10px] text-slate-400 mt-1">
                          <span>{used.toLocaleString("fr-FR")} car. consommés ({percentUsed}%)</span>
                          <span>Réinitialisation à 00:00 UTC</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Formulaire d'invitation d'un nouveau membre */}
          <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
            <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <UserPlus className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
              <span>Accorder l&apos;accès à un nouveau rédacteur</span>
            </h4>

            <form onSubmit={handleInvite} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div className="sm:col-span-2">
                  <label
                    htmlFor="invite-email-input"
                    className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1 uppercase tracking-wider"
                  >
                    Adresse e-mail
                  </label>
                  <input
                    id="invite-email-input"
                    type="email"
                    required
                    placeholder="collaborateur@asso.fr"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-slate-900 dark:text-white placeholder-slate-400 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label
                    htmlFor="invite-role-select"
                    className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1 uppercase tracking-wider"
                  >
                    Rôle
                  </label>
                  <select
                    id="invite-role-select"
                    value={role}
                    onChange={(e) => setRole(e.target.value as "editor" | "viewer")}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-slate-900 dark:text-white text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="editor">Éditeur (écriture)</option>
                    <option value="viewer">Lecteur (lecture seule)</option>
                  </select>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={inviting || !email.trim()}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl transition shadow-xs disabled:opacity-50 cursor-pointer inline-flex items-center gap-1.5"
                >
                  {inviting ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Ajout en cours…</span>
                    </>
                  ) : (
                    <>
                      <UserPlus className="w-3.5 h-3.5" />
                      <span>Accorder l&apos;accès</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* Pied de page */}
        <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-xl transition cursor-pointer"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}

export function EditorsModal({
  docId,
  docTitle,
  isOpen,
  onClose,
  onEditorsChanged,
}: EditorsModalProps) {
  if (!isOpen) return null;

  return (
    <EditorsModalContent
      docId={docId}
      docTitle={docTitle}
      onClose={onClose}
      onEditorsChanged={onEditorsChanged}
    />
  );
}
