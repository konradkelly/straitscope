# CI deploy hand-off: GitHub Actions uploads docker-compose.prod.yml,
# schema.sql, incidents.yaml, web/dist, and a deploy.env under a per-SHA
# prefix here; the instance's own IAM role (not GitHub's) pulls them down
# via an SSM-triggered script. Kept separate from the backups bucket --
# different producers, different lifecycle needs, and a scoping mistake
# in either bucket's IAM policy can't reach the other's data.
resource "aws_s3_bucket" "deploy_artifacts" {
  bucket = "${var.project_name}-deploy-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "deploy_artifacts" {
  bucket                  = aws_s3_bucket.deploy_artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "deploy_artifacts" {
  bucket = aws_s3_bucket.deploy_artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "deploy_artifacts" {
  bucket = aws_s3_bucket.deploy_artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "deploy_artifacts" {
  bucket = aws_s3_bucket.deploy_artifacts.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 14
    }
  }
}
