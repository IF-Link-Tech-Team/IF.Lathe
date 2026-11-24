#!/usr/bin/env bash
# Builds the CI job VM image (images/linux) and installs it as
# /var/lib/iflink-ci-vm/images/<tag>, pointing current at it. The tag is a hash
# of images/linux, so an unchanged definition is not rebuilt. Keeps the newest
# other image, to go back to; a VM still running an older one keeps its open
# file.
#
#   sudo ./deploy/build-vm-image.sh [IF.Lathe dir]
set -euo pipefail

LATHE=${1:-$(cd "$(dirname "$0")/.." && pwd)}
SRC="$LATHE/images/linux"
IMAGES=${IFLINK_CI_VM_IMAGES:-/var/lib/iflink-ci-vm/images}

tag=$(cd "$SRC" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)
install -d -m 755 "$(dirname "$IMAGES")" "$IMAGES"
if [ ! -f "$IMAGES/$tag/root.img" ]; then
  echo "building CI VM image $tag"
  docker build -q -t "iflink-ci-vm:$tag" "$SRC" >/dev/null
  rm -rf "$IMAGES/$tag.part"
  install -d -m 755 "$IMAGES/$tag.part"
  id=$(docker create "iflink-ci-vm:$tag")
  trap 'docker rm -f "$id" >/dev/null 2>&1 || true' EXIT
  docker export "$id" | docker run --rm -i --network none --entrypoint sh \
    -v "$IMAGES/$tag.part:/out" -v "$SRC/make-image:/make-image:ro" "iflink-ci-vm:$tag" /make-image
  for file in vmlinuz initrd.img root.img; do
    [ -f "$IMAGES/$tag.part/$file" ] || { echo "build-vm-image: no $file" >&2; exit 1; }
  done
  mv "$IMAGES/$tag.part" "$IMAGES/$tag"
fi
ln -sfn "$tag" "$IMAGES/current.part"
mv -T "$IMAGES/current.part" "$IMAGES/current"
find "$IMAGES" -mindepth 1 -maxdepth 1 -type d ! -name "$tag" ! -name '*.part' -printf '%T@ %f\n' \
  | sort -rn | tail -n +2 | cut -d' ' -f2 | while read -r old; do
  rm -rf "${IMAGES:?}/$old"
  docker image rm "iflink-ci-vm:$old" >/dev/null 2>&1 || true
done
echo "CI VM image: $(readlink "$IMAGES/current")"
