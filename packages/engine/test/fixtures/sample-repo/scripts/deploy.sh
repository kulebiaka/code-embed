#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT="${1:-staging}"
IMAGE="registry.example.com/payments:${GIT_SHA:-latest}"

echo "Deploying ${IMAGE} to ${ENVIRONMENT}"

build_image() {
  docker build -t "${IMAGE}" .
  docker push "${IMAGE}"
}

rollout() {
  kubectl --context "${ENVIRONMENT}" set image deployment/payments payments="${IMAGE}"
  kubectl --context "${ENVIRONMENT}" rollout status deployment/payments --timeout=120s
}

build_image
rollout
echo "Done"
