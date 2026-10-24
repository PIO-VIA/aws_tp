import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient } from "../aws/dynamodb";
import { tableName, getConfig } from "../config";
import { hashEmail, createSessionJwt, verifySessionJwt, SessionPayload } from "./jwt";
import { getWriterQuota, QuotaStatus } from "../quota/quota";
import { log } from "../log";

export interface WriterRecord {
  writerId: string;
  email: string;
  name: string;
  createdAt: number;
  blockedUntil?: number;
  blockReason?: string;
}

export interface SessionResult {
  writer: {
    id: string;
    name: string;
    email: string;
  };
  writerId: string;
  credit: QuotaStatus;
  blockedUntil?: number;
  token?: string;
}


export async function getWriter(writerId: string): Promise<WriterRecord | null> {
  const docClient = getDocClient();
  const tName = tableName("writers");

  const res = await docClient.send(
    new GetCommand({
      TableName: tName,
      Key: { writerId },
    }),
  );

  return (res.Item as WriterRecord) ?? null;
}

export async function upsertWriter(name: string, email: string): Promise<WriterRecord> {
  const writerId = hashEmail(email);
  const existing = await getWriter(writerId);

  if (existing) {
    // Si le nom a changé, on pourrait le mettre à jour, mais on conserve les blocages existants
    return existing;
  }

  const docClient = getDocClient();
  const tName = tableName("writers");
  const now = Math.floor(Date.now() / 1000);

  const newWriter: WriterRecord = {
    writerId,
    email: email.trim().toLowerCase(),
    name: name.trim(),
    createdAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: tName,
      Item: newWriter,
      ConditionExpression: "attribute_not_exists(writerId)",
    }),
  );

  log.info("writer.created", { writerId, email: newWriter.email });
  return newWriter;
}

/**
 * Crée ou connecte un rédacteur et génère le token de session JWT.
 */
export async function createSession(name: string, email: string): Promise<SessionResult> {
  const writer = await upsertWriter(name, email);
  const payload: SessionPayload = {
    writerId: writer.writerId,
    name: writer.name,
    email: writer.email,
  };

  const token = await createSessionJwt(payload);
  const credit = await getWriterQuota(writer.writerId);

  return {
    writer: {
      id: writer.writerId,
      name: writer.name,
      email: writer.email,
    },
    writerId: writer.writerId,
    credit,
    blockedUntil: writer.blockedUntil,
    token,
  };
}

export interface RequestLike {
  cookies?: { get: (name: string) => { value?: string } | undefined };
  headers?: { get: (name: string) => string | null };
}

/**
 * Extrait et valide la session depuis la chaîne de cookies, le token brut ou un objet NextRequest.
 */
export async function authenticateSession(reqOrToken?: RequestLike | string | null): Promise<SessionResult | null> {
  let token: string | null | undefined = null;
  if (typeof reqOrToken === "string") {
    token = reqOrToken;
  } else if (reqOrToken && typeof reqOrToken === "object") {
    token = reqOrToken.cookies?.get("sid")?.value;
    if (!token && reqOrToken.headers) {
      const auth = reqOrToken.headers.get("authorization");
      if (auth?.startsWith("Bearer ")) {
        token = auth.slice(7).trim();
      }
    }
  }

  if (!token) return null;

  const payload = await verifySessionJwt(token);
  if (!payload) return null;

  const writer = await getWriter(payload.writerId);
  if (!writer) return null;

  const credit = await getWriterQuota(writer.writerId);

  return {
    writer: {
      id: writer.writerId,
      name: writer.name,
      email: writer.email,
    },
    writerId: writer.writerId,
    credit,
    blockedUntil: writer.blockedUntil,
  };
}

export function getCookieOptions() {
  const config = getConfig();
  const isProd = config.APP_ENV === "aws";
  return {
    name: "sid",
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 12 * 60 * 60, // 12 heures
  };
}
