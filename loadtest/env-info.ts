import os from "os";

export interface EnvInfo {
  nodeVersion: string;
  osPlatform: string;
  osRelease: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryMb: number;
  mode: "production" | "development";
}

export function getEnvInfo(): EnvInfo {
  const cpus = os.cpus();
  return {
    nodeVersion: process.version,
    osPlatform: os.platform(),
    osRelease: os.release(),
    cpuModel: cpus[0]?.model || "unknown",
    cpuCores: cpus.length,
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    mode: process.env.NODE_ENV === "production" ? "production" : "development",
  };
}
