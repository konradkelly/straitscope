# Infrastructure (spec.md sec9)

VPC-lite (default VPC), one EC2 instance running the docker-compose stack
behind Caddy (automatic TLS), an Elastic IP, and a Route 53 hosted zone.
State lives in S3. Cost target: ~$20-25/month.

## 1. Bootstrap the state bucket (one time)

```bash
cd terraform/bootstrap
terraform init
terraform apply -var="state_bucket_name=straitscope-tfstate"
```

Note the `bucket_name` output.

## 2. Apply the main config

```bash
cd terraform
terraform init \
  -backend-config="bucket=straitscope-tfstate" \
  -backend-config="region=us-east-1"

cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars: admin_ip_cidr, ssh_public_key, acme_email

terraform apply
```

## 3. Delegate DNS at Hostinger

Take the 4 values from the `route53_name_servers` output and set them as
**custom nameservers** on the domain at Hostinger (registrar stays
Hostinger; Route 53 becomes the DNS resolver). Do this *before* the first
deploy — Caddy's Let's Encrypt HTTP-01 challenge validates over live DNS, so
a stale/unpropagated record fails cert issuance. Propagation can take up to
a few hours.

## 4. Deploy the app

Terraform only provisions the host (Docker, Compose plugin, Caddy, the
`/opt/straitscope` directory). Getting `docker-compose.yml`, `.env`,
`sql/`, and the built `web/dist/` onto the box and running
`docker compose up -d` is the GitHub Actions job described in spec.md sec9 —
not part of this Terraform config.

## Notes

- `admin_ip_cidr` and `ssh_public_key` have no defaults on purpose — nothing
  sensitive is baked into version control.
- Backups: the `backups_bucket` output is the nightly `pg_dump` target
  (`transits`, `daily_stats`, `vessels`). Raw positions are not backed up
  (expendable per spec.md sec5.2).
- Monitoring (UptimeRobot on `/healthz`) is an external SaaS and isn't
  Terraform-managed here.
