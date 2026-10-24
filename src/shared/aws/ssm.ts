import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { getConfig } from "../config";
import { log } from "../log";

let ssmClientInstance: SSMClient | null = null;
const secretCache = new Map<string, string>();

/**
 * Récupère un secret :
 * - en mode local : lit process.env[name] ou la valeur de fallback
 * - en mode aws : lit SSM Parameter Store sous `${SSM_PREFIX}${name}` avec cache mémoire
 */
export async function getSecret(name: string): Promise<string> {
  const config = getConfig();

  if (config.APP_ENV === "local") {
    const val = process.env[name];
    if (val) return val;
    // Si c'est dans config directement
    if (name === "SESSION_SECRET" && config.SESSION_SECRET) return config.SESSION_SECRET;
    if (name === "INTERNAL_TOKEN" && config.INTERNAL_TOKEN) return config.INTERNAL_TOKEN;
    if (name === "ADMIN_TOKEN" && config.ADMIN_TOKEN) return config.ADMIN_TOKEN;
    throw new Error(`Secret local manquant: ${name}`);
  }

  if (secretCache.has(name)) {
    return secretCache.get(name)!;
  }

  if (!ssmClientInstance) {
    ssmClientInstance = new SSMClient({ region: config.AWS_REGION });
  }

  const ssmName = `${config.SSM_PREFIX}${name}`;
  try {
    const res = await ssmClientInstance.send(
      new GetParameterCommand({
        Name: ssmName,
        WithDecryption: true,
      }),
    );
    const value = res.Parameter?.Value;
    if (!value) {
      throw new Error(`Paramètre SSM vide : ${ssmName}`);
    }
    secretCache.set(name, value);
    return value;
  } catch (err) {
    log.error("ssm.get_secret_failed", { name, ssmName, error: err });
    throw err;
  }
}

export function resetSSMCache(): void {
  secretCache.clear();
  ssmClientInstance = null;
}
