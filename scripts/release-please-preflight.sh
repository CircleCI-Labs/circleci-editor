#!/usr/bin/env bash
# Copyright (c) 2026 Circle Internet Services, Inc.
#
# SPDX-License-Identifier: MIT
#
# Check that $GITHUB_TOKEN can actually do what release-please needs, and say
# precisely what is missing when it can't.
#
# Why this exists: when the token lacks a permission, release-please fails with
# ~300 lines of GraphQL stack trace ending in eight repetitions of "Resource not
# accessible by personal access token" -- with no indication of *which*
# resource, *which* permission, or that the problem is the token at all rather
# than the config, the tool, or the repo. That happened for real (build 1617 on
# main, commit 3cf9c5a) and cost a full debugging round to interpret.
#
# The probe below runs the same GraphQL query release-please fails on, reduced
# to its essentials, so a permission gap is reported as an actionable sentence
# before the real tool runs.
#
# This deliberately FAILS rather than skipping, unlike scripts/check-pr-title.sh
# (issues #119, #126). The distinction: the PR-title
# check has a second, uncredentialed guard covering the same defect, so skipping
# it costs timeliness. Release automation has no backup -- a silent skip means
# releases quietly stop happening and nobody notices until they wonder where the
# next version went. Loud is correct here.

set -euo pipefail

REPO="CircleCI-Labs/circleci-editor"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"
TOKEN_SETTINGS_URL="https://github.com/settings/personal-access-tokens"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  cat >&2 <<EOF
error: GITHUB_TOKEN is not set.

This job needs the devex-release context, which holds GITHUB_TOKEN. Either the
context is not attached to this job in .circleci/config.yml, or the variable is
missing from it.
EOF
  exit 1
fi

# The narrowest query that reproduces the failure: read one commit on main and
# its associated pull requests. Contents access alone satisfies the history
# part; `associatedPullRequests` additionally requires pull-request read, which
# is the permission that was actually missing.
read -r -d '' query <<'GRAPHQL' || true
query probe($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    viewerPermission
    ref(qualifiedName: "main") {
      target {
        ... on Commit {
          history(first: 1) {
            nodes {
              oid
              associatedPullRequests(first: 1) { nodes { number } }
            }
          }
        }
      }
    }
  }
}
GRAPHQL

payload="$(node -e '
  const [query, owner, repo] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({query, variables: {owner, repo}}));
' "${query}" "${OWNER}" "${NAME}")"

# Not -f: a GraphQL permission error comes back as HTTP 200 with an `errors`
# array, so failing on HTTP status would miss exactly the case being probed.
# Headers are captured separately for the token-expiry warning below.
header_file="$(mktemp)"
trap 'rm -f "${header_file}"' EXIT

response="$(curl -sS -D "${header_file}" \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "${payload}" \
  "https://api.github.com/graphql")"

# Validate the SUCCESS shape positively rather than checking for the absence of
# an `errors` array. A revoked or malformed token gets a 401 whose body is
# `{"message": "Bad credentials"}` -- no `errors` key at all -- so an
# absence-of-errors check reports "preflight OK" for a token that cannot
# authenticate. Verified by running this script against a deliberately invalid
# token, which is exactly how that bug was caught.
# shellcheck disable=SC2016 # The ${...} below are JavaScript template literals
# evaluated by node, not shell expansions. Single quotes are required precisely
# so the shell leaves them alone.
problem="$(node -e '
  let parsed;
  try {
    parsed = JSON.parse(require("fs").readFileSync(0, "utf8"));
  } catch {
    process.stdout.write("the API returned a body that is not JSON");
    process.exit(0);
  }
  if (parsed.errors?.length) {
    const kinds = [...new Set(parsed.errors.map((e) => e.type ?? "UNKNOWN"))];
    process.stdout.write(`GraphQL returned ${kinds.join(", ")}`);
    process.exit(0);
  }
  if (parsed.message) {
    process.stdout.write(`the API rejected the request: ${parsed.message}`);
    process.exit(0);
  }
  const node = parsed.data?.repository?.ref?.target?.history?.nodes?.[0];
  if (!node) {
    process.stdout.write("the commit history came back empty or malformed");
    process.exit(0);
  }
  // Present-but-null is how GraphQL reports a field it would not return; an
  // absent key means the response shape is not what we asked for at all.
  if (!node.associatedPullRequests?.nodes) {
    process.stdout.write("associated pull requests were not readable");
    process.exit(0);
  }
  // The read probes above prove authentication, and nothing else, whenever this
  // repository is public: GitHub serves public repository data to any valid
  // token, including one whose fine-grained repository list does not contain
  // this repository at all. That is not hypothetical -- it is how the v1.0.0
  // release job printed "Preflight OK" and then failed on the very next step
  // with "Resource not accessible by personal access token" creating a ref.
  // So ask GitHub what this token may actually do here.
  const permission = parsed.data?.repository?.viewerPermission;
  if (!permission) {
    process.stdout.write(
      "the permission this token holds on this repository could not be determined",
    );
    process.exit(0);
  }
  if (!["WRITE", "MAINTAIN", "ADMIN"].includes(permission)) {
    process.stdout.write(
      `the token has ${permission} access, but release-please must write ` +
        "(it creates a branch, a tag and a release)",
    );
    process.exit(0);
  }
  process.stdout.write("");
