# ------------------------------------------------------------------------------
# Instance EC2 pour le serveur Next.js et Hocuspocus (Caddy reverse proxy)
# ------------------------------------------------------------------------------

# AMI officielle Amazon Linux 2023 la plus récente
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

# Prefix list gérée AWS pour les serveurs d'origine CloudFront
data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

# Groupe de sécurité EC2 : Port 80 uniquement depuis CloudFront, aucun SSH (SSM Session Manager)
resource "aws_security_group" "ec2" {
  name        = "${local.name_prefix}-ec2-sg"
  description = "Autorise uniquement le trafic entrant depuis CloudFront sur le port 80"

  ingress {
    description     = "HTTP entrant depuis CloudFront uniquement"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }

  egress {
    description = "Trafic sortant illimite (mises a jour, SSM, ECR, DynamoDB, S3)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Instance EC2
resource "aws_instance" "server" {
  ami                  = data.aws_ami.al2023.id
  instance_type        = var.ec2_instance_type
  iam_instance_profile = aws_iam_instance_profile.ec2.name

  vpc_security_group_ids = [aws_security_group.ec2.id]

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 20
    delete_on_termination = true
    encrypted             = true
  }

  user_data = templatefile("${path.module}/../../deploy/bootstrap.sh", {
    AWS_REGION     = var.aws_region
    SSM_PREFIX     = "/${var.project}/${var.environment}/"
    ECR_APP_URL    = aws_ecr_repository.app.repository_url
    ECR_COLLAB_URL = aws_ecr_repository.collab.repository_url
    DATA_BUCKET    = aws_s3_bucket.data.id
    PDF_QUEUE_URL  = aws_sqs_queue.pdf_jobs.url
  })

  tags = {
    Name = "${local.name_prefix}-server"
  }
}

# Elastic IP publique fixe attachée à l'instance
resource "aws_eip" "server" {
  instance = aws_instance.server.id
  domain   = "vpc"

  tags = {
    Name = "${local.name_prefix}-eip"
  }
}
