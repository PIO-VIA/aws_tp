import { SignJWT, jwtVerify } from "jose";
import { createHash, timingSafeEqual } from "crypto";
import { getSecret } from "../aws/ssm";

export interface SessionPayload {
  writerId: string;
  name: string;
  email: string;
}

export interface CollabTokenPayload {
  writerId: string;
  docId: string;
}

export function hashEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  return createHash("sha256").update(normalized, "utf-8").digest("hex");
}

/**
 * Comparaison de deux chaînes à temps constant pour éviter les attaques temporelles sur les tokens secrets (ADMIN_TOKEN, INTERNAL_TOKEN).
 */
export function timingSafeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

let secretKeyCache: Uint8Array | null = null;

async function getJwtKey(): Promise<Uint8Array> {
  if (secretKeyCache) return secretKeyCache;
  const rawSecret = await getSecret("SESSION_SECRET");
  secretKeyCache = new TextEncoder().encode(rawSecret);
  return secretKeyCache;
}

export function resetJwtKeyCache(): void {
  secretKeyCache = null;
}

/**
 * Crée un JWT de session signé HS256 valide 12 heures (Section 6.1).
 */
export async function createSessionJwt(payload: SessionPayload): Promise<string> {
  const key = await getJwtKey();
  return new SignJWT({
    writerId: payload.writerId,
    name: payload.name,
    email: payload.email,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(key);
}

/**
 * Vérifie un JWT de session. Retourne le payload ou null si invalide/expiré.
 */
export async function verifySessionJwt(token: string): Promise<SessionPayload | null> {
  try {
    const key = await getJwtKey();
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (
      typeof payload.writerId === "string" &&
      typeof payload.name === "string" &&
      typeof payload.email === "string"
    ) {
      return {
        writerId: payload.writerId,
        name: payload.name,
        email: payload.email,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Crée un collab-token JWT de courte durée (5 minutes) pour la connexion WebSocket Hocuspocus.
 */
export async function createCollabToken(payload: CollabTokenPayload): Promise<string> {
  const key = await getJwtKey();
  return new SignJWT({
    writerId: payload.writerId,
    docId: payload.docId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

/**
 * Vérifie un collab-token.
 */
export async function verifyCollabToken(token: string): Promise<CollabTokenPayload | null> {
  try {
    const key = await getJwtKey();
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (typeof payload.writerId === "string" && typeof payload.docId === "string") {
      return {
        writerId: payload.writerId,
        docId: payload.docId,
      };
    }
    return null;
  } catch {
    return null;
  }
}
