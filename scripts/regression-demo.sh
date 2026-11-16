#!/usr/bin/env bash
# Deliberate-regression demo (docs/RELEASE_REPORT.md §4). It runs in an isolated COPY of this repository, never in
# the repository itself: the copy gets a baseline commit, then each regression is committed, checked and reverted.
# Usage: scripts/regression-demo.sh <empty directory for the copy>
# Needs the continuum CLI with a Host login. Commits in the throwaway copy use --no-verify because the repository's
# guard hooks would (correctly) refuse the deliberately broken commits; the checks are then run explicitly.
set -u
SRC="$(cd "$(dirname "$0")/.." && pwd)"
R="${1:?usage: scripts/regression-demo.sh <empty directory>}"
OUT="$R/../regression-results"
mkdir -p "$R"
( cd "$SRC" && tar --exclude=./node_modules --exclude=./data --exclude=./.continuum --exclude=./.git --exclude=./docs/screenshots -cf - . ) | ( cd "$R" && tar -xf - )
ln -s "$SRC/node_modules" "$R/node_modules" 2>/dev/null || cp -r "$SRC/node_modules" "$R/node_modules"
( cd "$R" && git init -q && git -c user.name=Quorum-demo -c user.email=demo@quorum.test add -A && git -c user.name=Quorum-demo -c user.email=demo@quorum.test commit -qm baseline --no-verify )


mkdir -p "$OUT"
cd "$R"
G="git -c user.name=Quorum-demo -c user.email=demo@quorum.test"

checks() { # $1 = label
  local L="$1"
  echo "=================== $L ===================" | tee "$OUT/$L.txt"
  { echo "--- npx vitest run"; npx vitest run 2>&1 | grep -E "×|Test Files|Tests " | head -12
    echo "--- continuum package check"; continuum package check continuum 2>&1 | grep -E "CURRENT|DRIFT|STALE|refus|differ|integrity|^package|error" | head -8
    echo "--- continuum package run"; continuum package run continuum 2>&1 | grep -E "^FAIL|passed, " | head -8
    echo "--- continuum conformance check"; continuum conformance check continuum 2>&1 | grep -E "^\s+NO |^(CONFORMS|VIOLATED|NOT_EVALUATED|INSUFFICIENT)" | head -8
    echo "--- continuum evidence check"; continuum evidence check continuum 2>&1 | grep -E "^status|touched|stale" | head -4
    echo "--- continuum guard ci"; continuum guard ci 2>&1 | grep -E "^guard|^  (lifecycle|architecture|implementation|hygiene)|^  error" | head -12
  } 2>&1 | tee -a "$OUT/$L.txt"
}

checks 0-baseline

# R1 — behavioural: the blind-review guard (INV-7) is silently removed
node -e "const fs=require('fs');const p='src/contexts/peer-review/service.ts';let s=fs.readFileSync(p,'utf8');s=s.replace(\"if (mine.status !== 'completed') {\",\"if (false && mine.status !== 'completed') {\");fs.writeFileSync(p,s)"
$G commit -qam "R1: show peer reviews before the reviewer submits (deliberate regression)" --no-verify
checks 1-inv07-blind-review-removed
$G revert -q --no-edit HEAD --no-verify 2>/dev/null || $G revert --no-edit HEAD

# R2 — structural: Adjudication reaches into PeerReview's module (ADR-006: never reads review tables)
node -e "const fs=require('fs');const p='src/contexts/adjudication/service.ts';let s=fs.readFileSync(p,'utf8');s=s.replace(\"import type { Deps } from '../../platform/deps.ts';\",\"import type { Deps } from '../../platform/deps.ts';\nimport { countedReviews } from '../peer-review/completion.ts';\nexport const reviewCountFor = (deps: Deps, proposalId: string) => countedReviews(deps.db, proposalId);\");fs.writeFileSync(p,s)"
$G commit -qam "R2: adjudication reads peer-review internals (deliberate regression)" --no-verify
checks 2-adjudication-imports-peer-review
$G revert -q --no-edit HEAD --no-verify 2>/dev/null || $G revert --no-edit HEAD

# R3 — model drift: the semantic model is edited but the package is not rebuilt
node -e "const fs=require('fs');const p='continuum/model/quorum.adl';let s=fs.readFileSync(p,'utf8');s=s.replace('INV-9 — The sum of all awarded amounts','INV-9 — Roughly, the sum of awarded amounts');fs.writeFileSync(p,s)"
$G commit -qam "R3: model edited without rebuilding the package (deliberate regression)" --no-verify
checks 3-model-edited-not-rebuilt
$G revert -q --no-edit HEAD --no-verify 2>/dev/null || $G revert --no-edit HEAD

checks 4-restored
echo done
