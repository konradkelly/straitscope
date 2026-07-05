# Hostinger stays the registrar; this zone takes over DNS resolution once
# Hostinger's nameservers are repointed to the 4 NS records below (spec.md
# sec9). Do this before first deploy -- Caddy's ACME HTTP-01 cert issuance
# validates over live DNS, and a stale/unpropagated record will fail it.
resource "aws_route53_zone" "primary" {
  name = var.domain_name
}

resource "aws_route53_record" "apex" {
  zone_id = aws_route53_zone.primary.zone_id
  name    = var.domain_name
  type    = "A"
  ttl     = 300
  records = [aws_eip.app.public_ip]
}

resource "aws_route53_record" "www" {
  zone_id = aws_route53_zone.primary.zone_id
  name    = "www.${var.domain_name}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.app.public_ip]
}
