variable "project" {
  description = "Name used for tags and resource names."
  type        = string
  default     = "streaming-backend"
}

variable "region" {
  description = "AWS region. Mumbai by default."
  type        = string
  default     = "ap-south-1"
}

variable "instance_type" {
  description = "Kafka plus nine Node services need about 3 GB of RAM, so t3.medium (4 GB)."
  type        = string
  default     = "t3.medium"
}

variable "allowed_cidr" {
  description = "Who may open the app, e.g. your own IP as \"203.0.113.7/32\". Never 0.0.0.0/0."
  type        = string
}

variable "repo_url" {
  description = "Git repository the instance clones to get the Kubernetes manifests."
  type        = string
  default     = "https://github.com/pavanaditya123/streaming_backend_netflix.git"
}
