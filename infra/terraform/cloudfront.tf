# ------------------------------------------------------------------------------
# Distribution CloudFront (HTTPS, WebSockets, routage EC2 / Lambda)
# ------------------------------------------------------------------------------

# Extraction du hostname de la Function URL Lambda (sans https:// ni /)
locals {
  lambda_url_domain = replace(replace(aws_lambda_function_url.download_api.function_url, "https://", ""), "/", "")

  # Politiques gérées AWS CloudFront
  cache_disabled_id         = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  all_viewer_except_host_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewerExceptHostHeader
}

resource "aws_cloudfront_distribution" "cdn" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "Distribution CloudFront - ${local.name_prefix}"
  price_class     = "PriceClass_100" # Europe et Amerique du Nord uniquement (economique)

  # 1. Origine EC2 (HTTP 80)
  origin {
    domain_name = aws_eip.server.public_dns != "" ? aws_eip.server.public_dns : aws_instance.server.public_ip
    origin_id   = "ec2"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # 2. Origine Lambda Function URL (HTTPS 443)
  origin {
    domain_name = local.lambda_url_domain
    origin_id   = "lambda"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Comportement par défaut : Tout le trafic vers l'instance EC2 (Next.js)
  default_cache_behavior {
    target_origin_id       = "ec2"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]

    cache_policy_id          = local.cache_disabled_id
    origin_request_policy_id = local.all_viewer_except_host_id
  }

  # Comportement /collab* : Collaboration WebSocket vers EC2 (sans cache)
  ordered_cache_behavior {
    path_pattern           = "/collab*"
    target_origin_id       = "ec2"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]

    cache_policy_id          = local.cache_disabled_id
    origin_request_policy_id = local.all_viewer_except_host_id
  }

  # Comportement /api/dl/* : Téléchargement vers Lambda ou EC2 selon la variable download_origin
  ordered_cache_behavior {
    path_pattern           = "/api/dl/*"
    target_origin_id       = var.download_origin == "lambda" ? "lambda" : "ec2"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]

    cache_policy_id          = local.cache_disabled_id
    origin_request_policy_id = local.all_viewer_except_host_id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
