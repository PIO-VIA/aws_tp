resource "random_id" "bucket_suffix" {
  byte_length = 4
}

# Bucket de données principal
resource "aws_s3_bucket" "data" {
  bucket        = "${local.name_prefix}-data-${random_id.bucket_suffix.hex}"
  force_destroy = var.data_bucket_force_destroy
}

# Blocage strict de tout accès public
resource "aws_s3_bucket_public_access_block" "data" {
  bucket = aws_s3_bucket.data.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Chiffrement côté serveur SSE-S3
resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Règle de cycle de vie : abandon des uploads multipart incomplets (pas de versioning)
resource "aws_s3_bucket_lifecycle_configuration" "data" {
  bucket = aws_s3_bucket.data.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# Politique de sécurité : Refus strict de toute connexion non chiffrée par TLS
resource "aws_s3_bucket_policy" "deny_non_tls" {
  bucket = aws_s3_bucket.data.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnforceTLSRequestsOnly"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.data.arn,
          "${aws_s3_bucket.data.arn}/*"
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })
}

# Préfixes du projet
resource "aws_s3_object" "prefix_snapshots" {
  bucket = aws_s3_bucket.data.id
  key    = "snapshots/"
}

resource "aws_s3_object" "prefix_texts" {
  bucket = aws_s3_bucket.data.id
  key    = "texts/"
}

resource "aws_s3_object" "prefix_pdfs" {
  bucket = aws_s3_bucket.data.id
  key    = "pdfs/"
}
