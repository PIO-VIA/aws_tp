# ------------------------------------------------------------------------------
# Déploiement des 5 Fonctions Lambda (Node.js 22.x, arm64)
# ------------------------------------------------------------------------------

locals {
  lambda_runtime       = "nodejs22.x"
  lambda_architectures = ["arm64"]

  lambda_common_env = {
    APP_ENV         = "aws"
    TABLE_PREFIX    = "${local.name_prefix}-"
    S3_BUCKET       = aws_s3_bucket.data.id
    PDF_QUEUE_URL   = aws_sqs_queue.pdf_jobs.url
    PDF_DLQ_URL     = aws_sqs_queue.pdf_jobs_dlq.url
    MAIL_FROM       = var.ses_sender
    MAIL_DRIVER     = "ses"
    PRESIGN_TTL_SEC = tostring(var.pdf_presign_ttl_sec)
    LOG_LEVEL       = "info"
  }
}

# 1. Lambda download-api (Function URL)
resource "aws_lambda_function" "download_api" {
  function_name = "${local.name_prefix}-download-api"
  role          = aws_iam_role.download_api.arn
  handler       = "index.handler"
  runtime       = local.lambda_runtime
  architectures = local.lambda_architectures
  timeout       = 10
  memory_size   = 512

  filename         = "${path.module}/../../dist/lambdas/download-api.zip"
  source_code_hash = fileexists("${path.module}/../../dist/lambdas/download-api.zip") ? filebase64sha256("${path.module}/../../dist/lambdas/download-api.zip") : null

  reserved_concurrent_executions = var.lambda_reserved_concurrency

  environment {
    variables = local.lambda_common_env
  }

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash
    ]
  }
}

resource "aws_lambda_function_url" "download_api" {
  function_name      = aws_lambda_function.download_api.function_name
  authorization_type = "NONE"

  cors {
    allow_credentials = false
    allow_origins     = ["*"]
    allow_methods     = ["GET", "POST"]
    allow_headers     = ["content-type"]
    max_age           = 300
  }
}

# 2. Lambda pdf-worker (SQS, lot 1, concurrence max 5, timeout 60s, mémoire 1024)
resource "aws_lambda_function" "pdf_worker" {
  function_name = "${local.name_prefix}-pdf-worker"
  role          = aws_iam_role.pdf_worker.arn
  handler       = "index.handler"
  runtime       = local.lambda_runtime
  architectures = local.lambda_architectures
  timeout       = 60
  memory_size   = 1024

  filename         = "${path.module}/../../dist/lambdas/pdf-worker.zip"
  source_code_hash = fileexists("${path.module}/../../dist/lambdas/pdf-worker.zip") ? filebase64sha256("${path.module}/../../dist/lambdas/pdf-worker.zip") : null

  reserved_concurrent_executions = var.lambda_reserved_concurrency

  environment {
    variables = local.lambda_common_env
  }

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash
    ]
  }
}

resource "aws_lambda_event_source_mapping" "pdf_worker" {
  event_source_arn = aws_sqs_queue.pdf_jobs.arn
  function_name    = aws_lambda_function.pdf_worker.arn
  batch_size       = 1

  scaling_config {
    maximum_concurrency = 5
  }
}

# 3. Lambda pdf-dlq-handler (Remboursement sur échec DLQ)
resource "aws_lambda_function" "pdf_dlq_handler" {
  function_name = "${local.name_prefix}-pdf-dlq-handler"
  role          = aws_iam_role.pdf_dlq_handler.arn
  handler       = "index.handler"
  runtime       = local.lambda_runtime
  architectures = local.lambda_architectures
  timeout       = 30
  memory_size   = 512

  filename         = "${path.module}/../../dist/lambdas/pdf-dlq-handler.zip"
  source_code_hash = fileexists("${path.module}/../../dist/lambdas/pdf-dlq-handler.zip") ? filebase64sha256("${path.module}/../../dist/lambdas/pdf-dlq-handler.zip") : null

  reserved_concurrent_executions = var.lambda_reserved_concurrency

  environment {
    variables = local.lambda_common_env
  }

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash
    ]
  }
}

resource "aws_lambda_event_source_mapping" "pdf_dlq_handler" {
  event_source_arn = aws_sqs_queue.pdf_jobs_dlq.arn
  function_name    = aws_lambda_function.pdf_dlq_handler.arn
  batch_size       = 10
}

# 4. Lambda notifier (DynamoDB Streams sur table links)
resource "aws_lambda_function" "notifier" {
  function_name = "${local.name_prefix}-notifier"
  role          = aws_iam_role.notifier.arn
  handler       = "index.handler"
  runtime       = local.lambda_runtime
  architectures = local.lambda_architectures
  timeout       = 30
  memory_size   = 512

  filename         = "${path.module}/../../dist/lambdas/notifier.zip"
  source_code_hash = fileexists("${path.module}/../../dist/lambdas/notifier.zip") ? filebase64sha256("${path.module}/../../dist/lambdas/notifier.zip") : null

  reserved_concurrent_executions = var.lambda_reserved_concurrency

  environment {
    variables = local.lambda_common_env
  }

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash
    ]
  }
}

resource "aws_lambda_event_source_mapping" "notifier" {
  event_source_arn               = aws_dynamodb_table.links.stream_arn
  function_name                  = aws_lambda_function.notifier.arn
  starting_position              = "LATEST"
  batch_size                     = 10
  maximum_retry_attempts         = 3
  bisect_batch_on_function_error = true
}

# 5. Lambda reconciler (EventBridge rate(5 minutes))
resource "aws_lambda_function" "reconciler" {
  function_name = "${local.name_prefix}-reconciler"
  role          = aws_iam_role.reconciler.arn
  handler       = "index.handler"
  runtime       = local.lambda_runtime
  architectures = local.lambda_architectures
  timeout       = 60
  memory_size   = 512

  filename         = "${path.module}/../../dist/lambdas/reconciler.zip"
  source_code_hash = fileexists("${path.module}/../../dist/lambdas/reconciler.zip") ? filebase64sha256("${path.module}/../../dist/lambdas/reconciler.zip") : null

  reserved_concurrent_executions = var.lambda_reserved_concurrency

  environment {
    variables = local.lambda_common_env
  }

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash
    ]
  }
}

resource "aws_cloudwatch_event_rule" "reconciler_schedule" {
  name                = "${local.name_prefix}-reconciler-schedule"
  description         = "Déclenchement du réconciliateur toutes les 5 minutes"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "reconciler" {
  rule      = aws_cloudwatch_event_rule.reconciler_schedule.name
  target_id = "reconciler-lambda"
  arn       = aws_lambda_function.reconciler.arn
}

resource "aws_lambda_permission" "allow_eventbridge_reconciler" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.reconciler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.reconciler_schedule.arn
}
