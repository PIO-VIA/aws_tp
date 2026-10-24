/**
 * Logs JSON structurés (une ligne = un objet) et métriques.
 * Sur Lambda : métriques au format EMF (Embedded Metric Format), extraites
 * automatiquement par CloudWatch. Ailleurs : simple ligne de log "metric".
 * Ne jamais logguer d'e-mail en clair ni de secret.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): number {
  const l = (process.env.LOG_LEVEL as Level) || "info";
  return ORDER[l] ?? 20;
}

function write(level: Level, event: string, fields: Record<string, unknown>) {
  if (ORDER[level] < minLevel()) return;
  if (process.env.LOG_SILENT === "1") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }, (_k, v) =>
    v instanceof Error ? { name: v.name, message: v.message } : typeof v === "bigint" ? String(v) : v,
  );
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (event: string, fields: Record<string, unknown> = {}) => write("debug", event, fields),
  info: (event: string, fields: Record<string, unknown> = {}) => write("info", event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => write("warn", event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => write("error", event, fields),
};

const NAMESPACE = "EditeurCollab";

/**
 * Émet une métrique. `dims` : dimensions (peu nombreuses, faible cardinalité).
 */
export function metric(
  name: string,
  value = 1,
  dims: Record<string, string> = {},
  unit: "Count" | "Milliseconds" = "Count",
): void {
  if (process.env.LOG_SILENT === "1") return;
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const emf = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: NAMESPACE,
            Dimensions: [Object.keys(dims)],
            Metrics: [{ Name: name, Unit: unit }],
          },
        ],
      },
      ...dims,
      [name]: value,
    };
    process.stdout.write(JSON.stringify(emf) + "\n");
    return;
  }
  if (minLevel() <= ORDER.debug) write("debug", "metric", { name, value, unit, ...dims });
}

/** Mesure la durée d'une promesse (ms). */
export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = performance.now();
  const result = await fn();
  return { result, ms: Math.round(performance.now() - t0) };
}
