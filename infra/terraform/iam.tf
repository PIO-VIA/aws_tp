# ------------------------------------------------------------------------------
# Rôles IAM Moindre Privilège pour chaque Lambda et l'Instance EC2
# ------------------------------------------------------------------------------

# AssumeRole Policy Lambda
data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# 1. Rôle download-api
resource "aws_iam_role" "download_api" {
  name               = "${local.name_prefix}-lambda-download-api-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_policy" "download_api" {
  name = "${local.name_prefix}-lambda-download-api-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.name_prefix}-*"
      },
      {
        Sid    = "DynamoDBAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
          "dynamodb:TransactWriteItems"
        ]
        Resource = [
          aws_dynamodb_table.links.arn,
          aws_dynamodb_table.reservations.arn,
          "${aws_dynamodb_table.reservations.arn}/index/*",
          aws_dynamodb_table.pdf_jobs.arn,
          aws_dynamodb_table.doc_heads.arn
        ]
      },
      {
        Sid    = "S3PresignAccess"
        Effect = "Allow"
        Action = [
          "s3:GetObject"
        ]
        Resource = "${aws_s3_bucket.data.arn}/pdfs/*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "download_api" {
  role       = aws_iam_role.download_api.name
  policy_arn = aws_iam_policy.download_api.arn
}

# 2. Rôle pdf-worker
resource "aws_iam_role" "pdf_worker" {
  name               = "${local.name_prefix}-lambda-pdf-worker-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_policy" "pdf_worker" {
  name = "${local.name_prefix}-lambda-pdf-worker-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.name_prefix}-*"
      },
      {
        Sid    = "SQSConsume"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.pdf_jobs.arn
      },
      {
        Sid    = "DynamoDBStatus"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem"
        ]
        Resource = [
          aws_dynamodb_table.pdf_jobs.arn,
          aws_dynamodb_table.reservations.arn
        ]
      },
      {
        Sid    = "S3ReadWrite"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject"
        ]
        Resource = [
          "${aws_s3_bucket.data.arn}/texts/*",
          "${aws_s3_bucket.data.arn}/pdfs/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "pdf_worker" {
  role       = aws_iam_role.pdf_worker.name
  policy_arn = aws_iam_policy.pdf_worker.arn
}

# 3. Rôle pdf-dlq-handler
resource "aws_iam_role" "pdf_dlq_handler" {
  name               = "${local.name_prefix}-lambda-pdf-dlq-handler-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_policy" "pdf_dlq_handler" {
  name = "${local.name_prefix}-lambda-pdf-dlq-handler-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.name_prefix}-*"
      },
      {
        Sid    = "SQSConsumeDLQ"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.pdf_jobs_dlq.arn
      },
      {
        Sid    = "DynamoDBRefund"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
          "dynamodb:TransactWriteItems"
        ]
        Resource = [
          aws_dynamodb_table.pdf_jobs.arn,
          aws_dynamodb_table.reservations.arn,
          aws_dynamodb_table.links.arn
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "pdf_dlq_handler" {
  role       = aws_iam_role.pdf_dlq_handler.name
  policy_arn = aws_iam_policy.pdf_dlq_handler.arn
}

# 4. Rôle notifier
resource "aws_iam_role" "notifier" {
  name               = "${local.name_prefix}-lambda-notifier-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_policy" "notifier" {
  name = "${local.name_prefix}-lambda-notifier-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.name_prefix}-*"
      },
      {
        Sid    = "DynamoDBStreamRead"
        Effect = "Allow"
        Action = [
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:DescribeStream",
          "dynamodb:ListStreams"
        ]
        Resource = aws_dynamodb_table.links.stream_arn
      },
      {
        Sid    = "DynamoDBNotificationState"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query"
        ]
        Resource = [
          aws_dynamodb_table.notifications.arn,
          "${aws_dynamodb_table.notifications.arn}/index/*",
          aws_dynamodb_table.documents.arn,
          aws_dynamodb_table.writers.arn
        ]
      },
      {
        Sid    = "SESSendEmail"
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "notifier" {
  role       = aws_iam_role.notifier.name
  policy_arn = aws_iam_policy.notifier.arn
}

# 5. Rôle reconciler
resource "aws_iam_role" "reconciler" {
  name               = "${local.name_prefix}-lambda-reconciler-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_policy" "reconciler" {
  name = "${local.name_prefix}-lambda-reconciler-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.name_prefix}-*"
      },
      {
        Sid    = "ReconcileDynamoDB"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ]
        Resource = [
          aws_dynamodb_table.notifications.arn,
          "${aws_dynamodb_table.notifications.arn}/index/*",
          aws_dynamodb_table.pdf_jobs.arn,
          aws_dynamodb_table.reservations.arn,
          aws_dynamodb_table.links.arn,
          aws_dynamodb_table.documents.arn,
          aws_dynamodb_table.writers.arn
        ]
      },
      {
        Sid    = "SQSSendJob"
        Effect = "Allow"
        Action = [
          "sqs:SendMessage"
        ]
        Resource = aws_sqs_queue.pdf_jobs.arn
      },
      {
        Sid    = "SESSendEmail"
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "reconciler" {
  role       = aws_iam_role.reconciler.name
  policy_arn = aws_iam_policy.reconciler.arn
}

# 6. Rôle et Profil d'Instance EC2
resource "aws_iam_role" "ec2" {
  name = "${local.name_prefix}-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

# Attachement politique gérée AWS pour AWS Systems Manager (SSM)
resource "aws_iam_role_policy_attachment" "ec2_ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Politique spécifique EC2 (DynamoDB, S3, SSM, ECR, SQS, CloudWatch)
resource "aws_iam_policy" "ec2_app" {
  name = "${local.name_prefix}-ec2-app-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ECRPull"
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage"
        ]
        Resource = "*"
      },
      {
        Sid    = "DynamoDBTables"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:TransactWriteItems"
        ]
        Resource = "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${local.name_prefix}-*"
      },
      {
        Sid    = "S3DataBucket"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.data.arn,
          "${aws_s3_bucket.data.arn}/*"
        ]
      },
      {
        Sid    = "SSMParametersRead"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath"
        ]
        Resource = "arn:aws:ssm:${local.region}:${local.account_id}:parameter/${var.project}/${var.environment}/*"
      },
      {
        Sid    = "SQSSendPdfJobs"
        Effect = "Allow"
        Action = [
          "sqs:SendMessage"
        ]
        Resource = aws_sqs_queue.pdf_jobs.arn
      },
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/opt/app/*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ec2_app" {
  role       = aws_iam_role.ec2.name
  policy_arn = aws_iam_policy.ec2_app.arn
}

resource "aws_iam_instance_profile" "ec2" {
  name = "${local.name_prefix}-ec2-instance-profile"
  role = aws_iam_role.ec2.name
}
