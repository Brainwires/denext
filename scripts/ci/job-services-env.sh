#!/bin/bash
# Map the job services our self-hosted pools start for this job (DENEXT_CI_*: the runner's
# environment on the Linux pool, the guest's /tmp/denext-ci-services.env on the Macs) onto the
# DENEXT_TEST_* names the suites read, through $GITHUB_ENV. Masks every credential first.
set -eu
if [ -z "${DENEXT_CI_SERVICES:-}" ] && [ -f /tmp/denext-ci-services.env ]; then set -a; . /tmp/denext-ci-services.env; set +a; fi
if [ "${DENEXT_CI_SERVICES:-}" != 1 ]; then
  echo "::error::this self-hosted runner provides no job services (no DENEXT_CI_SERVICES): its launcher must start them (ops/runners LINUX_JOB_SERVICES / MAC_ARM_JOB_SERVICES)"
  exit 1
fi
for s in ${DENEXT_CI_SERVICES_SECRETS//,/ }; do echo "::add-mask::$s"; done
{
  echo "DENEXT_TEST_POSTGRES_URL=$DENEXT_CI_POSTGRES_URL"
  echo "DENEXT_TEST_POSTGIS_URL=$DENEXT_CI_POSTGIS_URL"
  echo "DENEXT_TEST_REDIS_URL=$DENEXT_CI_REDIS_URL"
  echo "DENEXT_TEST_S3_ENDPOINT=$DENEXT_CI_S3_ENDPOINT"
  echo "DENEXT_TEST_S3_ACCESS_KEY=$DENEXT_CI_S3_ACCESS_KEY"
  echo "DENEXT_TEST_S3_SECRET_KEY=$DENEXT_CI_S3_SECRET_KEY"
  echo "DENEXT_CI_S3_BUCKET=$DENEXT_CI_S3_BUCKET"
} >>"$GITHUB_ENV"
echo "job services: postgres, postgis, redis, minio on $DENEXT_CI_SERVICES_HOST (credentials masked)"
