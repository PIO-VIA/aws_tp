/**
 * Configuration centrale : lecture et validation de TOUTES les variables
 * d'environnement (zod). Le même code tourne en local et sur AWS ; seuls les
 * endpoints et pilotes changent.
 */
import { z } from "zod";

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes"].includes(v.toLowerCase())));

const intFrom = (def: number, min = 0) =>
  z.coerce.number().int().min(min).default(def);

const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(z.string().url().optional());

export const configSchema = z
  .object({
    APP_ENV: z.enum(["local", "aws"]).default("local"),
    AWS_REGION: z.string().min(1).default("eu-west-3"),
    TABLE_PREFIX: z.string().min(1).default("editeur-local-"),

    DDB_ENDPOINT: optionalUrl,
    S3_ENDPOINT: optionalUrl,
    /** Hôte joignable par le navigateur pour les URL pré-signées (local). */
    S3_PUBLIC_ENDPOINT: optionalUrl,
    S3_FORCE_PATH_STYLE: bool.optional(),
    S3_BUCKET: z.string().min(3),
    SQS_ENDPOINT: optionalUrl,
    PDF_QUEUE_URL: z.string().min(1),
    PDF_DLQ_URL: z.string().optional(),

    MAIL_DRIVER: z.enum(["smtp", "ses"]).default("smtp"),
    SMTP_HOST: z.string().default("localhost"),
    SMTP_PORT: intFrom(1025, 1),
    MAIL_FROM: z.string().min(3).default("journal@example.org"),

    STREAM_MODE: z.enum(["inline", "aws"]).default("inline"),

    // Secrets : valeurs par défaut de développement (sur AWS, injectés par SSM / env).
    SESSION_SECRET: z.string().default("dev-session-secret-change-in-prod-at-least-32-chars"),
    INTERNAL_TOKEN: z.string().default("dev-internal-token-change-in-prod"),
    ADMIN_TOKEN: z.string().default("dev-admin-token-change-in-prod"),
    SSM_PREFIX: z.string().default("/editeur-collab/dev/"),

    /** Origines autorisées pour les POST/DELETE authentifiés (liste, virgules). */
    APP_ORIGINS: z.string().optional(),

    NEXT_PUBLIC_COLLAB_URL: z.string().default("ws://localhost:1234"),
    COLLAB_PORT: intFrom(1234, 1),
    COLLAB_INTERNAL_PORT: intFrom(1235, 1),
    COLLAB_INTERNAL_HOST: z.string().default("127.0.0.1"),
    COLLAB_INTERNAL_URL: z.string().default("http://localhost:1235"),

    DAILY_CREDIT: intFrom(10000, 1),
    MAX_DOWNLOADS_CAP: intFrom(1000, 1),
    PRESIGN_TTL_SEC: intFrom(60, 5),
    HEAD_COALESCE_MS: intFrom(1000, 0),
    MAX_UPDATE_BYTES: intFrom(65536, 1024),
    MAX_AWARENESS_BYTES: intFrom(2048, 256),

    ABUSE_THRESHOLD: intFrom(10, 1),
    ABUSE_WINDOW_SEC: intFrom(60, 1),
    BLOCK_DURATION_SEC: intFrom(900, 1),
    RATE_MAX_UPDATES_PER_SEC: intFrom(50, 1),
    RESTORE_MAX_PER_HOUR: intFrom(10, 1),
    RESERVATION_MAX_AGE_SEC: intFrom(600, 10),

    SNAPSHOT_EVERY_UPDATES: intFrom(100, 1),
    SNAPSHOT_EVERY_SEC: intFrom(300, 1),
    JOURNAL_TTL_DAYS: intFrom(30, 1),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .transform((c) => ({
    ...c,
    S3_FORCE_PATH_STYLE:
      c.S3_FORCE_PATH_STYLE !== undefined ? c.S3_FORCE_PATH_STYLE : c.APP_ENV === "local",
  }))
  .superRefine((c, ctx) => {
    if (c.APP_ENV === "local") {
      for (const k of ["DDB_ENDPOINT", "S3_ENDPOINT", "SQS_ENDPOINT"] as const) {
        if (!c[k]) ctx.addIssue({ code: "custom", path: [k], message: `${k} requis en local` });
      }
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

let cached: AppConfig | null = null;

/** Retourne la configuration validée ; lève une erreur explicite sinon. */
export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(racine)"} : ${i.message}`)
      .join("\n");
    throw new Error(`Configuration invalide :\n${details}`);
  }
  cached = parsed.data;
  return cached;
}

/** Réinitialise le cache (tests : changement de TABLE_PREFIX, seuils, ...). */
export function resetConfig(): void {
  cached = null;
}

export function tableName(name: TableKey): string {
  return `${getConfig().TABLE_PREFIX}${name}`;
}

export type TableKey =
  | "writers"
  | "documents"
  | "doc_permissions"
  | "doc_updates"
  | "doc_snapshots"
  | "doc_heads"
  | "quota"
  | "abuse_events"
  | "links"
  | "reservations"
  | "pdf_jobs"
  | "notifications";

export const ALL_TABLES: TableKey[] = [
  "writers",
  "documents",
  "doc_permissions",
  "doc_updates",
  "doc_snapshots",
  "doc_heads",
  "quota",
  "abuse_events",
  "links",
  "reservations",
  "pdf_jobs",
  "notifications",
];
