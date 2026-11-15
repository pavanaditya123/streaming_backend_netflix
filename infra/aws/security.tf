# Only one way in: the API gateway's NodePort, and only from allowed_cidr.
# There is no SSH rule at all. Shell access goes through SSM Session Manager,
# which is authenticated with IAM instead of a key file that can leak.

resource "aws_security_group" "app" {
  name        = "${var.project}-app"
  description = "API gateway from allowed_cidr only, no SSH"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "API gateway (Kubernetes NodePort)"
    from_port   = 30080
    to_port     = 30080
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  egress {
    description = "Pull images and packages"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Instance role: just enough permission for SSM to manage the machine.
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.project}-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.project}-instance"
  role = aws_iam_role.instance.name
}
