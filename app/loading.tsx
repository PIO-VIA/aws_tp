import { Logo } from "@/src/components/brand/Logo";

export default function Loading() {
  return (
    <div
      className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 text-center font-sans"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center space-y-4">
        <div className="animate-pulse">
          <Logo variant="stacked" size={56} decorative />
        </div>
        <p className="text-xs text-slate-400 font-medium tracking-wide">
          Chargement en cours...
        </p>
      </div>
    </div>
  );
}
