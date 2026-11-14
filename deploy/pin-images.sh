#!/usr/bin/env bash
# Report mutable image tags and the digest-pinned replacement.
#
# Usage:
#   ./deploy/pin-images.sh          # report every image and a usable digest
#   ./deploy/pin-images.sh --check  # exit 1 if any image is not digest-pinned
#
# This script never edits compose.yaml or Dockerfile.app. The app build itself
# is always a local image; pin its base image in Dockerfile.app and publish the
# built app image by digest if you distribute it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"
CHECK=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK=1
elif [[ "${1:-}" != "" ]]; then
  echo "usage: $0 [--check]" >&2
  exit 2
fi

mapfile -t IMAGES < <(
  {
    sed -n 's/^[[:space:]]*image:[[:space:]]*//p' compose.yaml
    awk '/^[[:space:]]*FROM[[:space:]]/ {print $2}' Dockerfile.app
  } | sed 's/[[:space:]]*$//' | grep -v '^$' | sort -u
)

if [[ "${#IMAGES[@]}" -eq 0 ]]; then
  echo "no image references found" >&2
  exit 1
fi

UNPINNED=0
for image in "${IMAGES[@]}"; do
  if [[ "${image}" == *"@sha256:"* ]]; then
    echo "pinned   ${image}"
    continue
  fi
  UNPINNED=1
  echo "mutable  ${image}"
  digest="$(
    docker image inspect "${image}" \
      --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null |
      sed '/^$/d' | head -1 || true
  )"
  if [[ -n "${digest}" ]]; then
    echo "         use ${digest}"
  else
    echo "         run: docker pull ${image}"
  fi
done

if [[ "${CHECK}" -eq 1 && "${UNPINNED}" -eq 1 ]]; then
  echo "FAIL: at least one image is not digest-pinned" >&2
  exit 1
fi