' <<<"${response}")"

if [ -n "${problem}" ]; then
  cat >&2 <<EOF
error: GITHUB_TOKEN cannot do what release-please needs on ${REPO}.

The probe failed because ${problem}.
EOF

  # Only the permission diagnosis below; a token that cannot authenticate at all
  # is a different problem and the permission table would be a red herring.
  case "${problem}" in
  *"Bad credentials"* | *"not JSON"* | *"rejected the request"*)
    cat >&2 <<EOF

That is an authentication failure, not a permission gap: the token is expired,
revoked, or malformed. Replace GITHUB_TOKEN in the devex-release context with a
current token, then grant it Pull requests read & write and Issues read & write
for this repository.
EOF
    exit 1
    ;;
  esac

  cat >&2 <<EOF

What this means
---------------
release-please builds a release PR by walking main's commits and reading the
pull request each one came from -- it needs the PR titles to work out the next
version and the PR bodies to write the changelog. It then creates a branch, a
tag and a release, all of which are writes.

Every one of these is required. This list deliberately no longer claims that
any of them is "already working": an earlier version asserted that Contents
write was fine because the read probe had succeeded, and on a *public*
repository that read succeeds for a token with no access to the repository at
all -- so the reassurance was unfounded exactly when it mattered.

  Contents: read & write        -- creates the release branch, tag and release
  Pull requests: read & write   -- opens and updates the release PR
  Issues: read & write          -- for fine-grained tokens, labels are governed
                                   by the Issues permission, not Pull requests.
                                   release-please labels the release PR
                                   "autorelease: pending", and for
                                   fine-grained tokens labels are governed by
                                   the Issues permission, not Pull requests.
                                   The github-release step will not find the
                                   PR without that label.

How to fix it
-------------
Edit the token behind the devex-release context's GITHUB_TOKEN at
  ${TOKEN_SETTINGS_URL}
and check two separate things for ${REPO}: that the repository appears in the
token's *repository access* list at all (a fine-grained token silently reads
public repositories it was never granted), and that it has Contents read &
write, Pull requests read & write, and Issues read & write.
Nothing in this repository needs to change -- do not edit the config to work
around this.

Until then, a release can still be cut by hand by running release-please's
own CLI (release-pr, then github-release) with a token that does have those
scopes; see https://github.com/googleapis/release-please.
EOF
  exit 1
fi

echo "Preflight OK: GITHUB_TOKEN can read commit history and associated pull requests,"
echo "and holds write access to ${REPO}."

# Surface the expiry rather than waiting to be surprised by it: a token that
# expires mid-quarter turns release automation off silently, and this is the one
# place that already knows the date.
expiry="$(grep -i '^github-authentication-token-expiration:' "${header_file}" |
  sed 's/^[^:]*: *//' | tr -d '\r' || true)"
if [ -n "${expiry}" ]; then
  echo "Note: GITHUB_TOKEN expires ${expiry}. Releases stop working after that."
fi
