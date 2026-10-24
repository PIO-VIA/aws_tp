# ------------------------------------------------------------------------------
# Identités Amazon SES (Expéditeur et Destinataires Sandbox)
# ------------------------------------------------------------------------------

# Identité vérifiée pour l'expéditeur des notifications
resource "aws_ses_email_identity" "sender" {
  email = var.ses_sender
}

# Identités vérifiées pour les destinataires (mode sandbox SES)
resource "aws_ses_email_identity" "recipients" {
  for_each = toset(var.ses_recipients)
  email    = each.value
}
