# ------------------------------------------------------------------------------
# File de traitement asynchrone des rendus PDF et file DLQ associée
# ------------------------------------------------------------------------------

# File DLQ des jobs PDF échoués
resource "aws_sqs_queue" "pdf_jobs_dlq" {
  name                      = "${local.name_prefix}-pdf-jobs-dlq"
  message_retention_seconds = 1209600 # 14 jours
}

# File principale de travail PDF
resource "aws_sqs_queue" "pdf_jobs" {
  name                       = "${local.name_prefix}-pdf-jobs"
  visibility_timeout_seconds = 360 # 6 x timeout worker (60s * 6 = 360s)
  message_retention_seconds  = 86400

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.pdf_jobs_dlq.arn
    maxReceiveCount     = 3
  })
}
