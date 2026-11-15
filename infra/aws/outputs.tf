output "app_url" {
  description = "API gateway. Give k3s about 5 minutes after apply to pull images."
  value       = "http://${aws_instance.k3s.public_ip}:30080"
}

output "instance_id" {
  value = aws_instance.k3s.id
}

output "shell" {
  description = "Open a shell on the instance without SSH."
  value       = "aws ssm start-session --target ${aws_instance.k3s.id} --region ${var.region}"
}
