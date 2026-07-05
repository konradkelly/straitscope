resource "aws_security_group" "app" {
  name        = "${var.project_name}-app"
  description = "Strait Tracker app server: HTTP/HTTPS public, no inbound SSH. Admin access and CI/CD deploys go through AWS SSM."
  vpc_id      = data.aws_vpc.default.id

  # AWS doesn't allow updating a security group's top-level description via
  # its API (only rule-level descriptions) -- any change to this field is
  # ForceNew. Plain destroy-then-create (the default) is fine as long as
  # nothing is still attached to the old group when it's destroyed --
  # create_before_destroy was tried here but doesn't work for a fixed-name
  # security group: AWS enforces unique names per VPC, so the replacement
  # can't be created while the original (same name) still exists.
  ingress {
    description = "HTTP (redirect to HTTPS + ACME HTTP-01 challenge)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-app"
  }
}
