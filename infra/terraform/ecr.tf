# ------------------------------------------------------------------------------
# Dépôts Amazon ECR pour les conteneurs App et Collab
# ------------------------------------------------------------------------------

# 1. Dépôt ECR pour l'application Next.js
resource "aws_ecr_repository" "app" {
  name                 = "${local.name_prefix}-app"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# 2. Dépôt ECR pour le serveur de collaboration Hocuspocus
resource "aws_ecr_repository" "collab" {
  name                 = "${local.name_prefix}-collab"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Politique de cycle de vie : conservation des 10 dernières images
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Conserver les 10 dernieres images pour maitriser les couts de stockage"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

resource "aws_ecr_lifecycle_policy" "collab" {
  repository = aws_ecr_repository.collab.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Conserver les 10 dernieres images pour maitriser les couts de stockage"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}
