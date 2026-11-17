#!/bin/sh
# A production deploy of a Next.js example (crm or warehouse) to its Vercel project, built here and uploaded prebuilt.
#
#   VERCEL_ORG_ID=… VERCEL_CRM_PROJECT_ID=… examples/deploy.sh crm
#   VERCEL_ORG_ID=… VERCEL_WAREHOUSE_PROJECT_ID=… examples/deploy.sh warehouse
#
# Needs: the Vercel CLI signed in (`vercel whoami`). The Vercel project: Root Directory examples/<name>, Install Command
# `cd ../.. && npm ci` (the example is a workspace: one install at the repository root, one Next.js), and
# CLEGRA_PUBLIC_URL not marked sensitive (pages read it at build time; a local build can't read sensitive values). Its
# environment variables (database, CLEGRA_* settings: the example's README) live on
# Vercel and are pulled into .vercel/ for the build, which is deleted afterwards. No id or secret is kept in this file.
# Logs: $DEPLOY_LOGS (default: a new temporary folder), printed at the end.
set -eu

name=${1:-}
case $name in
  crm) project=${VERCEL_CRM_PROJECT_ID:-} ;;
  warehouse) project=${VERCEL_WAREHOUSE_PROJECT_ID:-} ;;
  *) echo "usage: examples/deploy.sh crm|warehouse" >&2; exit 2 ;;
esac
[ -n "${VERCEL_ORG_ID:-}" ] || { echo "deploy: VERCEL_ORG_ID is not set" >&2; exit 2; }
[ -n "$project" ] || { echo "deploy: the project id of $name is not set (VERCEL_$(echo "$name" | tr a-z A-Z)_PROJECT_ID)" >&2; exit 2; }
export VERCEL_ORG_ID VERCEL_PROJECT_ID="$project"

root=$(cd "$(dirname "$0")/.." && pwd)
logs=${DEPLOY_LOGS:-$(mktemp -d "${TMPDIR:-/tmp}/clegra-deploy.XXXXXX")}
mkdir -p "$logs"
cd "$root"
cleanup() { rm -rf "$root/.vercel" "$root/examples/$name/.next"; }
trap cleanup EXIT

rm -rf .vercel
vercel pull --yes --environment=production > "$logs/pull-$name.log" 2>&1 || { echo "deploy: vercel pull failed ($logs/pull-$name.log)" >&2; exit 1; }
vercel build --prod > "$logs/build-$name.log" 2>&1 || { echo "deploy: vercel build failed:" >&2; tail -20 "$logs/build-$name.log" >&2; exit 1; }
vercel deploy --prebuilt --prod --archive=tgz > "$logs/deploy-$name.log" 2>&1 || { echo "deploy: vercel deploy failed:" >&2; tail -20 "$logs/deploy-$name.log" >&2; exit 1; }
tail -6 "$logs/deploy-$name.log" | cut -c1-250
echo "logs: $logs"
