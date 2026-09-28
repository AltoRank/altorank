#!/usr/bin/env bash
# The Docker images `supabase start` needs in CI, cached so the registries are
# asked for them once per CLI version instead of once per run.
#
# Why: on 2026-09-23 the e2e job failed five times in a day at "Start Supabase"
# with `toomanyrequests` from ghcr.io, before a single test ran, and logging in
# to ghcr did not help. The CLI pulls from public.ecr.aws, ghcr.io or Docker
# Hub depending on its version and on whether supabase/setup-cli exported
# SUPABASE_INTERNAL_IMAGE_REGISTRY (that changed under the floating @v1 tag
# between 09-23 and 09-24), and every one of them throttles shared runners.
#
# Reads SUPABASE_IMAGES from the workflow: space-separated `name:tag`, the last
# path segment of each image, which is how the CLI itself names them whatever
# the registry. ci.yml says where the list comes from and how to refresh it.
#
#   supabase-images.sh load <tar>   docker load, then tag every image under
#                                   each name the CLI looks for
#   supabase-images.sh verify       fail unless the Supabase images on this
#                                   runner are exactly the listed ones
#   supabase-images.sh save <tar>   docker save the listed images
#   supabase-images.sh pull         pull whatever is missing, ECR then ghcr
set -euo pipefail

: "${SUPABASE_IMAGES:?SUPABASE_IMAGES is not set; ci.yml defines it}"

# The two mirrors the CLI tries, in its own order (internal/utils/docker.go,
# GetRegistryImageUrls). With SUPABASE_INTERNAL_IMAGE_REGISTRY set it looks
# under that one only, which is why `load` tags both.
MIRRORS=(public.ecr.aws/supabase ghcr.io/supabase)

# Every local image as "<name:tag> <full ref>", e.g.
# "kong:2.8.1 public.ecr.aws/supabase/kong:2.8.1".
local_images() {
  docker image ls --format '{{.Repository}}:{{.Tag}}' | awk -F/ '$0 !~ /<none>/ { print $NF " " $0 }'
}

# The first local ref of one listed image, from any registry, or nothing.
local_ref() {
  # No early `exit` in awk: with pipefail, closing the pipe on docker would
  # fail the whole command substitution.
  local_images | awk -v want="$1" '$1 == want && !found { print $2; found = 1 }'
}

cmd="${1:-}"
case "$cmd" in
  load)
    tar="${2:?usage: load <tar>}"
    docker load --input "$tar"
    for image in $SUPABASE_IMAGES; do
      ref="$(local_ref "$image")"
      if [ -z "$ref" ]; then
        echo "::warning::$image was not in the cached archive; the CLI will pull it."
        continue
      fi
      for mirror in "${MIRRORS[@]}"; do
        [ "$ref" = "$mirror/$image" ] || docker tag "$ref" "$mirror/$image"
      done
    done
    ;;

  verify)
    # Two ways the list goes stale, both after a CLI bump or a change to the
    # `-x` set: the CLI pulls something the cache does not hold (every run
    # then pulls it from a registry again), or the list names something the
    # CLI no longer uses (`save` would fail on it).
    status=0
    for image in $SUPABASE_IMAGES; do
      if [ -z "$(local_ref "$image")" ]; then
        echo "::error::$image is in SUPABASE_IMAGES but supabase start did not use it."
        status=1
      fi
    done
    listed=" $SUPABASE_IMAGES "
    while read -r name ref; do
      case "$ref" in
        public.ecr.aws/supabase/* | ghcr.io/supabase/* | supabase/*) ;;
        *) continue ;;
      esac
      if [[ "$listed" != *" $name "* ]]; then
        echo "::error::supabase start pulled $ref, which SUPABASE_IMAGES does not list, so it is not cached."
        status=1
      fi
    done < <(local_images)
    if [ "$status" -ne 0 ]; then
      echo "Supabase images on this runner:"
      local_images | awk '$2 ~ /supabase\//' | sort
      echo "Update SUPABASE_IMAGES in .github/workflows/ci.yml to match."
    fi
    exit "$status"
    ;;

  save)
    tar="${2:?usage: save <tar>}"
    refs=()
    for image in $SUPABASE_IMAGES; do
      ref="$(local_ref "$image")"
      if [ -z "$ref" ]; then
        echo "::error::$image is not on this runner, so it cannot be cached."
        exit 1
      fi
      refs+=("$ref")
    done
    mkdir -p "$(dirname "$tar")"
    docker save --output "$tar" "${refs[@]}"
    ls -lh "$tar"
    ;;

  pull)
    for image in $SUPABASE_IMAGES; do
      [ -n "$(local_ref "$image")" ] && continue
      pulled=""
      for attempt in 1 2 3; do
        for mirror in "${MIRRORS[@]}"; do
          if docker pull --quiet "$mirror/$image"; then
            pulled="$mirror/$image"
            break 2
          fi
        done
        sleep $((attempt * 20))
      done
      if [ -z "$pulled" ]; then
        echo "::error::Could not pull $image from ${MIRRORS[*]}."
        exit 1
      fi
    done
    ;;

  *)
    echo "usage: $0 load <tar> | verify | save <tar> | pull" >&2
    exit 2
    ;;
esac
