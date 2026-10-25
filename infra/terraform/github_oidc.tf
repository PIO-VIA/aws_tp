# ------------------------------------------------------------------------------
# Fédération d'Identité OpenID Connect (OIDC) pour GitHub Actions
# Conditionné par la variable enable_github_oidc (défaut false)
# ------------------------------------------------------------------------------

# Fournisseur OIDC GitHub Actions
resource "aws_iam_openid_connect_provider" "github" {
  count           = var.enable_github_oidc ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1", "1c58761f274dd7c08954ee1ad3c3cfae977fb839"]
}

# 1. Rôle de déploiement CI/CD (branche main / environnements)
resource "aws_iam_role" "github_deploy" {
  count                = var.enable_github_oidc ? 1 : 0
  name                 = "${local.name_prefix}-github-deploy-role"
  permissions_boundary = var.permissions_boundary_arn

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github[0].arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
            "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:environment:${var.github_environment}"
          }
        }
      }
    ]
  })
}

resource "aws_iam_policy" "github_deploy" {
  count = var.enable_github_oidc ? 1 : 0
  name  = "${local.name_prefix}-github-deploy-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # ecr:GetAuthorizationToken ne supporte pas de ressource specifique selon la documentation IAM AWS (Resource = "*")
        Sid    = "ECRAuth"
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken"
        ]
        Resource = "*"
      },
      {
        Sid    = "ECRPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload"
        ]
        Resource = [
          aws_ecr_repository.app.arn,
          aws_ecr_repository.collab.arn
        ]
      },
      {
        Sid    = "SSMDeployCommand"
        Effect = "Allow"
        Action = [
          "ssm:SendCommand",
          "ssm:GetCommandInvocation"
        ]
        Resource = [
          "arn:aws:ec2:${local.region}:${local.account_id}:instance/${aws_instance.server.id}",
          "arn:aws:ssm:${local.region}::document/AWS-RunShellScript"
        ]
      },
      {
        Sid    = "LambdaCodeUpdate"
        Effect = "Allow"
        Action = [
          "lambda:UpdateFunctionCode",
          "lambda:GetFunction"
        ]
        Resource = "arn:aws:lambda:${local.region}:${local.account_id}:function:${local.name_prefix}-*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "github_deploy" {
  count      = var.enable_github_oidc ? 1 : 0
  role       = aws_iam_role.github_deploy[0].name
  policy_arn = aws_iam_policy.github_deploy[0].arn
}

# 2. Rôle en lecture seule pour 'terraform plan' (PRs)
resource "aws_iam_role" "github_plan" {
  count                = var.enable_github_oidc ? 1 : 0
  name                 = "${local.name_prefix}-github-plan-role"
  permissions_boundary = var.permissions_boundary_arn

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github[0].arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:pull_request"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "github_plan_readonly" {
  count      = var.enable_github_oidc ? 1 : 0
  role       = aws_iam_role.github_plan[0].name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}
