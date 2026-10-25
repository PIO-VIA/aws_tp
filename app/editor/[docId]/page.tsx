"use client";

import { use, useEffect, useState, useRef, useTransition, useMemo } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  X,
  Clock,
  RotateCcw,
  CheckCircle2,
  WifiOff,
  Loader2,
  ShieldAlert,
  Maximize2,
  Minimize2,
  Heading1,
  Heading2,
  Quote,
  List,
  ListOrdered,
  Minus,
  Copy,
  Check,
  Sparkles,
  History,
  CaseUpper,
  CaseLower,
  CaseSensitive,
  PenLine,
  Columns2,
  BookOpen,
  ZoomIn,
  ZoomOut,
  Users,
} from "lucide-react";
import { Logo } from "@/src/components/brand/Logo";
import { ThemeToggle } from "@/src/components/ui/ThemeToggle";
import { EditorsModal } from "@/src/components/documents/EditorsModal";
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

interface VersionItem {
  snapshotId: string;
  reason: string;
  chars: number;
  createdAt: number;
  createdBy: string;
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

/**
 * Composant de Rendu de la Feuille en Temps Réel (Style Overleaf / Journal Étudiant)
 */
function LiveOverleafSheet({
  title,
  text,
  zoom,
  authors,
}: {
  title: string;
  text: string;
  zoom: number;
  authors: string[];
}) {
  const currentDate = new Date().toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // Découpage et formatage des paragraphes et sections
  const blocks = useMemo(() => {
    if (!text || text.trim() === "") {
      return [];
    }

    const lines = text.split("\n");
    const elements: Array<{
      type: "h1" | "h2" | "quote" | "separator" | "bullet" | "number" | "p";
      content: string;
      key: number;
    }> = [];

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      if (trimmed.startsWith("# ")) {
        elements.push({ type: "h1", content: trimmed.replace(/^#\s+/, ""), key: idx });
      } else if (trimmed.startsWith("## ")) {
        elements.push({ type: "h2", content: trimmed.replace(/^##\s+/, ""), key: idx });
      } else if (trimmed.startsWith("---") || trimmed.startsWith("***")) {
        elements.push({ type: "separator", content: "", key: idx });
      } else if (trimmed.startsWith("• ") || trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        elements.push({ type: "bullet", content: trimmed.replace(/^[-*•]\s+/, ""), key: idx });
      } else if (/^\d+\.\s+/.test(trimmed)) {
        elements.push({ type: "number", content: trimmed, key: idx });
      } else if (trimmed.startsWith("«") || trimmed.startsWith(">")) {
        elements.push({ type: "quote", content: trimmed.replace(/^>\s*/, ""), key: idx });
      } else {
        elements.push({ type: "p", content: trimmed, key: idx });
      }
    });

    return elements;
  }, [text]);

  return (
    <div
      className="transition-transform duration-150 origin-top"
      style={{ transform: `scale(${zoom})` }}
    >
      {/* Feuille de tirage imprimable type A4 */}
      <article className="w-[640px] min-h-[900px] bg-white text-slate-900 border border-stone-200/90 shadow-2xl rounded-sm p-10 sm:p-12 font-serif flex flex-col justify-between select-text relative">
        <div>
          {/* Manchette du journal étudiant */}
          <header className="border-b-4 border-double border-slate-900 pb-4 mb-6">
            <div className="flex items-center justify-between text-[10px] font-sans font-bold tracking-widest uppercase text-slate-600 mb-2 border-b border-slate-200 pb-1.5">
              <span>Éditeur Collaboratif — Association AWS</span>
              <span>Tirage Éditorial Limité</span>
              <span>Édition 2026</span>
            </div>

            <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-950 font-serif leading-tight tracking-tight text-center my-3">
              {title || "Sans titre"}
            </h1>

            <div className="flex items-center justify-between text-xs font-sans text-slate-600 pt-2 border-t border-slate-300">
              <span className="capitalize">{currentDate}</span>
              <span className="italic">
                {authors.length > 0 ? `Rédigé par ${authors.join(", ")}` : "Rédaction étudiante"}
              </span>
            </div>
          </header>

          {/* Corps de l'article compilé en direct */}
          <div className="space-y-3.5">
            {blocks.length === 0 ? (
              <div className="py-20 text-center text-slate-400 font-sans italic space-y-2">
                <p className="text-sm">Votre article apparaîtra ici en temps réel au fil de votre écriture.</p>
                <p className="text-xs text-slate-400">
                  Utilisez les outils de la barre supérieure pour insérer des titres, citations et puces.
                </p>
              </div>
            ) : (
              blocks.map((block) => {
                switch (block.type) {
                  case "h1":
                    return (
                      <h2
                        key={block.key}
                        className="text-lg font-bold font-serif text-slate-950 border-b-2 border-slate-800 pb-1 mt-6 mb-2 tracking-tight"
                      >
                        {block.content}
                      </h2>
                    );
                  case "h2":
                    return (
                      <h3
                        key={block.key}
                        className="text-base font-bold font-serif text-slate-900 mt-4 mb-1"
                      >
                        {block.content}
                      </h3>
                    );
                  case "quote":
                    return (
                      <blockquote
                        key={block.key}
                        className="border-l-3 border-indigo-600 pl-4 py-2 italic font-serif text-slate-800 bg-indigo-50/40 my-3 text-sm rounded-r"
                      >
                        {block.content}
                      </blockquote>
                    );
                  case "separator":
                    return <hr key={block.key} className="border-t-2 border-slate-300 my-4" />;
                  case "bullet":
                    return (
                      <div key={block.key} className="flex items-start gap-2 text-xs leading-relaxed text-slate-800 pl-2">
                        <span className="text-indigo-600 font-bold">•</span>
                        <span>{block.content}</span>
                      </div>
                    );
                  case "number":
                    return (
                      <p key={block.key} className="text-xs leading-relaxed text-slate-800 pl-2">
                        {block.content}
                      </p>
                    );
                  case "p":
                  default:
                    return (
                      <p
                        key={block.key}
                        className="text-xs leading-relaxed text-slate-800 text-justify indent-4"
                      >
                        {block.content}
                      </p>
                    );
                }
              })
            )}
          </div>
        </div>

        {/* Pied de page de la feuille */}
        <footer className="mt-12 pt-3 border-t border-slate-200 flex items-center justify-between text-[10px] font-sans text-slate-500">
          <span>Journal de l&apos;Association — Reproduction réservée</span>
          <span className="font-semibold">Page 1 / 1</span>
        </footer>
      </article>
    </div>
  );
}

export default function EditorPage({
  params,
}: {
  params: Promise<{ docId: string }>;
}) {
  const { docId } = use(params);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);

  // Données et état du document
  const [docTitle, setDocTitle] = useState<string>("Chargement de l'article…");
  const [role, setRole] = useState<"owner" | "editor" | "viewer">("viewer");
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [collaborators, setCollaborators] = useState<UserAwareness[]>([]);
  const [isReadOnly, setIsReadOnly] = useState<boolean>(false);
  const [refusalMessage, setRefusalMessage] = useState<string | null>(null);
  const [charCount, setCharCount] = useState<number>(0);
  const [wordCount, setWordCount] = useState<number>(0);
  const [liveText, setLiveText] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Mode d'affichage Overleaf : "editor" (Éditeur seul) | "split" (Côte à côte Overleaf) | "preview" (Aperçu seul)
  const [viewMode, setViewMode] = useState<"editor" | "split" | "preview">(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("editor_view_mode") as "editor" | "split" | "preview" | null;
      if (stored && ["editor", "split", "preview"].includes(stored)) return stored;
    }
    return "split";
  });

  const [previewZoom, setPreviewZoom] = useState<number>(1);

  // Préférences visuelles & confort de rédaction (Papier par défaut)
  const [fontFamily, setFontFamily] = useState<"serif" | "sans" | "mono">(() => {
    if (typeof window !== "undefined") {
      const storedFont = localStorage.getItem("editor_font") as "serif" | "sans" | "mono" | null;
      if (storedFont && ["serif", "sans", "mono"].includes(storedFont)) return storedFont;
    }
    return "serif";
  });

  const [fontSize, setFontSize] = useState<"sm" | "md" | "lg">(() => {
    if (typeof window !== "undefined") {
      const storedSize = localStorage.getItem("editor_size") as "sm" | "md" | "lg" | null;
      if (storedSize && ["sm", "md", "lg"].includes(storedSize)) return storedSize;
    }
    return "md";
  });

  const [isFocusMode, setIsFocusMode] = useState<boolean>(false);
  const [copySuccess, setCopySuccess] = useState<boolean>(false);

  // Historique des versions (F05)
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [showEditorsModal, setShowEditorsModal] = useState<boolean>(false);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [historyMsg, setHistoryMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [restoreConfirmSnapId, setRestoreConfirmSnapId] = useState<string | null>(null);

  const [, startTransition] = useTransition();
  const editableCompartmentRef = useRef<Compartment>(new Compartment());
  const editorViewRef = useRef<EditorView | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);

  const handleViewModeChange = (mode: "editor" | "split" | "preview") => {
    setViewMode(mode);
    localStorage.setItem("editor_view_mode", mode);
  };

  const handleFontChange = (f: "serif" | "sans" | "mono") => {
    setFontFamily(f);
    localStorage.setItem("editor_font", f);
  };

  const handleSizeChange = (s: "sm" | "md" | "lg") => {
    setFontSize(s);
    localStorage.setItem("editor_size", s);
  };

  // Chargement de l'historique
  const loadVersions = async () => {
    setHistoryLoading(true);
    setHistoryMsg(null);
    try {
      const res = await fetch(`/api/documents/${docId}/versions`);
      if (res.ok) {
        const data = await res.json();
        const items: VersionItem[] = data.versions || [];
        setVersions(items);
        if (items.length > 0 && !selectedSnapshotId) {
          loadPreview(items[0].snapshotId);
        }
      }
    } catch {
      /* Erreur réseau lors du chargement des versions */
    } finally {
      setHistoryLoading(false);
    }
  };

  const loadPreview = async (snapId: string) => {
    setSelectedSnapshotId(snapId);
    setPreviewContent("Chargement de l'aperçu…");
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
        setHistoryMsg({ type: "success", text: "Point de version enregistré avec succès !" });
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

  const executeRestore = async (snapId: string) => {
    setRestoreConfirmSnapId(null);
    setActionLoading(true);
    setHistoryMsg(null);
    try {
      const res = await fetch(`/api/documents/${docId}/versions/${snapId}/restore`, { method: "POST" });
      if (res.ok) {
        setHistoryMsg({ type: "success", text: "Version restaurée avec succès ! (nouvelle évolution créée)" });
        loadVersions();
      } else {
        const err = await res.json().catch(() => ({}));
        setHistoryMsg({ type: "error", text: err.error || "Échec de la restauration" });
      }
    } catch {
      setHistoryMsg({ type: "error", text: "Erreur réseau lors de la restauration" });
    } finally {
      setActionLoading(false);
    }
  };

  // Outils de formatage de texte brut
  const applyFormatting = (type: "h1" | "h2" | "quote" | "bullet" | "number" | "separator" | "upper" | "lower" | "capitalize" | "dash" | "ellipsis") => {
    const view = editorViewRef.current;
    if (!view || isReadOnly) return;
    const state = view.state;
    const { from, to } = state.selection.main;
    const selectedText = state.sliceDoc(from, to);

    let replacement = "";
    switch (type) {
      case "h1":
        replacement = selectedText ? `# ${selectedText}\n` : "# Titre de section\n";
        break;
      case "h2":
        replacement = selectedText ? `## ${selectedText}\n` : "## Sous-titre\n";
        break;
      case "quote":
        replacement = selectedText ? `« ${selectedText} »` : "« Citation »";
        break;
      case "bullet":
        if (selectedText) {
          replacement = selectedText
            .split("\n")
            .map((line) => (line.startsWith("• ") ? line : `• ${line}`))
            .join("\n");
        } else {
          replacement = "• ";
        }
        break;
      case "number":
        if (selectedText) {
          replacement = selectedText
            .split("\n")
            .map((line, idx) => `${idx + 1}. ${line}`)
            .join("\n");
        } else {
          replacement = "1. ";
        }
        break;
      case "separator":
        replacement = "\n---\n";
        break;
      case "upper":
        replacement = selectedText ? selectedText.toUpperCase() : "";
        break;
      case "lower":
        replacement = selectedText ? selectedText.toLowerCase() : "";
        break;
      case "capitalize":
        replacement = selectedText
          ? selectedText.replace(/\b\w/g, (char) => char.toUpperCase())
          : "";
        break;
      case "dash":
        replacement = "— ";
        break;
      case "ellipsis":
        replacement = "…";
        break;
    }

    if (replacement !== "") {
      view.dispatch({
        changes: { from, to, insert: replacement },
        selection: { anchor: from + replacement.length },
      });
    }
    view.focus();
  };

  // Copie intégrale du texte
  const handleCopyAll = async () => {
    if (!ytextRef.current) return;
    try {
      await navigator.clipboard.writeText(ytextRef.current.toString());
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
      /* Presse-papiers non accessible dans ce contexte */
    }
  };

  // Raccourci clavier de concentration (Échap pour quitter)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFocusMode) {
        setIsFocusMode(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFocusMode]);

  // Initialisation de la session collaborative et de CodeMirror
  useEffect(() => {
    let active = true;
    let provider: HocuspocusProvider | null = null;
    let ydoc: Y.Doc | null = null;
    let view: EditorView | null = null;

    async function initEditor() {
      try {
        // 1. Métadonnées du document et rôle
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

        // 2. Collab-token de 5 minutes
        const tokenRes = await fetch(`/api/session/collab-token?docId=${docId}`);
        if (!active) return;
        if (!tokenRes.ok) {
          setErrorMsg("Impossible d'obtenir un jeton de collaboration");
          return;
        }
        const { token } = await tokenRes.json();

        // Récupération de la session pour l'identité de rédaction
        const sessionRes = await fetch("/api/session");
        const sessionData = sessionRes.ok ? await sessionRes.json() : null;
        const currentUserName = sessionData?.writer?.name || "Rédacteur";
        const currentWriterId = sessionData?.writer?.id || "anon";
        const userColor = getDeterministicColor(currentWriterId);

        // 3. Initialisation Yjs et Provider
        ydoc = new Y.Doc();
        const ytext = ydoc.getText("content");
        ytextRef.current = ytext;

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
                      `Crédit quotidien épuisé : ${data.remaining || 0} caractères restants. Remise à zéro à 00:00 UTC.`,
                    );
                  } else if (data.reason === "too_large") {
                    setRefusalMessage("Modification rejetée : taille supérieure à la limite autorisée.");
                  } else if (data.reason === "invalid_update") {
                    setRefusalMessage("Modification rejetée : contenu non autorisé.");
                  } else if (data.reason === "persist_failed") {
                    setRefusalMessage("Erreur de persistance serveur. La modification n'a pas été appliquée.");
                  } else if (data.reason === "blocked") {
                    const timeStr = data.blockedUntil
                      ? new Date(data.blockedUntil * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : "";
                    setRefusalMessage(timeStr ? `Compte temporairement bloqué jusqu'à ${timeStr}` : "Compte bloqué.");
                  } else if (data.reason === "rate_limited") {
                    const timeStr = data.blockedUntil
                      ? new Date(data.blockedUntil * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : "";
                    setRefusalMessage(
                      timeStr
                        ? `Compte bloqué jusqu'à ${timeStr} (débit de frappe excessif)`
                        : "Débit excessif : passage en lecture seule.",
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
              /* Données de message non décodables ignorées */
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

        // 4. Awareness
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
                  color: u.color || "#4f46e5",
                });
              }
            });
            startTransition(() => {
              setCollaborators(colabs);
            });
          };

          provider.awareness.on("change", updateCollaborators);
        }

        // 5. Compteurs statistiques et mise à jour en temps réel
        const updateStats = () => {
          if (!active) return;
          const text = ytext.toString();
          const chars = text.length;
          const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
          startTransition(() => {
            setCharCount(chars);
            setWordCount(words);
            setLiveText(text);
          });
        };

        ytext.observe(() => {
          updateStats();
        });

        // 6. Montage CodeMirror 6
        if (editorContainerRef.current) {
          editorContainerRef.current.innerHTML = "";

          const extensions = [
            basicSetup,
            EditorView.lineWrapping,
            editableCompartmentRef.current.of(EditorView.editable.of(!readOnlyInitial)),
            EditorView.theme({
              "&": {
                height: "100%",
                backgroundColor: "transparent",
                color: "inherit",
              },
              ".cm-scroller": {
                fontFamily: "inherit",
                lineHeight: "1.75",
              },
              ".cm-content": {
                padding: "24px 28px",
                caretColor: "var(--color-accent, #4f46e5)",
              },
              "&.cm-focused .cm-cursor": {
                borderLeftColor: "var(--color-accent, #4f46e5)",
                borderLeftWidth: "2px",
              },
              "&.cm-focused": {
                outline: "none",
              },
              ".cm-line": {
                padding: "1px 0",
              },
              ".cm-gutters": {
                display: "none",
              },
              ".cm-ySelection": {
                borderRadius: "2px",
              },
              ".cm-ySelectionInfo": {
                fontSize: "11px",
                fontWeight: "600",
                borderRadius: "4px",
                padding: "1px 6px",
                boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
                position: "absolute",
                top: "-1.5em",
                left: "-1px",
                whiteSpace: "nowrap",
                zIndex: "10",
                color: "#ffffff",
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
          updateStats();
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

  // Regroupement chronologique des versions d'historique
  const groupedVersions = useMemo(() => {
    const groups: Record<string, VersionItem[]> = {};
    const now = new Date();

    versions.forEach((v) => {
      const d = new Date(v.createdAt * 1000);
      let groupKey = "";
      if (d.toDateString() === now.toDateString()) {
        groupKey = "Aujourd'hui";
      } else {
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (d.toDateString() === yesterday.toDateString()) {
          groupKey = "Hier";
        } else {
          groupKey = d.toLocaleDateString("fr-FR", {
            weekday: "long",
            day: "numeric",
            month: "long",
          });
        }
      }

      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(v);
    });

    return groups;
  }, [versions]);

  // Noms des auteurs pour la manchette
  const collaboratorNames = useMemo(() => {
    return Array.from(new Set(collaborators.map((c) => c.name)));
  }, [collaborators]);

  // Calcul du temps estimé de lecture
  const readTimeMinutes = Math.max(1, Math.ceil(wordCount / 200));

  // Classes typographiques de la feuille d'écriture
  const fontClass =
    fontFamily === "serif"
      ? "font-serif"
      : fontFamily === "mono"
      ? "font-mono"
      : "font-sans";

  const sizeClass =
    fontSize === "sm"
      ? "text-sm leading-relaxed"
      : fontSize === "lg"
      ? "text-lg leading-relaxed"
      : "text-base leading-relaxed";

  if (errorMsg) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
        <div className="max-w-md w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 text-center space-y-4 shadow-lg">
          <div className="h-12 w-12 rounded-full bg-rose-500/10 text-rose-500 mx-auto flex items-center justify-center">
            <X className="w-6 h-6" />
          </div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            Impossible d&apos;ouvrir le document
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">{errorMsg}</p>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 py-2 px-4 bg-slate-900 hover:bg-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 text-white text-xs font-semibold rounded-xl transition"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Retour au tableau de bord</span>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-stone-100/70 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden font-sans transition-colors duration-150">
      {/* 1. EN-TÊTE ÉDITEUR (rétractable en mode concentration) */}
      {!isFocusMode && (
        <header className="h-14 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md px-4 flex items-center justify-between gap-3 shrink-0 z-20">
          {/* Gauche : Retour, Logo, Titre & Rôle (sans docId selon 4.1) */}
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/"
              className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl transition shrink-0 inline-flex items-center justify-center border border-slate-200/80 dark:border-slate-800"
              title="Retour au tableau de bord"
              aria-label="Retour au tableau de bord"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>

            <Logo variant="mark" size="sm" className="hidden sm:inline-flex shrink-0" />

            <div className="min-w-0">
              <h1 className="font-semibold text-sm text-slate-900 dark:text-white truncate leading-tight">
                {docTitle}
              </h1>
              <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                <span
                  className={`inline-flex items-center gap-1 font-semibold text-[10px] uppercase tracking-wider ${
                    role === "owner"
                      ? "text-purple-600 dark:text-purple-400"
                      : role === "editor"
                      ? "text-indigo-600 dark:text-indigo-400"
                      : "text-slate-500 dark:text-slate-400"
                  }`}
                >
                  {role === "owner" ? "Propriétaire" : role === "editor" ? "Éditeur" : "Lecteur"}
                </span>
                <span>•</span>
                <span className="text-slate-400">
                  {charCount} car.
                </span>
              </div>
            </div>
          </div>

          {/* Droite : Collaborateurs, Synchronisation, Thème & Historique */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {/* Collaborateurs connectés (Awareness) */}
            <div className="flex items-center -space-x-1.5 overflow-hidden">
              {collaborators.map((c) => (
                <div
                  key={c.clientId}
                  title={`${c.name} (en train d'écrire)`}
                  className="h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold text-white border-2 border-white dark:border-slate-900 shadow-xs transition hover:scale-110"
                  style={{ backgroundColor: c.color }}
                >
                  {c.name.substring(0, 1).toUpperCase()}
                </div>
              ))}
            </div>

            {/* Indicateur de synchronisation */}
            <div
              className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60"
              title={
                status === "connected"
                  ? "Toutes les modifications sont synchronisées"
                  : status === "connecting"
                  ? "Connexion en cours…"
                  : "Connexion interrompue"
              }
            >
              {status === "connected" ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-slate-600 dark:text-slate-300 text-[11px] font-medium">Synchronisé</span>
                </>
              ) : status === "connecting" ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 text-amber-500 animate-spin" />
                  <span className="text-amber-600 dark:text-amber-400 text-[11px] font-medium">Connexion…</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3.5 h-3.5 text-rose-500" />
                  <span className="text-rose-600 dark:text-rose-400 text-[11px] font-medium">Hors ligne</span>
                </>
              )}
            </div>

            {/* Bascule Thème Clair (Papier) / Sombre (Nuit) */}
            <ThemeToggle size="sm" />

            {/* Mode concentration */}
            <button
              onClick={() => setIsFocusMode(true)}
              className="p-2 rounded-xl text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200/80 dark:border-slate-800 transition cursor-pointer hidden sm:inline-flex"
              title="Mode concentration (masquer les barres)"
              aria-label="Mode concentration"
            >
              <Maximize2 className="w-4 h-4" />
            </button>

            {/* Bouton Rédacteurs & Crédits pour le propriétaire */}
            {role === "owner" && (
              <button
                onClick={() => setShowEditorsModal(true)}
                className="px-3 py-1.5 text-xs font-semibold rounded-xl border border-slate-300 dark:border-slate-700 bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition flex items-center gap-1.5 cursor-pointer shadow-xs"
                title="Consulter les rédacteurs et leurs crédits restants"
              >
                <Users className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                <span className="hidden sm:inline">Rédacteurs & crédits</span>
              </button>
            )}

            {/* Bouton d'accès au tiroir Historique */}
            <button
              onClick={() => {
                const next = !showHistory;
                setShowHistory(next);
                if (next) loadVersions();
              }}
              className={`px-3 py-1.5 text-xs font-semibold rounded-xl border transition flex items-center gap-1.5 cursor-pointer shadow-xs ${
                showHistory
                  ? "bg-indigo-600 text-white border-indigo-600 shadow-indigo-600/20"
                  : "bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border-slate-300 dark:border-slate-700"
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span>Historique</span>
              {versions.length > 0 && (
                <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300">
                  {versions.length}
                </span>
              )}
            </button>
          </div>
        </header>
      )}

      {/* 2. BARRE D'OUTILS DE RÉDACTION, FORMATAGE & CONTRÔLE D'APERÇU STYLE OVERLEAF */}
      {!isFocusMode && (
        <div className="h-11 border-b border-slate-200 dark:border-slate-800/80 bg-white dark:bg-slate-900/60 px-4 flex items-center justify-between gap-2 overflow-x-auto text-xs shrink-0 z-10">
          {/* Gauche : Outils de mise en forme de texte brut */}
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider mr-1 hidden sm:inline">
              Format
            </span>

            <button
              onClick={() => applyFormatting("h1")}
              disabled={isReadOnly}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition cursor-pointer disabled:opacity-40"
              title="Titre de section (# Titre)"
              aria-label="Titre de section"
            >
              <Heading1 className="w-4 h-4" />
            </button>

            <button
              onClick={() => applyFormatting("h2")}
              disabled={isReadOnly}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition cursor-pointer disabled:opacity-40"
              title="Sous-titre (## Sous-titre)"
              aria-label="Sous-titre"
            >
              <Heading2 className="w-4 h-4" />
            </button>

            <span className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1" />

            <button
              onClick={() => applyFormatting("quote")}
              disabled={isReadOnly}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition cursor-pointer disabled:opacity-40"
              title="Guillemets français « citation »"
              aria-label="Citation avec guillemets"
            >
              <Quote className="w-4 h-4" />
            </button>

            <button
              onClick={() => applyFormatting("bullet")}
              disabled={isReadOnly}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition cursor-pointer disabled:opacity-40"
              title="Liste à puces (• item)"
              aria-label="Liste à puces"
            >
              <List className="w-4 h-4" />
            </button>

            <button
              onClick={() => applyFormatting("number")}
              disabled={isReadOnly}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition cursor-pointer disabled:opacity-40"
              title="Liste numérotée (1. item)"
              aria-label="Liste numérotée"
            >
              <ListOrdered className="w-4 h-4" />
            </button>

            <button
              onClick={() => applyFormatting("separator")}
              disabled={isReadOnly}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition cursor-pointer disabled:opacity-40"
              title="Filet de séparation (---)"
              aria-label="Séparateur horizontal"
            >
              <Minus className="w-4 h-4" />
            </button>

            <span className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1" />

            {/* Transformations de casse */}
            <button
              onClick={() => applyFormatting("upper")}
              disabled={isReadOnly}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition cursor-pointer disabled:opacity-40"
              title="Mettre en MAJUSCULES"
              aria-label="Majuscules"
            >
              <CaseUpper className="w-4 h-4" />
            </button>

            <button
              onClick={() => applyFormatting("lower")}
              disabled={isReadOnly}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition cursor-pointer disabled:opacity-40"
              title="Mettre en minuscules"
              aria-label="Minuscules"
            >
              <CaseLower className="w-4 h-4" />
            </button>

            <button
              onClick={() => applyFormatting("capitalize")}
              disabled={isReadOnly}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition cursor-pointer disabled:opacity-40"
              title="1re Lettre En Capitale"
              aria-label="Capitalisation"
            >
              <CaseSensitive className="w-4 h-4" />
            </button>
          </div>

          {/* Centre/Droite : Sélecteur de mode d'affichage Overleaf & Typographie */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Bascule Mode Overleaf : Éditeur / Scindé (Split) / Aperçu */}
            <div className="flex items-center bg-slate-100 dark:bg-slate-800/90 p-0.5 rounded-xl border border-slate-200/80 dark:border-slate-700">
              <button
                onClick={() => handleViewModeChange("editor")}
                className={`px-2 py-1 rounded-lg text-xs transition cursor-pointer inline-flex items-center gap-1 ${
                  viewMode === "editor"
                    ? "bg-white dark:bg-slate-700 text-indigo-700 dark:text-white shadow-xs font-semibold"
                    : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                }`}
                title="Éditeur source seul"
              >
                <PenLine className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Éditeur</span>
              </button>

              <button
                onClick={() => handleViewModeChange("split")}
                className={`px-2 py-1 rounded-lg text-xs transition cursor-pointer inline-flex items-center gap-1 ${
                  viewMode === "split"
                    ? "bg-white dark:bg-slate-700 text-indigo-700 dark:text-white shadow-xs font-semibold"
                    : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                }`}
                title="Vue scindée Overleaf (Code + Feuille en temps réel)"
              >
                <Columns2 className="w-3.5 h-3.5" />
                <span>Scindé</span>
              </button>

              <button
                onClick={() => handleViewModeChange("preview")}
                className={`px-2 py-1 rounded-lg text-xs transition cursor-pointer inline-flex items-center gap-1 ${
                  viewMode === "preview"
                    ? "bg-white dark:bg-slate-700 text-indigo-700 dark:text-white shadow-xs font-semibold"
                    : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                }`}
                title="Aperçu tirage journal seul"
              >
                <BookOpen className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Aperçu</span>
              </button>
            </div>

            {/* Choix de police */}
            <div className="hidden lg:flex items-center bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/80 dark:border-slate-700/60">
              <button
                onClick={() => handleFontChange("serif")}
                className={`px-2 py-0.5 rounded text-[11px] font-serif transition cursor-pointer ${
                  fontFamily === "serif"
                    ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs font-semibold"
                    : "text-slate-500 hover:text-slate-900 dark:hover:text-white"
                }`}
                title="Police Sérif (style journal / roman)"
              >
                Sérif
              </button>
              <button
                onClick={() => handleFontChange("sans")}
                className={`px-2 py-0.5 rounded text-[11px] font-sans transition cursor-pointer ${
                  fontFamily === "sans"
                    ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs font-semibold"
                    : "text-slate-500 hover:text-slate-900 dark:hover:text-white"
                }`}
                title="Police Sans-serif (moderne)"
              >
                Sans
              </button>
              <button
                onClick={() => handleFontChange("mono")}
                className={`px-2 py-0.5 rounded text-[11px] font-mono transition cursor-pointer ${
                  fontFamily === "mono"
                    ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs font-semibold"
                    : "text-slate-500 hover:text-slate-900 dark:hover:text-white"
                }`}
                title="Police Monospace (dactylographie)"
              >
                Mono
              </button>
            </div>

            {/* Taille de police S / M / L */}
            <div className="hidden xl:flex items-center bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/80 dark:border-slate-700/60">
              <button
                onClick={() => handleSizeChange("sm")}
                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition cursor-pointer ${
                  fontSize === "sm"
                    ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs"
                    : "text-slate-500 hover:text-slate-900 dark:hover:text-white"
                }`}
                title="Petite taille de texte"
              >
                S
              </button>
              <button
                onClick={() => handleSizeChange("md")}
                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition cursor-pointer ${
                  fontSize === "md"
                    ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs"
                    : "text-slate-500 hover:text-slate-900 dark:hover:text-white"
                }`}
                title="Taille de texte normale"
              >
                M
              </button>
              <button
                onClick={() => handleSizeChange("lg")}
                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition cursor-pointer ${
                  fontSize === "lg"
                    ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs"
                    : "text-slate-500 hover:text-slate-900 dark:hover:text-white"
                }`}
                title="Grande taille de texte"
              >
                L
              </button>
            </div>

            {/* Bouton Copier tout */}
            <button
              onClick={handleCopyAll}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition cursor-pointer inline-flex items-center gap-1"
              title="Copier tout le texte dans le presse-papiers"
              aria-label="Copier tout le texte"
            >
              {copySuccess ? (
                <Check className="w-3.5 h-3.5 text-emerald-600" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>
      )}

      {/* 3. BANDEAU DE REFUS OU LECTURE SEULE */}
      {(refusalMessage || isReadOnly) && (
        <div className="bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-800/60 px-4 py-2 flex items-center justify-between text-xs text-amber-800 dark:text-amber-200 shrink-0">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <span className="font-medium">
              {refusalMessage || "Mode consultation : vous êtes lecteur sur ce document."}
            </span>
          </div>
        </div>
      )}

      {/* 4. DISPOSITION PRINCIPALE STYLE OVERLEAF (ÉDITEUR SOURCE + APERÇU TEMPS RÉEL) */}
      <main className="flex-1 w-full overflow-hidden flex relative">
        {/* Bouton de sortie du mode concentration */}
        {isFocusMode && (
          <button
            onClick={() => setIsFocusMode(false)}
            className="fixed top-4 right-4 z-50 p-2.5 rounded-full bg-white/90 dark:bg-slate-800/90 backdrop-blur-md shadow-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:scale-105 transition cursor-pointer"
            title="Quitter le mode concentration (ou touche Échap)"
            aria-label="Quitter le mode concentration"
          >
            <Minimize2 className="w-4 h-4" />
          </button>
        )}

        {/* Panneau gauche : Éditeur source CodeMirror */}
        {(viewMode === "editor" || viewMode === "split") && (
          <div
            className={`h-full overflow-y-auto flex justify-center py-6 px-4 relative ${
              viewMode === "split" ? "w-full md:w-1/2 border-r border-slate-200 dark:border-slate-800" : "w-full"
            }`}
          >
            <div
              className={`w-full max-w-2xl min-h-[calc(100vh-140px)] bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800/90 shadow-sm rounded-2xl flex flex-col transition-all ${
                fontClass
              } ${sizeClass}`}
            >
              <div
                ref={editorContainerRef}
                className="flex-1 w-full h-full min-h-[500px]"
              />
            </div>
          </div>
        )}

        {/* Panneau droit : Rendu direct de la feuille */}
        {(viewMode === "preview" || viewMode === "split") && (
          <div
            className={`h-full overflow-y-auto bg-stone-200/70 dark:bg-slate-950/80 flex flex-col items-center py-4 px-3 sm:px-6 relative ${
              viewMode === "split" ? "hidden md:flex md:w-1/2" : "w-full flex"
            }`}
          >
            {/* Barre de contrôle du zoom Overleaf */}
            <div className="w-full max-w-[640px] flex items-center justify-between pb-3 text-xs text-slate-600 dark:text-slate-400 select-none">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Rendu direct
                </span>
                <span className="hidden sm:inline text-[11px] text-slate-500">
                  Style Overleaf Journal
                </span>
              </div>

              <div className="flex items-center gap-1.5 bg-white dark:bg-slate-900 px-2 py-1 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
                <button
                  onClick={() => setPreviewZoom((z) => Math.max(0.7, Number((z - 0.1).toFixed(2))))}
                  className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition cursor-pointer"
                  title="Zoom arrière"
                  aria-label="Zoom arrière"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <span className="text-[11px] font-semibold font-mono w-10 text-center text-slate-700 dark:text-slate-300">
                  {Math.round(previewZoom * 100)}%
                </span>
                <button
                  onClick={() => setPreviewZoom((z) => Math.min(1.3, Number((z + 0.1).toFixed(2))))}
                  className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition cursor-pointer"
                  title="Zoom avant"
                  aria-label="Zoom avant"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Feuille de journal en temps réel */}
            <LiveOverleafSheet
              title={docTitle}
              text={liveText}
              zoom={previewZoom}
              authors={collaboratorNames}
            />
          </div>
        )}
      </main>

      {/* 5. BARRE D'ÉTAT BASSE */}
      {!isFocusMode && (
        <footer className="h-8 border-t border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xs px-4 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 shrink-0 z-10 select-none">
          <div className="flex items-center gap-3">
            <span>
              <strong className="text-slate-700 dark:text-slate-200 font-semibold">{wordCount}</strong> mots
            </span>
            <span>•</span>
            <span>
              <strong className="text-slate-700 dark:text-slate-200 font-semibold">{charCount}</strong> caractères
            </span>
            <span className="hidden sm:inline">•</span>
            <span className="hidden sm:inline">
              Lecture : ~<strong>{readTimeMinutes}</strong> min
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden md:inline text-slate-400">
              Association AWS — Journal étudiant
            </span>
          </div>
        </footer>
      )}

      {/* 6. TIROIR LATÉRAL HISTORIQUE HAUTE-FIDÉLITÉ */}
      {showHistory && (
        <>
          {/* Voile sombre pour mobile */}
          <div
            className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-30 sm:hidden"
            onClick={() => setShowHistory(false)}
          />

          <aside className="fixed inset-y-0 right-0 w-full sm:w-[420px] bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-2xl z-40 flex flex-col animate-in slide-in-from-right duration-200">
            {/* En-tête du tiroir */}
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/70 dark:bg-slate-900/70">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center border border-indigo-100 dark:border-indigo-900">
                  <History className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-semibold text-sm text-slate-900 dark:text-white">
                    Historique des versions
                  </h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Points de sauvegarde et restauration
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowHistory(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
                aria-label="Fermer l'historique"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Messages d'alerte / confirmation */}
            {historyMsg && (
              <div
                className={`p-3 text-xs border-b ${
                  historyMsg.type === "success"
                    ? "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300"
                    : "bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300"
                }`}
              >
                {historyMsg.text}
              </div>
            )}

            {/* Barre d'action création de version */}
            <div className="p-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 flex items-center gap-2">
              <button
                onClick={handleCreateSnapshot}
                disabled={actionLoading || role === "viewer"}
                className="flex-1 py-2 px-3 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition shadow-xs flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>{actionLoading ? "Enregistrement…" : "Enregistrer une version"}</span>
              </button>
              <button
                onClick={loadVersions}
                disabled={historyLoading}
                className="p-2 rounded-xl text-xs font-medium bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 transition cursor-pointer"
                title="Actualiser la liste"
                aria-label="Actualiser la liste des versions"
              >
                <RotateCcw className={`w-3.5 h-3.5 ${historyLoading ? "animate-spin" : ""}`} />
              </button>
            </div>

            {/* Liste chronologique groupée */}
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
              {historyLoading && versions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-2">
                  <Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
                  <p className="text-xs">Chargement de l&apos;historique…</p>
                </div>
              ) : versions.length === 0 ? (
                <div className="text-center py-12 text-slate-400">
                  <Clock className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
                  <p className="text-xs italic">Aucun point de version enregistré pour l&apos;instant.</p>
                </div>
              ) : (
                Object.entries(groupedVersions).map(([groupTitle, items]) => (
                  <div key={groupTitle} className="space-y-1.5">
                    <h4 className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider px-1">
                      {groupTitle}
                    </h4>
                    <div className="space-y-1">
                      {items.map((v) => {
                        const isSelected = selectedSnapshotId === v.snapshotId;
                        const date = new Date(v.createdAt * 1000);
                        const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

                        const isManual = v.reason === "manual";
                        const isRestore = v.reason === "restore";

                        return (
                          <div
                            key={v.snapshotId}
                            onClick={() => loadPreview(v.snapshotId)}
                            className={`p-3 rounded-xl text-left transition cursor-pointer border ${
                              isSelected
                                ? "bg-indigo-50/80 dark:bg-indigo-950/40 border-indigo-400 dark:border-indigo-600 shadow-xs"
                                : "bg-white hover:bg-slate-50 dark:bg-slate-800/40 dark:hover:bg-slate-800/80 border-slate-200/80 dark:border-slate-800"
                            }`}
                          >
                            <div className="flex items-center justify-between text-xs font-semibold">
                              <span className="text-slate-900 dark:text-white flex items-center gap-1.5">
                                <Clock className="w-3.5 h-3.5 text-slate-400" />
                                {timeStr}
                              </span>
                              <span
                                className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                                  isManual
                                    ? "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300"
                                    : isRestore
                                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                                }`}
                              >
                                {isManual
                                  ? "Manuel"
                                  : isRestore
                                  ? "Restauration"
                                  : "Auto"}
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 mt-1.5">
                              <span>{v.createdBy ? `Par ${v.createdBy}` : "Point de contrôle"}</span>
                              <span className="font-medium text-slate-700 dark:text-slate-300">
                                {v.chars.toLocaleString()} car.
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Aperçu et Restauration */}
            {selectedSnapshotId && (
              <div className="p-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300">
                  <span>Aperçu de la version sélectionnée</span>
                  <button
                    onClick={() => setRestoreConfirmSnapId(selectedSnapshotId)}
                    disabled={actionLoading || role === "viewer"}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition disabled:opacity-50 cursor-pointer shadow-xs flex items-center gap-1"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Restaurer</span>
                  </button>
                </div>
                <div className="h-32 overflow-y-auto p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs font-mono text-slate-800 dark:text-slate-200 whitespace-pre-wrap leading-relaxed shadow-inner">
                  {previewContent || "Aucun contenu"}
                </div>
              </div>
            )}
          </aside>
        </>
      )}

      {/* 7. MODALE DE CONFIRMATION DE RESTAURATION */}
      {restoreConfirmSnapId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="max-w-md w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150">
            <div className="h-10 w-10 rounded-2xl bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
              <RotateCcw className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">
                Restaurer cette version ?
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                La restauration charge le contenu de cette version et crée une nouvelle évolution dans l&apos;arbre de modifications.
                L&apos;historique existant est intégralement conservé (garantie I08).
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setRestoreConfirmSnapId(null)}
                className="px-3.5 py-2 text-xs font-semibold rounded-xl text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
              >
                Annuler
              </button>
              <button
                onClick={() => executeRestore(restoreConfirmSnapId)}
                className="px-4 py-2 text-xs font-semibold rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white transition shadow-sm cursor-pointer"
              >
                Confirmer la restauration
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Modal Rédacteurs & Crédits pour le propriétaire */}
      {role === "owner" && (
        <EditorsModal
          docId={docId}
          docTitle={docTitle}
          isOpen={showEditorsModal}
          onClose={() => setShowEditorsModal(false)}
        />
      )}
    </div>
  );
}
