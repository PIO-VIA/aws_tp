# ------------------------------------------------------------------------------
# Outputs d'Infrastructure Terraform
# ------------------------------------------------------------------------------

output "cloudfront_domain" {
  description = "Nom de domaine public CloudFront (HTTPS)"
  value       = aws_cloudfront_distribution.cdn.domain_name
}

output "instance_id" {
  description = "Identifiant de l'instance EC2"
  value       = aws_instance.server.id
}

output "ecr_app_url" {
  description = "URL du dépôt ECR pour l'application Next.js"
  value       = aws_ecr_repository.app.repository_url
}

output "ecr_collab_url" {
  description = "URL du dépôt ECR pour le serveur de collaboration Hocuspocus"
  value       = aws_ecr_repository.collab.repository_url
}

output "data_bucket" {
  description = "Nom du bucket S3 de données privé"
  value       = aws_s3_bucket.data.id
}

output "queue_url" {
  description = "URL de la file SQS pdf-jobs"
  value       = aws_sqs_queue.pdf_jobs.url
}

output "dlq_url" {
  description = "URL de la file DLQ pdf-jobs-dlq"
  value       = aws_sqs_queue.pdf_jobs_dlq.url
}

output "lambda_function_url" {
  description = "URL de la fonction Lambda download-api"
  value       = aws_lambda_function_url.download_api.function_url
}

output "alarm_names" {
  description = "Noms des alarmes CloudWatch configurées"
  value = [
    aws_cloudwatch_metric_alarm.sqs_oldest_message_age.alarm_name,
    aws_cloudwatch_metric_alarm.sqs_dlq_messages.alarm_name,
    aws_cloudwatch_metric_alarm.lambda_pdf_worker_errors.alarm_name,
    aws_cloudwatch_metric_alarm.ec2_cpu_high.alarm_name,
    aws_cloudwatch_metric_alarm.ec2_status_check_failed.alarm_name
  ]
}

output "eip_public_ip" {
  description = "Adresse IP publique élastique de l'instance EC2"
  value       = aws_eip.server.public_ip
}
