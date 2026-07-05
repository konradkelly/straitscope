variable "aws_region" {
  type        = string
  description = "AWS region for all resources."
  default     = "us-east-1"
}

variable "project_name" {
  type        = string
  description = "Short name used to prefix/tag resources."
  default     = "straitscope"
}

variable "domain_name" {
  type        = string
  description = "Registered domain (registrar stays Hostinger; this hosted zone takes over DNS resolution per spec.md sec9)."
  default     = "straitscope.com"
}

variable "admin_ip_cidr" {
  type        = string
  description = "Your IP in CIDR form allowed to SSH the instance, e.g. 203.0.113.4/32 (find yours with `curl ifconfig.me`). No default on purpose: this must never accidentally open to 0.0.0.0/0."
}

variable "ssh_public_key" {
  type        = string
  description = "Contents of the admin SSH public key, e.g. $(cat ~/.ssh/id_ed25519.pub)."
}

variable "instance_type" {
  type        = string
  description = "EC2 instance type running docker-compose (db + ingest + worker + api)."
  default     = "t3.small"
}

variable "root_volume_size_gb" {
  type        = number
  description = "Root EBS volume size in GB (holds the Postgres/Timescale data volume)."
  default     = 30
}

variable "acme_email" {
  type        = string
  description = "Email registered with Let's Encrypt for Caddy's automatic TLS (renewal notices only). Optional."
  default     = null
}
