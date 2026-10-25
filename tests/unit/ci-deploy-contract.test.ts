import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("C-11 : Vérification du contrat CI et Déploiement", () => {
  const rootDir = path.join(__dirname, "..", "..");
  const ciPath = path.join(rootDir, ".github", "workflows", "ci.yml");
  const deployPath = path.join(rootDir, ".github", "workflows", "deploy.yml");
  const scriptsDeployDir = path.join(rootDir, "scripts", "deploy");
  const smokePath = path.join(rootDir, "scripts", "smoke.ts");

  it("V1. ci.yml intègre Checkov sur infra/terraform et toutes les suites de tests", () => {
    const ciContent = fs.readFileSync(ciPath, "utf-8");
    expect(ciContent).toContain("bridgecrewio/checkov-action");
    expect(ciContent).toContain("infra/terraform");
    expect(ciContent).toContain("npm run lint");
    expect(ciContent).toContain("npm run typecheck");
    expect(ciContent).toContain("npm run test");
    expect(ciContent).toContain("npm run test:integration");
    expect(ciContent).toContain("npm run test:scenarios");
  });

  it("V2. deploy.yml est conditionné au succès de la CI et définit la concurrence", () => {
    const deployContent = fs.readFileSync(deployPath, "utf-8");
    expect(deployContent).toContain("concurrency:");
    expect(deployContent).toContain("group: deploy");
    expect(deployContent).toContain("cancel-in-progress: false");

    // Conditionné au workflow CI ou gating strict
    const isGuardedByCI =
      deployContent.includes("workflow_run:") &&
      deployContent.includes("CI Pipeline") &&
      deployContent.includes("conclusion == 'success'");
    expect(isGuardedByCI, "deploy.yml doit être conditionné au succès de CI Pipeline").toBe(true);
  });

  it("V3. deploy.yml utilise vars.* pour les identifiants non-secrets et ne contient aucune clé AWS", () => {
    const deployContent = fs.readFileSync(deployPath, "utf-8");

    // Identifiants non-secrets doivent utiliser vars.*
    expect(deployContent).toContain("vars.AWS_DEPLOY_ROLE_ARN");
    expect(deployContent).toContain("vars.CLOUDFRONT_URL");
    expect(deployContent).toContain("vars.EC2_INSTANCE_ID");
    expect(deployContent).toContain("vars.PROJECT_PREFIX");

    // Ne doit pas utiliser secrets.* pour ces identifiants
    expect(deployContent).not.toContain("secrets.AWS_DEPLOY_ROLE_ARN");
    expect(deployContent).not.toContain("secrets.CLOUDFRONT_URL");
    expect(deployContent).not.toContain("secrets.EC2_INSTANCE_ID");
    expect(deployContent).not.toContain("secrets.PROJECT_PREFIX");

    // Aucune clé secrète AWS dans le workflow
    expect(deployContent).not.toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("V4. Le smoke test et deploy.yml affichent la commande de retour arrière en cas d'échec", () => {
    const deployContent = fs.readFileSync(deployPath, "utf-8");
    const smokeContent = fs.readFileSync(smokePath, "utf-8");

    expect(deployContent).toContain("rollback-ec2.sh");
    expect(smokeContent).toContain("rollback-ec2.sh");
  });

  it("V5. Tous les scripts de déploiement utilisent set -euo pipefail et affichent leur usage", () => {
    const scripts = fs.readdirSync(scriptsDeployDir).filter((f) => f.endsWith(".sh"));
    expect(scripts.length).toBeGreaterThanOrEqual(3);

    for (const script of scripts) {
      const scriptContent = fs.readFileSync(path.join(scriptsDeployDir, script), "utf-8");
      expect(
        scriptContent,
        `${script} doit comporter 'set -euo pipefail'`,
      ).toContain("set -euo pipefail");
      expect(
        scriptContent,
        `${script} doit afficher son usage en cas d'arguments manquants`,
      ).toContain("Usage:");
    }
  });
});
