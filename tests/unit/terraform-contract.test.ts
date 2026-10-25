import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("C-10 : Vérification du contrat de durcissement et nommage Terraform", () => {
  const tfDir = path.join(__dirname, "..", "..", "infra", "terraform");
  const tfFiles = fs.readdirSync(tfDir).filter((f) => f.endsWith(".tf"));

  it("V1. Chaque aws_iam_role définit obligatoirement permissions_boundary", () => {
    const rolesMissingBoundary: string[] = [];

    function extractResourceBlocks(content: string, resourceType: string): Array<{ name: string; body: string }> {
      const prefix = `resource "${resourceType}"`;
      const blocks: Array<{ name: string; body: string }> = [];
      let idx = 0;
      while ((idx = content.indexOf(prefix, idx)) !== -1) {
        const openBrace = content.indexOf("{", idx);
        if (openBrace === -1) break;
        const header = content.slice(idx, openBrace);
        const nameMatch = header.match(/"([^"]+)"\s*$/);
        const roleName = nameMatch ? nameMatch[1] : "unknown";

        let depth = 1;
        let pos = openBrace + 1;
        while (pos < content.length && depth > 0) {
          if (content[pos] === "{") depth++;
          else if (content[pos] === "}") depth--;
          pos++;
        }
        const body = content.slice(openBrace + 1, pos - 1);
        blocks.push({ name: roleName, body });
        idx = pos;
      }
      return blocks;
    }

    for (const file of tfFiles) {
      const content = fs.readFileSync(path.join(tfDir, file), "utf-8");
      const roles = extractResourceBlocks(content, "aws_iam_role");

      for (const role of roles) {
        if (!role.body.includes("permissions_boundary")) {
          rolesMissingBoundary.push(`${file}:${role.name}`);
        }
      }
    }

    expect(
      rolesMissingBoundary,
      `Rôles IAM sans permissions_boundary: ${rolesMissingBoundary.join(", ")}`,
    ).toEqual([]);
  });

  it("V2. La variable obligatoire permissions_boundary_arn est définie et validée", () => {
    const variablesContent = fs.readFileSync(path.join(tfDir, "variables.tf"), "utf-8");
    expect(variablesContent).toContain('variable "permissions_boundary_arn"');
    expect(variablesContent).toMatch(/regex\("\^arn:aws:iam::/);
  });

  it("V3. L'instance EC2 utilise IMDSv2 obligatoire et hop limit 2", () => {
    const ec2Content = fs.readFileSync(path.join(tfDir, "ec2.tf"), "utf-8");
    expect(ec2Content).toContain('http_tokens                 = "required"');
    expect(ec2Content).toContain("http_put_response_hop_limit = 2");
    expect(ec2Content).toContain('http_endpoint               = "enabled"');
  });

  it("V4. Les politiques IAM restreignent SES, SSM et ECR sans jokers excessifs", () => {
    const iamContent = fs.readFileSync(path.join(tfDir, "iam.tf"), "utf-8");
    const oidcContent = fs.readFileSync(path.join(tfDir, "github_oidc.tf"), "utf-8");

    // SES restreint à l'identité expéditrice
    expect(iamContent).toContain(":identity/${var.ses_sender}");
    expect(iamContent).toContain('"ses:FromAddress" = var.ses_sender');

    // ECR restreint aux dépôts applicatifs
    expect(iamContent).toContain("aws_ecr_repository.app.arn");
    expect(iamContent).toContain("aws_ecr_repository.collab.arn");

    // SSM sans joker de compte
    expect(oidcContent).toContain("::document/AWS-RunShellScript");
  });

  it("V5. Contrat de nommage 10.1 : Bucket, budget, groupes de logs et sorties respectent le format strict", () => {
    const s3Content = fs.readFileSync(path.join(tfDir, "s3.tf"), "utf-8");
    const budgetsContent = fs.readFileSync(path.join(tfDir, "budgets.tf"), "utf-8");
    const monitoringContent = fs.readFileSync(path.join(tfDir, "monitoring.tf"), "utf-8");
    const outputsContent = fs.readFileSync(path.join(tfDir, "outputs.tf"), "utf-8");

    // S3 bucket data: prefix-data-account_id
    expect(s3Content).toContain('bucket        = "${local.name_prefix}-data-${local.account_id}"');

    // Budget: project-monthly ou project-environment-monthly-budget
    expect(budgetsContent).toMatch(/name\s*=\s*"\$\{var\.project\}(?:-\$\{var\.environment\})?-monthly(?:-budget)?"/);

    // Groupes de logs EC2
    expect(monitoringContent).toContain('"/${var.project}/${var.environment}/app"');
    expect(monitoringContent).toContain('"/${var.project}/${var.environment}/collab"');

    // Sorties obligatoires
    expect(outputsContent).toContain('output "ssm_parameter_names"');
    expect(outputsContent).toContain('output "log_group_names"');
  });
});
