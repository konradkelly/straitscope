resource "aws_key_pair" "admin" {
  key_name   = "${var.project_name}-admin"
  public_key = var.ssh_public_key
}

locals {
  caddyfile = templatefile("${path.module}/templates/Caddyfile.tftpl", {
    domain_name = var.domain_name
    acme_email  = var.acme_email
  })

  user_data = templatefile("${path.module}/templates/user_data.sh.tftpl", {
    caddyfile = local.caddyfile
  })
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.app.id]
  key_name               = aws_key_pair.admin.key_name
  iam_instance_profile   = aws_iam_instance_profile.app.name

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_size_gb
  }

  user_data                   = local.user_data
  user_data_replace_on_change = true

  tags = {
    Name = "${var.project_name}-app"
  }
}

resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"

  tags = {
    Name = "${var.project_name}-app"
  }
}
