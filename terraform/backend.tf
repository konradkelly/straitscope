# Bucket/region are intentionally omitted here (backend blocks can't use
# variables). Provide them at init time so the bucket name isn't hardcoded
# into version control:
#
#   terraform init \
#     -backend-config="bucket=<state bucket from terraform/bootstrap>" \
#     -backend-config="region=us-east-1"
#
# See terraform/README.md for the full bootstrap sequence.
terraform {
  backend "s3" {
    key          = "straitscope/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}
