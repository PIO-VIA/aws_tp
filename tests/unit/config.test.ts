import { describe, it, expect, beforeEach } from "vitest";
import { configSchema, resetConfig, tableName } from "@shared/config";

describe("Configuration & Socle (Phase 0)", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("valide la configuration locale minimale avec valeurs par défaut", () => {
    const validEnv = {
      APP_ENV: "local",
      DDB_ENDPOINT: "http://localhost:8000",
      S3_ENDPOINT: "http://localhost:9000",
      S3_BUCKET: "test-bucket",
      SQS_ENDPOINT: "http://localhost:9324",
      PDF_QUEUE_URL: "http://localhost:9324/000000000000/pdf-jobs",
    };

    const parsed = configSchema.safeParse(validEnv);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.DAILY_CREDIT).toBe(10000);
      expect(parsed.data.PRESIGN_TTL_SEC).toBe(60);
      expect(parsed.data.TABLE_PREFIX).toBe("editeur-local-");
    }
  });

  it("rejette la configuration si S3_BUCKET est manquant", () => {
    const invalidEnv = {
      APP_ENV: "local",
      DDB_ENDPOINT: "http://localhost:8000",
      S3_ENDPOINT: "http://localhost:9000",
      SQS_ENDPOINT: "http://localhost:9324",
      PDF_QUEUE_URL: "http://localhost:9324/000000000000/pdf-jobs",
    };

    const parsed = configSchema.safeParse(invalidEnv);
    expect(parsed.success).toBe(false);
  });

  it("rejette la configuration si les endpoints locaux sont absents en mode local", () => {
    const invalidEnv = {
      APP_ENV: "local",
      S3_BUCKET: "test-bucket",
      PDF_QUEUE_URL: "http://localhost:9324/000000000000/pdf-jobs",
    };

    const parsed = configSchema.safeParse(invalidEnv);
    expect(parsed.success).toBe(false);
  });

  it("calcule correctement le nom des tables DynamoDB préfixées", () => {
    process.env.TABLE_PREFIX = "test-prefix-";
    process.env.S3_BUCKET = "test-bucket";
    process.env.DDB_ENDPOINT = "http://localhost:8000";
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.SQS_ENDPOINT = "http://localhost:9324";
    process.env.PDF_QUEUE_URL = "http://localhost:9324/000000000000/pdf-jobs";

    expect(tableName("links")).toBe("test-prefix-links");
    expect(tableName("writers")).toBe("test-prefix-writers");
  });
});
