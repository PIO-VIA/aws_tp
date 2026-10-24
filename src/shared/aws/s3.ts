import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getConfig } from "../config";
import { log } from "../log";

let s3ClientInstance: S3Client | null = null;
let s3PublicClientInstance: S3Client | null = null;

export function getS3Client(): S3Client {
  if (s3ClientInstance) return s3ClientInstance;
  const config = getConfig();
  s3ClientInstance = new S3Client({
    region: config.AWS_REGION,
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials:
      config.APP_ENV === "local"
        ? { accessKeyId: "local", secretAccessKey: "localpassword" }
        : undefined,
  });
  return s3ClientInstance;
}

/**
 * Client utilisé pour générer les URL pré-signées.
 * En local, s'assure que l'hôte de l'URL est accessible par le navigateur (ex: localhost:9000).
 */
export function getS3PublicClient(): S3Client {
  if (s3PublicClientInstance) return s3PublicClientInstance;
  const config = getConfig();
  const endpoint = config.S3_PUBLIC_ENDPOINT || config.S3_ENDPOINT;
  s3PublicClientInstance = new S3Client({
    region: config.AWS_REGION,
    endpoint,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials:
      config.APP_ENV === "local"
        ? { accessKeyId: "local", secretAccessKey: "localpassword" }
        : undefined,
  });
  return s3PublicClientInstance;
}

export function resetS3Clients(): void {
  s3ClientInstance = null;
  s3PublicClientInstance = null;
}

/**
 * Écrit un objet dans S3 avec condition "n'existe pas" (If-None-Match: *).
 * Si l'objet existe déjà (erreur 412 ou PreconditionFailed), retourne { created: false, alreadyExists: true }.
 */
export async function putObjectIfNotExist(
  key: string,
  body: Uint8Array | Buffer | string,
  contentType?: string,
): Promise<{ created: boolean; alreadyExists: boolean }> {
  const config = getConfig();
  const client = getS3Client();

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: key,
        Body: typeof body === "string" ? Buffer.from(body, "utf-8") : body,
        ContentType: contentType,
        IfNoneMatch: "*",
      }),
    );
    return { created: true, alreadyExists: false };
  } catch (err: unknown) {
    const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      error.name === "PreconditionFailed" ||
      error.$metadata?.httpStatusCode === 412 ||
      error.$metadata?.httpStatusCode === 409
    ) {
      log.debug("s3.put.already_exists", { key });
      return { created: false, alreadyExists: true };
    }
    throw err;
  }
}

/**
 * Écrit ou écrase un objet dans S3 sans condition (pour les snapshots Yjs par exemple).
 */
export async function putObject(
  key: string,
  body: Uint8Array | Buffer | string,
  contentType?: string,
): Promise<void> {
  const config = getConfig();
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: typeof body === "string" ? Buffer.from(body, "utf-8") : body,
      ContentType: contentType,
    }),
  );
}

/**
 * Vérifie si un objet existe dans S3 via un HEAD.
 */
export async function headObject(key: string): Promise<boolean> {
  const config = getConfig();
  const client = getS3Client();
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: key,
      }),
    );
    return true;
  } catch (err: unknown) {
    const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      error.name === "NotFound" ||
      error.$metadata?.httpStatusCode === 404
    ) {
      return false;
    }
    throw err;
  }
}

/**
 * Télécharge un objet sous forme de Buffer.
 */
export async function getObjectBuffer(key: string): Promise<Buffer | null> {
  const config = getConfig();
  const client = getS3Client();
  try {
    const res = await client.send(
      new GetObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: key,
      }),
    );
    if (!res.Body) return null;
    const byteArray = await res.Body.transformToByteArray();
    return Buffer.from(byteArray);
  } catch (err: unknown) {
    const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      error.name === "NoSuchKey" ||
      error.name === "NotFound" ||
      error.$metadata?.httpStatusCode === 404
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Télécharge un objet texte sous forme de chaîne UTF-8.
 */
export async function getObjectText(key: string): Promise<string | null> {
  const buf = await getObjectBuffer(key);
  return buf ? buf.toString("utf-8") : null;
}

/**
 * Supprime un objet.
 */
export async function deleteObject(key: string): Promise<void> {
  const config = getConfig();
  const client = getS3Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
    }),
  );
}

/**
 * Génère une URL pré-signée GET pour un fichier (par défaut 60s TTL).
 */
export async function getPresignedDownloadUrl(
  key: string,
  filename: string,
  ttlSec?: number,
): Promise<{ url: string; expiresAtEpochSec: number }> {
  const config = getConfig();
  const client = getS3PublicClient();
  const ttl = ttlSec ?? config.PRESIGN_TTL_SEC;

  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${filename}"`,
    ResponseContentType: "application/pdf",
  });

  const url = await getSignedUrl(client, command, { expiresIn: ttl });
  const expiresAtEpochSec = Math.floor(Date.now() / 1000) + ttl;
  return { url, expiresAtEpochSec };
}
