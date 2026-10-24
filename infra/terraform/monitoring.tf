# ------------------------------------------------------------------------------
# Monitoring CloudWatch : Log Groups (14 jours), Alarmes, Dashboard et Topic SNS
# ------------------------------------------------------------------------------

# 1. Topic SNS pour les alertes avec abonnement e-mail
resource "aws_sns_topic" "alerts" {
  name = "${local.name_prefix}-alerts"
}

resource "aws_sns_topic_subscription" "alert_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# 2. Groupes de logs CloudWatch (rétention 14 jours)
resource "aws_cloudwatch_log_group" "download_api" {
  name              = "/aws/lambda/${aws_lambda_function.download_api.function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "pdf_worker" {
  name              = "/aws/lambda/${aws_lambda_function.pdf_worker.function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "pdf_dlq_handler" {
  name              = "/aws/lambda/${aws_lambda_function.pdf_dlq_handler.function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "notifier" {
  name              = "/aws/lambda/${aws_lambda_function.notifier.function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "reconciler" {
  name              = "/aws/lambda/${aws_lambda_function.reconciler.function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "ec2_app" {
  name              = "/opt/app/${local.name_prefix}"
  retention_in_days = 14
}

# 3. Alarmes CloudWatch
# Alarme 1 : SQS Âge du message le plus ancien > 120s
resource "aws_cloudwatch_metric_alarm" "sqs_oldest_message_age" {
  alarm_name          = "${local.name_prefix}-sqs-oldest-message-age"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 120
  alarm_description   = "Alerte si un job PDF est bloque dans la file SQS depuis plus de 2 minutes"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    QueueName = aws_sqs_queue.pdf_jobs.name
  }
}

# Alarme 2 : DLQ SQS > 0 (job PDF definitivement echoue)
resource "aws_cloudwatch_metric_alarm" "sqs_dlq_messages" {
  alarm_name          = "${local.name_prefix}-sqs-dlq-messages"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "Alerte immediate des qu'un message arrive dans la DLQ pdf-jobs-dlq"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    QueueName = aws_sqs_queue.pdf_jobs_dlq.name
  }
}

# Alarme 3 : Erreurs Lambda pdf-worker
resource "aws_cloudwatch_metric_alarm" "lambda_pdf_worker_errors" {
  alarm_name          = "${local.name_prefix}-lambda-pdf-worker-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "Alerte en cas d'erreur de rendu PDF dans le worker Lambda"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    FunctionName = aws_lambda_function.pdf_worker.function_name
  }
}

# Alarme 4 : CPU EC2 > 80%
resource "aws_cloudwatch_metric_alarm" "ec2_cpu_high" {
  alarm_name          = "${local.name_prefix}-ec2-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 120
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Alerte si la charge CPU de l'instance EC2 depasse 80% pendant 4 minutes"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    InstanceId = aws_instance.server.id
  }
}

# Alarme 5 : EC2 StatusCheckFailed
resource "aws_cloudwatch_metric_alarm" "ec2_status_check_failed" {
  alarm_name          = "${local.name_prefix}-ec2-status-check-failed"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  alarm_description   = "Alerte immediate si le controle de sante EC2 AWS echoue"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    InstanceId = aws_instance.server.id
  }
}

# 4. Tableau de bord CloudWatch (Dashboard)
resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${local.name_prefix}-dashboard"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["AWS/EC2", "CPUUtilization", "InstanceId", aws_instance.server.id],
            [".", "StatusCheckFailed", ".", "."]
          ]
          period = 60
          stat   = "Average"
          region = local.region
          title  = "Sante Serveur EC2 (CPU & Status)"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.pdf_jobs.name],
            [".", "ApproximateAgeOfOldestMessage", ".", "."],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.pdf_jobs_dlq.name]
          ]
          period = 60
          stat   = "Maximum"
          region = local.region
          title  = "File SQS PDF Jobs & DLQ"
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.download_api.function_name],
            [".", "Errors", ".", "."],
            ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.pdf_worker.function_name],
            [".", "Errors", ".", "."]
          ]
          period = 60
          stat   = "Sum"
          region = local.region
          title  = "Invocations et Erreurs Lambdas"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["AWS/CloudFront", "Requests", "DistributionId", aws_cloudfront_distribution.cdn.id],
            [".", "4xxErrorRate", ".", "."],
            [".", "5xxErrorRate", ".", "."]
          ]
          period = 60
          stat   = "Sum"
          region = "us-east-1"
          title  = "Trafic CloudFront & Taux d'Erreurs"
        }
      }
    ]
  })
}
