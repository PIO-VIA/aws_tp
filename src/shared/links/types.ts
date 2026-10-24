import { z } from "zod";

export type LinkStatus = "active" | "revoked";

export interface LinkRecord {
  linkId: string;
  docId: string;
  creatorId: string;
  creatorEmail: string;
  creatorName: string;
  maxDownloads: number;
  issued: number;
  status: LinkStatus;
  createdAt: number; // Epoch seconds
}

export type ReservationStatus = "reserved" | "url_issued" | "cancelled";

export interface ReservationRecord {
  linkId: string;
  reservationId: string; // (= requestId client)
  status: ReservationStatus;
  docId: string;
  versionId?: string;
  selectedAt?: number;
  issuedAt?: number;
  url?: string;
  urlExpiresAt?: number;
  filename?: string;
  createdAt: number;
  ttl?: number;
}

export interface PdfJobRecord {
  jobId: string; // `${docId}#${versionId}`
  docId: string;
  versionId: string;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface NotificationRecord {
  linkId: string;
  status: "pending" | "sent";
  attempts: number;
  createdAt: number;
  sentAt?: number;
  lastError?: string;
}

// Schémas de validation zod pour l'API publique /api/dl/*
export const linkIdSchema = z
  .string()
  .min(10)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, "linkId invalide");

export const requestIdSchema = z.string().uuid("requestId doit être un UUID v4");

export const dlRequestSchema = z.object({
  requestId: requestIdSchema,
});

export type DlRequestInput = z.infer<typeof dlRequestSchema>;

export type DlResponseState =
  | { state: "granted"; url: string; expiresAt: number; reservationId: string; filename: string }
  | { state: "preparing"; reservationId: string; retryAfterMs: number }
  | { state: "retry"; retryAfterMs: number }
  | { state: "exhausted" }
  | { state: "failed" }
  | { state: "expired" };
