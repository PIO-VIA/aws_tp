/**
 * Handler Lambda pour download-api (Function URL / API Gateway HTTP API v2)
 *
 * Supporte :
 *  - POST /api/dl/:linkId/request
 *  - GET  /api/dl/:linkId/reservations/:reservationId
 *  - GET  /api/dl/:linkId/status
 */
import { handleDownloadRequest, handleGetReservation } from "../src/shared/links/reservations";
import { getLink, isLinkExhaustedInMemory, markLinkExhaustedInMemory } from "../src/shared/links/links";
import { dlRequestSchema, linkIdSchema } from "../src/shared/links/types";
import { log } from "../src/shared/log";

interface LambdaEvent {
  rawPath?: string;
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
    };
  };
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface LambdaResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
  const method = (event.requestContext?.http?.method || "GET").toUpperCase();
  const rawPath = event.rawPath || event.requestContext?.http?.path || "/";

  log.info("download_api.request", { method, rawPath });

  // 1. POST /api/dl/:linkId/request
  const requestMatch = rawPath.match(/^\/api\/dl\/([^/]+)\/request\/?$/);
  if (requestMatch && method === "POST") {
    const linkId = requestMatch[1];
    let bodyData: unknown;
    try {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf-8")
        : event.body || "{}";
      bodyData = JSON.parse(rawBody);
    } catch {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: { code: "invalid_body", message: "Corps JSON invalide" } }),
      };
    }

    const parsed = dlRequestSchema.safeParse(bodyData);
    if (!parsed.success) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: { code: "invalid_request_id", message: "requestId (UUID v4) requis" } }),
      };
    }

    const result = await handleDownloadRequest(linkId, parsed.data.requestId);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (result.retryAfterSec !== undefined) {
      headers["Retry-After"] = String(result.retryAfterSec);
    }

    return {
      statusCode: result.status,
      headers,
      body: JSON.stringify(result.body),
    };
  }

  // 2. GET /api/dl/:linkId/reservations/:reservationId
  const reservationMatch = rawPath.match(/^\/api\/dl\/([^/]+)\/reservations\/([^/]+)\/?$/);
  if (reservationMatch && method === "GET") {
    const linkId = reservationMatch[1];
    const reservationId = reservationMatch[2];

    const result = await handleGetReservation(linkId, reservationId);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (result.retryAfterSec !== undefined) {
      headers["Retry-After"] = String(result.retryAfterSec);
    }

    return {
      statusCode: result.status,
      headers,
      body: JSON.stringify(result.body),
    };
  }

  // 3. GET /api/dl/:linkId/status
  const statusMatch = rawPath.match(/^\/api\/dl\/([^/]+)\/status\/?$/);
  if (statusMatch && method === "GET") {
    const rawLinkId = statusMatch[1];
    const parsed = linkIdSchema.safeParse(rawLinkId);
    if (!parsed.success) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: { code: "invalid_id", message: "Identifiant invalide" } }),
      };
    }

    const linkId = parsed.data;

    // Fast path mémoire
    if (isLinkExhaustedInMemory(linkId)) {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=1",
        },
        body: JSON.stringify({ state: "exhausted" }),
      };
    }

    const link = await getLink(linkId);
    if (!link || link.status !== "active") {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: { code: "not_found", message: "Lien inconnu ou révoqué" } }),
      };
    }

    const isExhausted = link.issued >= link.maxDownloads;
    if (isExhausted) {
      markLinkExhaustedInMemory(linkId);
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=1",
        },
        body: JSON.stringify({ state: "exhausted" }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        state: "available",
        remaining: Math.max(0, link.maxDownloads - link.issued),
        total: link.maxDownloads,
      }),
    };
  }

  return {
    statusCode: 404,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: { code: "route_not_found", message: "Route introuvable" } }),
  };
}
