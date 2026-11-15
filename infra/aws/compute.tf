# Latest Ubuntu 22.04 image published by Canonical.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
}

resource "aws_instance" "k3s" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name

  # On first boot: install k3s, clone the repo, generate secrets, deploy.
  user_data = templatefile("${path.module}/bootstrap.sh.tftpl", {
    repo_url = var.repo_url
  })

  # IMDSv2 only: blocks the classic SSRF trick of reading instance
  # credentials from 169.254.169.254 with a plain GET.
  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
  }

  tags = { Name = "${var.project}-k3s" }
}
