# ------------------------------------------------------------------------------
# Tables DynamoDB du projet (Billing mode: PAY_PER_REQUEST)
# ------------------------------------------------------------------------------

# 1. Rédacteurs
resource "aws_dynamodb_table" "writers" {
  name         = "${local.name_prefix}-writers"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "writerId"

  attribute {
    name = "writerId"
    type = "S"
  }

  attribute {
    name = "email"
    type = "S"
  }

  global_secondary_index {
    name            = "by_email"
    hash_key        = "email"
    projection_type = "ALL"
  }
}

# 2. Documents
resource "aws_dynamodb_table" "documents" {
  name         = "${local.name_prefix}-documents"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "docId"

  attribute {
    name = "docId"
    type = "S"
  }

  attribute {
    name = "ownerId"
    type = "S"
  }

  global_secondary_index {
    name            = "by_owner"
    hash_key        = "ownerId"
    projection_type = "ALL"
  }
}

# 3. Permissions documents
resource "aws_dynamodb_table" "doc_permissions" {
  name         = "${local.name_prefix}-doc_permissions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "docId"
  range_key    = "writerId"

  attribute {
    name = "docId"
    type = "S"
  }

  attribute {
    name = "writerId"
    type = "S"
  }

  global_secondary_index {
    name            = "by_writer"
    hash_key        = "writerId"
    range_key       = "docId"
    projection_type = "ALL"
  }
}

# 4. Journal d'updates Yjs (WAL)
resource "aws_dynamodb_table" "doc_updates" {
  name         = "${local.name_prefix}-doc_updates"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "docId"
  range_key    = "clock"

  attribute {
    name = "docId"
    type = "S"
  }

  attribute {
    name = "clock"
    type = "N"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# 5. Snapshots documents
resource "aws_dynamodb_table" "doc_snapshots" {
  name         = "${local.name_prefix}-doc_snapshots"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "docId"
  range_key    = "snapshotId"

  attribute {
    name = "docId"
    type = "S"
  }

  attribute {
    name = "snapshotId"
    type = "S"
  }
}

# 6. Heads de version
resource "aws_dynamodb_table" "doc_heads" {
  name         = "${local.name_prefix}-doc_heads"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "docId"

  attribute {
    name = "docId"
    type = "S"
  }
}

# 7. Quota journalier
resource "aws_dynamodb_table" "quota" {
  name         = "${local.name_prefix}-quota"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "key"

  attribute {
    name = "key"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# 8. Événements d'abus et blocages
resource "aws_dynamodb_table" "abuse_events" {
  name         = "${local.name_prefix}-abuse_events"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "writerId"
  range_key    = "timestamp"

  attribute {
    name = "writerId"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# 9. Liens de téléchargement (avec DynamoDB Stream pour les notifications)
resource "aws_dynamodb_table" "links" {
  name             = "${local.name_prefix}-links"
  billing_mode     = "PAY_PER_REQUEST"
  hash_key         = "linkId"
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "linkId"
    type = "S"
  }

  attribute {
    name = "docId"
    type = "S"
  }

  global_secondary_index {
    name            = "by_doc"
    hash_key        = "docId"
    projection_type = "ALL"
  }
}

# 10. Réservations de téléchargement (C1)
resource "aws_dynamodb_table" "reservations" {
  name         = "${local.name_prefix}-reservations"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "linkId"
  range_key    = "reservationId"

  attribute {
    name = "linkId"
    type = "S"
  }

  attribute {
    name = "reservationId"
    type = "S"
  }

  attribute {
    name = "requestId"
    type = "S"
  }

  global_secondary_index {
    name            = "by_request"
    hash_key        = "linkId"
    range_key       = "requestId"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# 11. Jobs de génération PDF (Single-flight C3)
resource "aws_dynamodb_table" "pdf_jobs" {
  name         = "${local.name_prefix}-pdf_jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "docId"
  range_key    = "versionId"

  attribute {
    name = "docId"
    type = "S"
  }

  attribute {
    name = "versionId"
    type = "S"
  }
}

# 12. Notifications (F05)
resource "aws_dynamodb_table" "notifications" {
  name         = "${local.name_prefix}-notifications"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "notificationId"

  attribute {
    name = "notificationId"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "scheduledAt"
    type = "S"
  }

  global_secondary_index {
    name            = "by_status"
    hash_key        = "status"
    range_key       = "scheduledAt"
    projection_type = "ALL"
  }
}
