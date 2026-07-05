output "instance_public_ip" {
  value       = aws_eip.app.public_ip
  description = "Elastic IP of the app server. Point deploy scripts / DNS checks here."
}

output "ssh_command" {
  value       = "ssh ubuntu@${aws_eip.app.public_ip}"
  description = "Quick SSH command (requires your key matching var.ssh_public_key)."
}

output "route53_name_servers" {
  value       = aws_route53_zone.primary.name_servers
  description = "Set these 4 as custom nameservers for domain_name at Hostinger (registrar) to delegate DNS to this zone."
}

output "backups_bucket" {
  value       = aws_s3_bucket.backups.bucket
  description = "S3 bucket for nightly pg_dump backups (transits, daily_stats, vessels)."
}
