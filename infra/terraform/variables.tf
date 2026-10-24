variable "aws_region" {
  type        = string
  description = "Région AWS de déploiement"
  default     = "eu-west-3"
}

variable "project" {
  type        = string
  description = "Nom du projet utilisé pour le préfixage et le tagging"
  default     = "editeur-collab"
}

variable "environment" {
  type        = string
  description = "Environnement de déploiement (dev, staging, prod)"
  default     = "dev"
}

variable "alert_email" {
  type        = string
  description = "Adresse e-mail de réception des alertes CloudWatch et Budgets"
}

variable "ses_sender" {
  type        = string
  description = "Adresse e-mail expéditrice SES pour les notifications"
}

variable "ses_recipients" {
  type        = list(string)
  description = "Liste des adresses e-mail autorisées à recevoir les e-mails SES (sandbox)"
  default     = []
}

variable "ec2_instance_type" {
  type        = string
  description = "Type d'instance EC2 pour le serveur de collaboration et Next.js"
  default     = "t3.small"
}

variable "download_origin" {
  type        = string
  description = "Origine CloudFront pour /api/dl/* : lambda ou ec2"
  default     = "lambda"

  validation {
    condition     = contains(["lambda", "ec2"], var.download_origin)
    error_message = "download_origin doit valoir 'lambda' ou 'ec2'."
  }
}

variable "lambda_reserved_concurrency" {
  type        = number
  description = "Concurrence réservée pour les fonctions Lambda (null = illimité/défaut)"
  default     = null
}

variable "monthly_budget_usd" {
  type        = number
  description = "Budget mensuel alloué en USD pour les alertes AWS Budgets"
  default     = 10
}

variable "github_repo" {
  type        = string
  description = "Référentiel GitHub au format 'owner/repo' pour la fédération OIDC"
  default     = "editeur/collaboratif"
}

variable "enable_github_oidc" {
  type        = bool
  description = "Active la création du fournisseur OIDC GitHub Actions et des rôles IAM associés"
  default     = false
}

variable "data_bucket_force_destroy" {
  type        = bool
  description = "Autorise la suppression forcée du bucket S3 lors du terraform destroy"
  default     = true
}

variable "pdf_presign_ttl_sec" {
  type        = number
  description = "Durée de validité des URL pré-signées S3 de téléchargement de PDF en secondes"
  default     = 60
}
