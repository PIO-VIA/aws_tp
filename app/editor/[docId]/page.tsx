"use client";

import { use, useEffect, useState, useRef, useTransition } from "react";
import Link from "next/link";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { yCollab } from "y-codemirror.next";

interface UserAwareness {
  clientId: number;
  name: string;
  color: string;
}

const COLORS = [
  "#6366f1", // indigo
  "#ec4899", // pink
  "#10b981", // emerald
  "#f59e0b", // amber
  "#3b82f6", // blue
  "#8b5cf6", // purple
  "#06b6d4", // cyan
  "#f97316", // orange
];

function getDeterministicColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

/**
 * Résout dynamiquement l'URL WebSocket du serveur de collaboration.
 * - En local (localhost / 127.0.0.1) : se connecte directement à ws://localhost:1234
 * - En production (ex: CloudFront, nom de domaine, IP externe) : se connecte via le reverse-proxy
 *   Caddy/CloudFront sur /collab (wss://<host>/collab en HTTPS ou ws://<host>/collab en HTTP).
 * - Si NEXT_PUBLIC_COLLAB_URL est explicitement fournie et ne pointe pas sur localhost en prod,
 *   elle est respectée (permet une configuration personnalisée).
 */
export function resolveCollabWsUrl(): string {
  if (typeof window !== "undefined") {
    const isLocalhost =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";

    const envUrl = process.env.NEXT_PUBLIC_COLLAB_URL;

    // Si une URL personnalisée non-localhost est explicitement configurée
    if (envUrl && !envUrl.includes("localhost") && !envUrl.includes("127.0.0.1")) {
      if (envUrl.startsWith("/")) {
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        return `${proto}//${window.location.host}${envUrl}`;
      }
      return envUrl;
    }

    // En environnement déployé (ex: CloudFront https://d3eg6zl3hu2tvv.cloudfront.net)
    if (!isLocalhost) {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${window.location.host}/collab`;
    }
  }

  return process.env.NEXT_PUBLIC_COLLAB_URL || "ws://localhost:1234";
}

export default function EditorPage({
  params,
}: {
  params: Promise<{ docId: string }>;
}) {
  const { docId } = use(params);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);

  const [docTitle, setDocTitle] = useState<string>("Chargement...");
  const [role, setRole] = useState<"owner" | "editor" | "viewer">("viewer");
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [collaborators, setCollaborators] = useState<UserAwareness[]>([]);
  const [isReadOnly, setIsReadOnly] = useState<boolean>(false);
  const [refusalMessage, setRefusalMessage] = useState<string | null>(null);
  const [charCount, setCharCount] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Historique des versions (F05)
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [versions, setVersions] = useState<Array<{ snapshotId: string; reason: string; chars: number; createdAt: number; createdBy: string }>>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [historyMsg, setHistoryMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [, startTransition] = useTransition();
  const editableCompartmentRef = useRef<Compartment>(new Compartment());
  const editorViewRef = useRef<EditorView | null>(null);

  const loadVersions = async () => {
    setHistoryLoading(true);
    setHistoryMsg(null);
    try {
      const res = await fetch(`/api/documents/${docId}/versions`);
      if (res.ok) {
        const data = await res.json();
        const items = data.versions || [];
        setVersions(items);
        if (items.length > 0) {
          loadPreview(items[0].snapshotId);
        }
      }
    } catch {
      // Ignorer
    } finally {
      setHistoryLoading(false);
    }
  };

  const loadPreview = async (snapId: string) => {
    setSelectedSnapshotId(snapId);
    setPreviewContent("Chargement de l'aperçu...");
    try {
      const res = await fetch(`/api/documents/${docId}/versions/${snapId}`);
      if (res.ok) {
        const data = await res.json();
        setPreviewContent(data.text);
      } else {
        setPreviewContent("Impossible de charger l'aperçu de cette version.");
      }
    } catch {
      setPreviewContent("Erreur de chargement.");
    }
  };

  const handleCreateSnapshot = async () => {
    setActionLoading(true);
    setHistoryMsg(null);
    try {
      const res = await fetch(`/api/documents/${docId}/snapshot`, { method: "POST" });
      if (res.ok) {
        setHistoryMsg({ type: "success", text: "Point de version créé avec succès !" });
        loadVersions();
      } else {
        const err = await res.json().catch(() => ({}));
        setHistoryMsg({ type: "error", text: err.error || "Échec de l'enregistrement" });
      }
    } catch {
      setHistoryMsg({ type: "error", text: "Erreur réseau" });
    } finally {
      setActionLoading(false);
    }
  };

  const handleRestore = async (snapId: string) => {
    if (!confirm("Voulez-vous restaurer cette version ? Cela créera une nouvelle évolution sans altérer l'historique antérieur (I08).")) {
      return;
    }
    setActionLoading(true);
    setHistoryMsg(null);
    try {
      const res = await fetch(`/api/documents/${docId}/versions/${snapId}/restore`, { method: "POST" });
      if (res.ok) {
        setHistoryMsg({ type: "success", text: "Version restaurée avec succès !" });
        loadVersions();
      } else {
        const err = await res.json().catch(() => ({}));
        setHistoryMsg({ type: "error", text: err.error || "Échec de la restauration" });
      }
    } catch {
      setHistoryMsg({ type: "error", text: "Erreur réseau" });
    } finally {
      setActionLoading(false);
    }
  };


  useEffect(() => {
    let active = true;
    let provider: HocuspocusProvider | null = null;
    let ydoc: Y.Doc | null = null;
    let view: EditorView | null = null;

    async function initEditor() {
      try {
        // 1. Récupération des métadonnées du document et du rôle
        const docRes = await fetch(`/api/documents/${docId}`);
        if (!active) return;
        if (!docRes.ok) {
          setErrorMsg("Document introuvable ou droits insuffisants");
          return;
        }
        const docData = await docRes.json();
        setDocTitle(docData.meta.title);
        setRole(docData.role);
        const readOnlyInitial = docData.role === "viewer";
        setIsReadOnly(readOnlyInitial);

        // 2. Récupération du collab-token de 5 minutes
        const tokenRes = await fetch(`/api/session/collab-token?docId=${docId}`);
        if (!active) return;
        if (!tokenRes.ok) {
          setErrorMsg("Impossible d'obtenir un jeton de collaboration");
          return;
        }
        const { token } = await tokenRes.json();

        // Récupération de la session courante pour l'awareness
        const sessionRes = await fetch("/api/session");
        const sessionData = sessionRes.ok ? await sessionRes.json() : null;
        const currentUserName = sessionData?.writer?.name || "Rédacteur";
        const currentWriterId = sessionData?.writer?.id || "anon";
        const userColor = getDeterministicColor(currentWriterId);

        // 3. Initialisation Yjs et HocuspocusProvider
        ydoc = new Y.Doc();
        const ytext = ydoc.getText("content");

        const collabWsUrl = resolveCollabWsUrl();
        provider = new HocuspocusProvider({
          url: collabWsUrl,
          name: docId,
          document: ydoc,
          token,
          onStatus(event) {
            if (!active) return;
            startTransition(() => {
              if (event.status === "connected") setStatus("connected");
              else if (event.status === "connecting") setStatus("connecting");
              else setStatus("disconnected");
            });
          },
          onStateless(payload) {
            if (!active) return;
            try {
              const data = JSON.parse(payload.payload);
              if (data.type === "write_refused") {
                startTransition(() => {
                  setIsReadOnly(true);
                  if (data.reason === "quota") {
                    setRefusalMessage(
                      `Crédit d'écriture quotidien épuisé : ${data.remaining || 0} caractères restants. Remise à zéro à 00:00 UTC.`,
                    );
                  } else if (data.reason === "too_large") {
                    setRefusalMessage("Modification rejetée : taille supérieure à la limite autorisée.");
                  } else if (data.reason === "invalid_update") {
                    setRefusalMessage("Modification rejetée : contenu non autorisé.");
                  } else if (data.reason === "persist_failed") {
                    setRefusalMessage("Erreur de persistance sur le serveur. La modification n'a pas été appliquée.");
                  } else if (data.reason === "blocked") {
                    const timeStr = data.blockedUntil
                      ? new Date(data.blockedUntil * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : "";
                    setRefusalMessage(timeStr ? `Compte bloqué jusqu'à ${timeStr}` : "Compte bloqué.");
                  } else if (data.reason === "rate_limited") {
                    const timeStr = data.blockedUntil
                      ? new Date(data.blockedUntil * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : "";
                    setRefusalMessage(
                      timeStr
                        ? `Compte bloqué jusqu'à ${timeStr} (débit de frappe excessif)`
                        : "Débit de frappe excessif : modification rejetée. Passage en lecture seule.",
                    );
                  } else if (data.reason === "read_only") {
                    setRefusalMessage("Accès en lecture seule.");
                  }
                });

                if (editorViewRef.current) {
                  editorViewRef.current.dispatch({
                    effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(false)),
                  });
                }
              }
            } catch {
              // Ignore payload parse errors
            }
          },
          onClose(event) {
            if (!active) return;
            if (event.event?.code === 4403) {
              startTransition(() => {
                setIsReadOnly(true);
                const reason = event.event?.reason || "";
                if (reason.toLowerCase().includes("bloqué") || reason.toLowerCase().includes("abus")) {
                  setRefusalMessage("Connexion fermée par le serveur : compte bloqué pour abus. Passage en lecture seule.");
                } else {
                  setRefusalMessage("Connexion fermée par le serveur : Quota dépassé. Passage en lecture seule.");
                }
              });
              if (editorViewRef.current) {
                editorViewRef.current.dispatch({
                  effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(false)),
                });
              }
            }
          },
        });

        // 4. Configuration de l'Awareness (curseurs et présence)
        if (provider.awareness) {
          provider.awareness.setLocalStateField("user", {
            name: currentUserName,
            color: userColor,
          });

          const updateCollaborators = () => {
            if (!provider || !provider.awareness || !active) return;
            const states = provider.awareness.getStates();
            const colabs: UserAwareness[] = [];
            states.forEach((val, cId) => {
              const u = val.user as { name?: string; color?: string } | undefined;
              if (u && u.name) {
                colabs.push({
                  clientId: cId,
                  name: u.name,
                  color: u.color || "#6366f1",
                });
              }
            });
            startTransition(() => {
              setCollaborators(colabs);
            });
          };

          provider.awareness.on("change", updateCollaborators);
        }

        // 5. Mise à jour du compteur de caractères
        ytext.observe(() => {
          if (!active) return;
          startTransition(() => {
            setCharCount(ytext.length);
          });
        });

        // 6. Montage de CodeMirror 6
        if (editorContainerRef.current) {
          editorContainerRef.current.innerHTML = "";

          const extensions = [
            basicSetup,
            EditorView.lineWrapping,
            editableCompartmentRef.current.of(EditorView.editable.of(!readOnlyInitial)),
            EditorView.theme({
              "&": {
                height: "100%",
                fontSize: "14px",
                backgroundColor: "#030712",
                color: "#f8fafc",
              },
              ".cm-scroller": {
                fontFamily: "var(--font-mono), monospace",
              },
              ".cm-content": {
                caretColor: "#818cf8",
                padding: "24px 32px",
                lineHeight: "1.7",
              },
              ".cm-gutters": {
                backgroundColor: "#090d16",
                color: "#475569",
                borderRight: "1px solid #1e293b",
              },
              "&.cm-focused .cm-cursor": {
                borderLeftColor: "#818cf8",
              },
              "&.cm-focused": {
                outline: "none",
              },
            }),
          ];

          if (provider.awareness) {
            extensions.push(yCollab(ytext, provider.awareness));
          }

          const state = EditorState.create({
            doc: ytext.toString(),
            extensions,
          });

          view = new EditorView({
            state,
            parent: editorContainerRef.current,
          });
          editorViewRef.current = view;
          setCharCount(ytext.length);
        }
      } catch (err) {
        if (active) {
          setErrorMsg(err instanceof Error ? err.message : "Erreur d'initialisation de l'éditeur");
        }
      }
    }

    initEditor();

    return () => {
      active = false;
      if (view) view.destroy();
      if (provider) provider.destroy();
      if (ydoc) ydoc.destroy();
    };
  }, [docId]);

  if (errorMsg) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-slate-950 text-slate-100">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center space-y-4">
          <div className="h-12 w-12 rounded-full bg-rose-500/10 text-rose-400 mx-auto flex items-center justify-center text-xl">
            ✕
          </div>
          <h2 className="text-lg font-bold text-white">Impossible d&apos;ouvrir le document</h2>
          <p className="text-xs text-slate-400">{errorMsg}</p>
          <Link
            href="/"
            className="inline-block py-2 px-4 bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold rounded-xl transition"
          >
            ← Retour au tableau de bord
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
      {/* Barre d'en-tête de l'éditeur */}
      <header className="h-14 border-b border-slate-800 bg-slate-900/80 backdrop-blur-md px-4 flex items-center justify-between gap-4 shrink-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/"
            className="py-1.5 px-2.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs rounded-lg transition shrink-0"
          >
            ← Retour
          </Link>

          <div className="min-w-0">
            <h1 className="font-semibold text-sm text-white truncate leading-tight">{docTitle}</h1>
            <div className="flex items-center gap-2 text-[11px] text-slate-400">
              <span className="font-mono text-slate-400">{docId}</span>
              <span>•</span>
              <span
                className={`uppercase tracking-wider font-semibold text-[10px] ${
                  role === "owner"
                    ? "text-purple-400"
                    : role === "editor"
                    ? "text-indigo-400"
                    : "text-slate-400"
                }`}
              >
                {role === "owner" ? "Propriétaire" : role === "editor" ? "Éditeur" : "Lecteur"}
              </span>
            </div>
          </div>
        </div>

        {/* Collaborateurs en ligne et statut */}
        <div className="flex items-center gap-4 shrink-0">
          {/* Liste des utilisateurs en ligne (Awareness) */}
          <div className="flex items-center -space-x-1.5 overflow-hidden">
            {collaborators.map((c) => (
              <div
                key={c.clientId}
                title={c.name}
                className="h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold text-white border-2 border-slate-900 shadow-sm transition hover:scale-110"
                style={{ backgroundColor: c.color }}
              >
                {c.name.substring(0, 1).toUpperCase()}
              </div>
            ))}
          </div>

          {/* Indicateur de statut de connexion */}
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                status === "connected"
                  ? "bg-emerald-500 animate-pulse"
                  : status === "connecting"
                  ? "bg-amber-500 animate-bounce"
                  : "bg-rose-500"
              }`}
            ></span>
            <span className="text-slate-400 hidden sm:inline text-[11px]">
              {status === "connected"
                ? "Synchronisé"
                : status === "connecting"
                ? "Connexion..."
                : "Déconnecté"}
            </span>
          </div>

          <div className="border-l border-slate-800 pl-4 text-right hidden md:block">
            <span className="text-xs font-mono text-slate-300">{charCount} car.</span>
          </div>

          {/* Bouton Historique des versions (F05) */}
          <button
            onClick={() => {
              const next = !showHistory;
              setShowHistory(next);
              if (next) loadVersions();
            }}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition flex items-center gap-1.5 cursor-pointer ${
              showHistory
                ? "bg-indigo-600 text-white border-indigo-500 shadow-md shadow-indigo-600/30"
                : "bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
            }`}
          >
            <span>🕒</span>
            <span>Historique</span>
          </button>
        </div>
      </header>

      {/* Bandeau d'avertissement de refus (write_refused / lecture seule) */}
      {(refusalMessage || isReadOnly) && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2 flex items-center justify-between text-xs text-amber-200 shrink-0">
          <div className="flex items-center gap-2">
            <span>ℹ️</span>
            <span>{refusalMessage || "Mode lecture seule actif pour ce document."}</span>
          </div>
        </div>
      )}

      {/* Zone principale : Éditeur + Panneau Historique rétractable */}
      <div className="flex-1 w-full overflow-hidden bg-slate-950 flex relative">
        {/* Zone d'édition CodeMirror 6 */}
        <div className="flex-1 h-full overflow-hidden relative">
          <div ref={editorContainerRef} className="h-full w-full" />
        </div>

        {/* Panneau Historique des versions (F05) */}
        {showHistory && (
          <aside className="w-96 border-l border-slate-800 bg-slate-900/95 flex flex-col h-full shadow-2xl backdrop-blur-md z-10">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-sm text-white">Historique & Restauration</h3>
                <p className="text-[11px] text-slate-400">Snapshots immuables du document</p>
              </div>
              <button
                onClick={() => setShowHistory(false)}
                className="text-slate-400 hover:text-white text-sm p-1 rounded-md hover:bg-slate-800 cursor-pointer"
              >
                ✕
              </button>
            </div>

            {historyMsg && (
              <div
                className={`p-3 text-xs border-b ${
                  historyMsg.type === "success"
                    ? "bg-emerald-950/40 border-emerald-800 text-emerald-300"
                    : "bg-rose-950/40 border-rose-800 text-rose-300"
                }`}
              >
                {historyMsg.text}
              </div>
            )}

            <div className="p-3 border-b border-slate-800 bg-slate-900/50 flex gap-2">
              <button
                onClick={handleCreateSnapshot}
                disabled={actionLoading || role === "viewer"}
                className="flex-1 py-1.5 px-3 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition shadow-sm disabled:opacity-50 cursor-pointer"
              >
                {actionLoading ? "Enregistrement..." : "Enregistrer une version"}
              </button>
              <button
                onClick={loadVersions}
                disabled={historyLoading}
                className="py-1.5 px-2.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition cursor-pointer"
                title="Actualiser la liste"
              >
                🔄
              </button>
            </div>

            {/* Liste des versions */}
            <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60 p-2 space-y-1">
              {historyLoading && versions.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-6">Chargement de l&apos;historique...</p>
              ) : versions.length === 0 ? (
                <p className="text-xs text-slate-500 text-center py-6 italic">Aucun point de version enregistré.</p>
              ) : (
                versions.map((v) => {
                  const isSelected = selectedSnapshotId === v.snapshotId;
                  const date = new Date(v.createdAt * 1000);
                  const reasonLabel =
                    v.reason === "manual"
                      ? "Manuel"
                      : v.reason === "restore"
                      ? "Restauration"
                      : v.reason === "idle"
                      ? "Inactivité"
                      : v.reason === "unload"
                      ? "Déchargement"
                      : "Automatique";

                  return (
                    <div
                      key={v.snapshotId}
                      onClick={() => loadPreview(v.snapshotId)}
                      className={`p-2.5 rounded-lg text-left transition cursor-pointer border ${
                        isSelected
                          ? "bg-indigo-950/40 border-indigo-500/50 text-white"
                          : "hover:bg-slate-800/50 border-transparent text-slate-300"
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs font-medium">
                        <span>{date.toLocaleDateString()} {date.toLocaleTimeString()}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                          {reasonLabel}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                        <span className="font-mono text-[10px] text-slate-500">{v.snapshotId.slice(0, 15)}...</span>
                        <span>{v.chars} car.</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Aperçu et bouton de restauration */}
            {selectedSnapshotId && (
              <div className="p-3 border-t border-slate-800 bg-slate-950/70 space-y-2">
                <div className="flex items-center justify-between text-xs font-medium text-slate-300">
                  <span>Aperçu de la version</span>
                  <button
                    onClick={() => handleRestore(selectedSnapshotId)}
                    disabled={actionLoading || role === "viewer"}
                    className="px-2.5 py-1 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-500 text-white transition disabled:opacity-50 cursor-pointer shadow-sm"
                  >
                    {actionLoading ? "Restauration..." : "Restaurer cette version"}
                  </button>
                </div>
                <div className="h-28 overflow-y-auto p-2 rounded bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300 whitespace-pre-wrap">
                  {previewContent || "Aucun contenu"}
                </div>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
