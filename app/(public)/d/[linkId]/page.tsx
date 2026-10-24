"use client";

import { use, useEffect, useState, useRef, useCallback } from "react";

type DlState =
  | "checking"
  | "idle"
  | "preparing"
  | "retrying"
  | "granted"
  | "exhausted"
  | "expired"
  | "failed";

export default function DownloadPage({
  params,
}: {
  params: Promise<{ linkId: string }>;
}) {
  const { linkId } = use(params);
  const [state, setState] = useState<DlState>("checking");
  const [message, setMessage] = useState<string>("Vérification de la disponibilité du document...");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);

  // Initialisation paresseuse du requestId depuis sessionStorage
  const [requestId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    const storageKey = `dl_req_${linkId}`;
    let reqId = sessionStorage.getItem(storageKey);
    if (!reqId) {
      reqId = crypto.randomUUID();
      sessionStorage.setItem(storageKey, reqId);
    }
    return reqId;
  });

  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const triggerDownload = useCallback((url: string) => {
    // 1. Iframe cachée : méthode standard pour déclencher un téléchargement d'attachment
    // sans quitter la page et sans être bloqué par les politiques de clic asynchrone des navigateurs
    try {
      const iframe = document.createElement("iframe");
      iframe.style.display = "none";
      iframe.src = url;
      document.body.appendChild(iframe);
      setTimeout(() => {
        try {
          document.body.removeChild(iframe);
        } catch {}
      }, 30000);
    } catch {}

    // 2. Navigation directe de secours (puisque Content-Disposition: attachment, la page reste active)
    try {
      window.location.assign(url);
    } catch {
      window.location.href = url;
    }
  }, []);

  const startPollingReservation = useCallback((resId: string, initialRetryMs = 1500) => {
    setState("preparing");
    setMessage("Réservation acceptée. Préparation du PDF en cours...");

    const poll = async (retryMs: number) => {
      try {
        const res = await fetch(`/api/dl/${linkId}/reservations/${resId}`);
        const data = await res.json();

        if (data.state === "granted" && data.url) {
          setState("granted");
          setDownloadUrl(data.url);
          setFilename(data.filename ?? "document.pdf");
          setMessage("Votre document est prêt ! Téléchargement en cours...");
          triggerDownload(data.url);
          return;
        }

        if (data.state === "failed") {
          setState("failed");
          setMessage("La préparation a échoué. Votre réservation a été remboursée. Vous pouvez réessayer.");
          return;
        }

        if (data.state === "expired") {
          setState("expired");
          setMessage("L'autorisation de téléchargement a expiré.");
          return;
        }

        // Toujours en préparation
        const nextMs = data.retryAfterMs || Math.round(retryMs * 1.2);
        pollingRef.current = setTimeout(() => poll(nextMs), nextMs);
      } catch {
        pollingRef.current = setTimeout(() => poll(2000), 2000);
      }
    };

    pollingRef.current = setTimeout(() => poll(initialRetryMs), initialRetryMs);
  }, [linkId, triggerDownload]);

  // Vérification initiale : vérifie si l'utilisateur a déjà une réservation, sinon l'état du lien
  useEffect(() => {
    let active = true;

    async function checkInitialStatus() {
      // 1. Si ce visiteur a déjà un requestId en session, vérifier s'il a déjà une réservation
      if (requestId) {
        try {
          const resRes = await fetch(`/api/dl/${linkId}/reservations/${requestId}`);
          if (!active) return;
          if (resRes.ok) {
            const data = await resRes.json();
            if (data.state === "granted" && data.url) {
              setState("granted");
              setDownloadUrl(data.url);
              setFilename(data.filename ?? "document.pdf");
              setMessage("Votre exemplaire a été accordé. Téléchargement prêt !");
              return;
            }
            if (data.state === "preparing") {
              startPollingReservation(requestId, data.retryAfterMs || 1500);
              return;
            }
          }
        } catch {
          // Ignorer et basculer sur la vérification du lien
        }
      }

      // 2. Sinon, vérifier le statut global du lien
      try {
        const res = await fetch(`/api/dl/${linkId}/status`);
        if (!active) return;
        if (!res.ok) {
          setState("failed");
          setMessage("Lien introuvable ou désactivé.");
          return;
        }
        const data = await res.json();
        if (data.state === "exhausted") {
          setState("exhausted");
          setMessage("Ce lien de téléchargement a atteint son quota d'exemplaires.");
        } else {
          setState("idle");
          setMessage("Un exemplaire est disponible pour ce document.");
        }
      } catch {
        if (active) {
          setState("failed");
          setMessage("Erreur de connexion au serveur.");
        }
      }
    }

    checkInitialStatus();

    return () => {
      active = false;
      if (pollingRef.current) clearTimeout(pollingRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [linkId, requestId, startPollingReservation]);

  const handleRequestDownload = async () => {
    if (!requestId || state === "preparing" || state === "granted") return;

    setState("preparing");
    setMessage("Réservation d'un exemplaire en cours...");
    setElapsedSec(0);

    timerRef.current = setInterval(() => {
      setElapsedSec((s) => s + 1);
    }, 1000);

    try {
      const res = await fetch(`/api/dl/${linkId}/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });

      const data = await res.json();

      if (res.status === 200 && data.state === "granted" && data.url) {
        if (timerRef.current) clearInterval(timerRef.current);
        setState("granted");
        setDownloadUrl(data.url);
        setFilename(data.filename ?? "document.pdf");
        setMessage("Exemplaire accordé ! Le téléchargement va démarrer.");
        triggerDownload(data.url);
        return;
      }

      if (res.status === 202 && data.state === "preparing") {
        startPollingReservation(data.reservationId, data.retryAfterMs || 1500);
        return;
      }

      if (data.state === "retry") {
        setState("retrying");
        setMessage("Forte affluence sur le serveur. Réessai automatique...");
        const waitMs = data.retryAfterMs || 1500;
        pollingRef.current = setTimeout(() => {
          handleRequestDownload();
        }, waitMs);
        return;
      }

      if (data.state === "exhausted") {
        if (timerRef.current) clearInterval(timerRef.current);
        setState("exhausted");
        setMessage("Lien épuisé : tous les exemplaires ont déjà été attribués.");
        return;
      }

      if (timerRef.current) clearInterval(timerRef.current);
      setState("failed");
      setMessage("Impossible d'obtenir un exemplaire. Veuillez réessayer.");
    } catch {
      if (timerRef.current) clearInterval(timerRef.current);
      setState("failed");
      setMessage("Erreur lors de la communication avec le serveur.");
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl p-8 shadow-2xl space-y-6">
        <header className="space-y-2 text-center">
          <span className="inline-block px-3 py-1 text-xs font-semibold tracking-wider uppercase bg-blue-950 text-blue-400 rounded-full border border-blue-800">
            Journal de l&apos;Association
          </span>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Téléchargement du Document
          </h1>
          <p className="text-sm text-zinc-400">
            Lien sécurisé à tirage limité. Chaque réservation accorde une copie unique.
          </p>
        </header>

        <div className="bg-zinc-950/80 border border-zinc-800 rounded-xl p-5 space-y-3">
          <div className="flex items-center space-x-3">
            {state === "checking" || state === "preparing" || state === "retrying" ? (
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            ) : state === "granted" ? (
              <span className="text-emerald-400 font-bold">✓</span>
            ) : state === "exhausted" ? (
              <span className="text-amber-500 font-bold">✕</span>
            ) : (
              <span className="text-zinc-500 font-bold">ℹ</span>
            )}
            <p className="text-sm font-medium text-zinc-200">{message}</p>
          </div>

          {(state === "preparing" || state === "retrying") && (
            <div className="text-xs text-zinc-500 flex justify-between pt-2 border-t border-zinc-800/60">
              <span>Temps d&apos;attente : {elapsedSec} s</span>
              <span>Plafond : 60 s</span>
            </div>
          )}
        </div>

        <div className="pt-2">
          {state === "idle" && (
            <button
              id="dl-request-btn"
              onClick={handleRequestDownload}
              className="w-full py-3.5 px-4 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-semibold rounded-xl transition duration-150 flex items-center justify-center space-x-2 shadow-lg shadow-blue-900/40 cursor-pointer"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              <span>Télécharger mon exemplaire PDF</span>
            </button>
          )}

          {state === "preparing" && (
            <button
              disabled
              className="w-full py-3.5 px-4 bg-zinc-800 text-zinc-300 font-medium rounded-xl cursor-not-allowed flex items-center justify-center space-x-2"
            >
              <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              <span>Réservation et préparation du PDF...</span>
            </button>
          )}

          {state === "granted" && downloadUrl && (
            <div className="space-y-3">
              <div className="p-3 bg-emerald-950/40 border border-emerald-800/60 rounded-xl text-center space-y-1">
                <p className="text-emerald-400 font-semibold text-sm flex items-center justify-center gap-1.5">
                  <span>✓</span> Téléchargement lancé automatiquement
                </p>
                <p className="text-zinc-400 text-xs">
                  Fichier : <span className="font-mono text-zinc-300">{filename}</span>
                </p>
              </div>
              <a
                id="dl-direct-link"
                href={downloadUrl}
                download={filename ?? "document.pdf"}
                className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition flex items-center justify-center space-x-2 shadow-lg shadow-emerald-900/30 text-sm"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span>Télécharger à nouveau ({filename})</span>
              </a>
            </div>
          )}

          {state === "exhausted" && (
            <div className="text-center p-4 bg-amber-950/20 border border-amber-800/40 rounded-xl text-amber-300 text-sm">
              Tous les exemplaires autorisés pour ce document ont été distribués.
            </div>
          )}

          {state === "failed" && (
            <button
              onClick={handleRequestDownload}
              className="w-full py-3 px-4 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium rounded-xl transition cursor-pointer"
            >
              <span>Réessayer la demande</span>
            </button>
          )}
        </div>

        <footer className="text-center text-xs text-zinc-600">
          Identifiant visiteur anonyme : <code className="font-mono text-zinc-500">{requestId.substring(0, 8)}...</code>
        </footer>
      </div>
    </div>
  );
}
