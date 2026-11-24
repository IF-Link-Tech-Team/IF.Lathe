# GitHub Actions compatibility for pipeline steps translated from workflows.
# A step sources it first (`. /usr/local/lib/iflink-ci/gha.sh`) and then sees
# what a `run:` step on GitHub sees: GITHUB_SHA, GITHUB_WORKSPACE, RUNNER_TEMP,
# and the GITHUB_ENV / GITHUB_PATH files, whose lines earlier steps wrote and
# this one inherits. GITHUB_REF, GITHUB_REF_NAME and GITHUB_REPOSITORY come
# from the pipeline's env. `gha_output <step-id> <name>` reads a value an
# earlier step wrote to its GITHUB_OUTPUT (the step exports
# GITHUB_OUTPUT=$CI_TMP/.gha/outputs/<step-id>).
#
# GITHUB_ACTIONS is not set: tools that see it would try GitHub's own
# services (caches, annotations, OIDC), which are not here.

: "${CI_TMP:=/home/ci/tmp}"
export CI_TMP
export GITHUB_WORKSPACE="${GITHUB_WORKSPACE:-/home/ci/work}"
export RUNNER_TEMP="$CI_TMP" RUNNER_OS=Linux RUNNER_ARCH=X64
GITHUB_SHA="${CI_COMMIT:-}"
[ -n "$GITHUB_SHA" ] || GITHUB_SHA=$(git -C "$GITHUB_WORKSPACE" rev-parse HEAD 2>/dev/null || true)
export GITHUB_SHA
export GITHUB_ENV="$CI_TMP/.gha/env" GITHUB_PATH="$CI_TMP/.gha/path"
export GITHUB_OUTPUT="${GITHUB_OUTPUT:-$CI_TMP/.gha/outputs/_}"
mkdir -p "$CI_TMP/.gha/outputs"
touch "$GITHUB_ENV" "$GITHUB_PATH"
while IFS= read -r gha_line || [ -n "$gha_line" ]; do
    case $gha_line in [A-Za-z_]*=*) export "$gha_line" ;; esac
done < "$GITHUB_ENV"
while IFS= read -r gha_line || [ -n "$gha_line" ]; do
    [ -n "$gha_line" ] && PATH="$gha_line:$PATH"
done < "$GITHUB_PATH"
export PATH
unset gha_line

gha_output() {
    sed -n "s/^$2=//p" "$CI_TMP/.gha/outputs/$1" 2>/dev/null | tail -n 1
}
