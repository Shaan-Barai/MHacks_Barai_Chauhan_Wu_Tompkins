#!/usr/bin/env bash
# ScrapSaver: run every test suite with one command, then print a PASS/FAIL table.
#
#   ./test-all.sh                      offline: every package's unit tests, the dashboard build,
#                                      fixture + integration tests, Python tests, script checks
#   ./test-all.sh --live               + the local stack (deploy/local.sh up), smoke test, live E2E
#                                      suites and `demo.py --simulate` (Gemini + SAM + R2 calls)
#   ./test-all.sh --only backend,tests      just those suites (see --list)
#   ./test-all.sh --list               list the suites
#
# Options:
#   --live          also run the live suites (needs .env with Gemini + R2, the SAM venv, SpacetimeDB)
#   --only a,b      run only these suites (a live suite named here runs without --live)
#   --skip a,b      skip these suites
#   --install       run `npm ci` in every package first (default: only where node_modules is missing)
#   --keep-going    run every suite even after a failure (the default)
#   --fail-fast     stop at the first failed suite
#   -v, --verbose   stream each suite's output (it always goes to the log file too)
#   --list          list the suites and exit
#   -h, --help      this help
#
# Live suites write only to test halls (hall-test, hall-smoke, hall-e2e-*): hall-main's numbers and
# calibration are never changed, and every measurement setting a suite changes is restored.
#
# Logs: tests/.logs/<UTC time>/<suite>.log (gitignored); tests/.logs/latest points at the last run.
# Exit code: 0 when no suite failed, 1 otherwise (2 for a usage error, 130 when interrupted).
#
# Safety: secrets are never printed. Their values (ingest token, admin passcode, session secret,
# API keys) are redacted from the suite logs. This script never stops or kills a process: the live
# stack is started (or reused) by deploy/local.sh and left running; stop it with deploy/local.sh down.
# The demo suite likewise starts (or reuses) the upload website (upload_demo/server.mjs, :8795) and
# leaves it running.
#
# Environment (optional): SCRAP_RUN_DIR (the stack's state dir, default deploy/.run), API_PORT
# (default 8787), SCRAP_TEST_HALL (default hall-test), SCRAP_E2E_PHOTOS (default 2), PYTHON (python3),
# UPLOAD_DEMO_PORT (the upload website, default 8795).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO" || exit 2

RUN_DIR="${SCRAP_RUN_DIR:-$REPO/deploy/.run}"
API_PORT="${API_PORT:-8787}"
API_URL="http://127.0.0.1:$API_PORT"
UPLOAD_PORT="${UPLOAD_DEMO_PORT:-8795}"
TEST_HALL="${SCRAP_TEST_HALL:-hall-test}"
PYTHON="${PYTHON:-python3}"
TODAY="$(TZ=America/Detroit date +%F)"
TEST_SERVICE="svc_${TEST_HALL}_${TODAY}_dinner"
PACKAGES="data vision analytics capture backend frontend db/spacetimedb"
SECRET_VARS="SCRAP_INGEST_TOKEN SCRAP_ADMIN_PASSCODE SESSION_SECRET GEMINI_API_KEY GOOGLE_API_KEY R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY SPACETIMEDB_TOKEN CLOUDFLARE_API_TOKEN"

OFFLINE_SUITES="install data vision analytics capture backend frontend frontend-build db tests python scripts"
LIVE_SUITES="stack seed smoke e2e-flow e2e-scrap e2e-calibration demo"

describe() {
  case "$1" in
    install)         echo "npm ci where node_modules is missing (all packages with --install)" ;;
    data)            echo "data/: menu parsing, schema validation, seeds (node --test)" ;;
    vision)          echo "vision/: Gemini gateway, masks, pixel counting, calibration math (node --test)" ;;
    analytics)       echo "analytics/: aggregates, impact, grams/CO2e/water (node --test)" ;;
    capture)         echo "capture/: normalization, inbox bridge, calibration client (node --test)" ;;
    backend)         echo "backend/: API, storage, orchestration (node --test; builds data/vision/analytics)" ;;
    frontend)        echo "frontend/: dashboard components (vitest)" ;;
    frontend-build)  echo "frontend/: production build (tsc -b && vite build)" ;;
    db)              echo "db/spacetimedb: module typecheck" ;;
    tests)           echo "tests/: contract fixtures + cross-system integration (live E2E skipped)" ;;
    python)          echo "capture/uno-q: simulated board/laptop capture tests (unittest)" ;;
    scripts)         echo "bash -n/shellcheck deploy scripts, node --check, py_compile, JSON configs" ;;
    stack)           echo "LIVE deploy/local.sh up (starts or reuses SpacetimeDB, SAM 2.1, backend)" ;;
    seed)            echo "LIVE seed today's demo dinner for the test hall ($TEST_HALL)" ;;
    smoke)           echo "LIVE deploy/smoke.mjs: health, dashboard, 401s, one upload round trip (hall-smoke)" ;;
    e2e-flow)        echo "LIVE tests/e2e/demo-flow.test.mjs (its own hall-e2e-<time>)" ;;
    e2e-scrap)       echo "LIVE tests/e2e/scrap-live.test.mjs on $TEST_SERVICE" ;;
    e2e-calibration) echo "LIVE tests/e2e/calibration-live.test.mjs (hall-e2e-cal; settings restored)" ;;
    demo)            echo "LIVE python3 demo.py --simulate --yes --no-open --hall $TEST_HALL" ;;
  esac
}

usage() { sed -n "2,33p" "$0" | sed 's/^# \{0,1\}//'; }

# ------------------------------------------------------------------ arguments

LIVE=0; ONLY=""; SKIP=""; INSTALL=0; FAIL_FAST=0; VERBOSE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --live) LIVE=1 ;;
    --only) shift; ONLY="${1:-}"; [ -n "$ONLY" ] || { echo "--only needs a list of suites" >&2; exit 2; } ;;
    --only=*) ONLY="${1#--only=}" ;;
    --skip) shift; SKIP="${1:-}" ;;
    --skip=*) SKIP="${1#--skip=}" ;;
    --install) INSTALL=1 ;;
    --keep-going) FAIL_FAST=0 ;;
    --fail-fast) FAIL_FAST=1 ;;
    -v|--verbose) VERBOSE=1 ;;
    --list)
      for s in $OFFLINE_SUITES $LIVE_SUITES; do printf '  %-16s %s\n' "$s" "$(describe "$s")"; done
      exit 0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

in_list() { case ",$2," in *",$1,"*) return 0 ;; esac; return 1; }
for s in $(echo "$ONLY,$SKIP" | tr ',' ' '); do
  case " $OFFLINE_SUITES $LIVE_SUITES " in *" $s "*) ;; *) echo "unknown suite: $s (see --list)" >&2; exit 2 ;; esac
done

SELECTED=""
for s in $OFFLINE_SUITES $LIVE_SUITES; do
  if [ -n "$ONLY" ]; then in_list "$s" "$ONLY" || continue
  else case " $LIVE_SUITES " in *" $s "*) [ "$LIVE" = 1 ] || continue ;; esac
  fi
  in_list "$s" "$SKIP" && continue
  SELECTED="$SELECTED $s"
done
[ -n "$SELECTED" ] || { echo "no suites selected" >&2; exit 2; }

# ------------------------------------------------------------------ output

if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; N=$'\033[0m'
else B=""; D=""; G=""; R=""; Y=""; N=""; fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_ROOT="$REPO/tests/.logs"
LOG_DIR="$LOG_ROOT/$STAMP"
mkdir -p "$LOG_DIR"
ln -sfn "$STAMP" "$LOG_ROOT/latest" 2>/dev/null || true

ROWS=""        # name|result|pass|fail|skip|seconds  (one per line)
ANY_FAIL=0
STACK_UP=""    # "", "yes", "no"
UPLOAD_STARTED=""   # pid of the upload website when this run started it

add_row() { ROWS="${ROWS}$1|$2|$3|$4|$5|$6
"; }

# Counts "pass fail skip" from a suite log (node --test, vitest, unittest, smoke, demo.py).
count() {
  local log="$1" kind="$2"
  case "$kind" in
    node)
      awk '/^(# |ℹ )pass /{p+=$3} /^(# |ℹ )(fail|cancelled) /{f+=$3} /^(# |ℹ )(skipped|todo) /{s+=$3}
           END{ if (p+f+s==0) print "- - -"; else print p+0, f+0, s+0 }' "$log" ;;
    vitest)
      perl -ne 'next unless /^\s*Tests\s+(.*)$/; my $l=$1; $p=$1 if $l=~/(\d+) passed/; $f=$1 if $l=~/(\d+) failed/;
                $s=$1 if $l=~/(\d+) skipped/; $hit=1; END { print $hit ? (($p//0)." ".($f//0)." ".($s//0)) : "- - -" }' "$log" ;;
    unittest)
      perl -ne '$n=$1 if /^Ran (\d+) tests?/; if (/^(OK|FAILED)\b(.*)/) { $st=$1; $r=$2;
                $f=0; $f+=$1 while $r=~/(?:failures|errors)=(\d+)/g; $s=0; $s+=$1 while $r=~/(?:skipped|expected failures)=(\d+)/g; }
                END { if (defined $n) { $f//=0; $s//=0; print $n-$f-$s, " $f $s" } else { print "- - -" } }' "$log" ;;
    smoke)
      perl -ne '$p++ if /^PASS /; $f++ if /^FAIL /; $s++ if /^(SKIP|WARN) /; END { print +($p//0)." ".($f//0)." ".($s//0) }' "$log" ;;
    demo)
      perl -pe 's/\e\[[0-9;]*m//g' "$log" | perl -ne 'if (/(\d+) passed\s+(\d+) warnings\s+(\d+) failed/) { ($p,$w,$f)=($1,$2,$3) }
                END { print defined $p ? "$p $f $w" : "- - -" }' ;;
    checks)
      perl -ne '$p++ if /^ok /; $f++ if /^not ok /; $s++ if /^skip /; END { print +($p//0)." ".($f//0)." ".($s//0) }' "$log" ;;
    *) echo "- - -" ;;
  esac
}

# Load the same secrets the stack's backend uses (deploy/.run/local-secrets.env, then .env) and
# point every client at the local stack. Values are exported for child processes, never printed.
live_env() {
  set -a
  # shellcheck disable=SC1091
  [ -f "$RUN_DIR/local-secrets.env" ] && . "$RUN_DIR/local-secrets.env"
  # shellcheck disable=SC1091
  [ -f "$REPO/.env" ] && . "$REPO/.env"
  set +a
  export SCRAP_API_URL="$API_URL" API_URL="$API_URL"
}

# Replace any secret value that reached a log with [REDACTED:<NAME>].
redact() {
  ( live_env 2>/dev/null
    # shellcheck disable=SC2086
    export REDACT_VARS="$SECRET_VARS"
    perl -pi -e 'BEGIN { for my $k (split / /, $ENV{REDACT_VARS}) { my $v = $ENV{$k};
                   push @r, [$k, $v] if defined $v && length($v) >= 6 } }
                 for my $x (@r) { s/\Q$x->[1]\E/[REDACTED:$x->[0]]/g }' "$1" )
}

# run_suite <name> <count-kind> <live 0|1> <command...>
run_suite() {
  local name="$1" kind="$2" live="$3"; shift 3
  local log="$LOG_DIR/$name.log" start end secs rc p f s result
  printf '%s▶ %-16s%s %s\n' "$B" "$name" "$N" "$D$(describe "$name")$N"
  start="$(date +%s)"
  {
    echo "# $name: $*"
    echo "# started $(date -u +%Y-%m-%dT%H:%M:%SZ) in $REPO"
  } > "$log"
  if [ "$VERBOSE" = 1 ]; then
    ( if [ "$live" = 1 ]; then live_env; else unset SCRAP_E2E; fi; "$@" ) < /dev/null 2>&1 | tee -a "$log"
    rc="${PIPESTATUS[0]}"
  else
    ( if [ "$live" = 1 ]; then live_env; else unset SCRAP_E2E; fi; "$@" ) < /dev/null >> "$log" 2>&1
    rc=$?
  fi
  end="$(date +%s)"; secs=$((end - start))
  redact "$log"
  read -r p f s <<EOF
$(count "$log" "$kind")
EOF
  if [ "$rc" = 0 ] && { [ "$f" = "-" ] || [ "$f" = 0 ]; }; then result=PASS
  else result=FAIL; ANY_FAIL=1; fi
  add_row "$name" "$result" "$p" "$f" "$s" "$secs"
  if [ "$result" = PASS ]; then
    printf '  %sPASS%s %ss  %s\n' "$G" "$N" "$secs" "$D$(summary "$p" "$f" "$s")$N"
  else
    printf '  %sFAIL%s %ss (exit %s)  %s  log: %s\n' "$R" "$N" "$secs" "$rc" "$(summary "$p" "$f" "$s")" "${log#"$REPO"/}"
    tail -n 15 "$log" | sed 's/^/    │ /'
  fi
  [ "$result" = PASS ]
}

in_dir() { local dir="$1"; shift; cd "$dir" && "$@"; }

summary() { [ "$1" = "-" ] && { echo ""; return; }; echo "$1 passed, $2 failed, $3 skipped"; }

skip_suite() {
  add_row "$1" SKIP - - - 0
  printf '%s▶ %-16s%s %sSKIP%s %s\n' "$B" "$1" "$N" "$Y" "$N" "$2"
}

print_table() {
  local total=0 name result p f s secs color
  echo
  printf '%s%-16s %-6s %6s %6s %6s %8s%s\n' "$B" SUITE RESULT PASS FAIL SKIP TIME "$N"
  while IFS='|' read -r name result p f s secs; do
    [ -n "$name" ] || continue
    case "$result" in PASS) color="$G" ;; FAIL) color="$R" ;; *) color="$Y" ;; esac
    printf '%-16s %s%-6s%s %6s %6s %6s %7ss\n' "$name" "$color" "$result" "$N" "$p" "$f" "$s" "$secs"
    total=$((total + secs))
  done <<EOF
$ROWS
EOF
  printf '%-16s %-6s %6s %6s %6s %7ss\n' total "" "" "" "" "$total"
  echo "${D}logs: ${LOG_DIR#"$REPO"/}/${N}"
  if [ "$ANY_FAIL" = 1 ]; then echo "${R}${B}FAILED${N}"; else echo "${G}${B}ALL PASSED${N}"; fi
}

trap 'echo; echo "${Y}interrupted${N}"; print_table; exit 130' INT TERM

# ------------------------------------------------------------------ suites

suite_install() {
  local pkg did=0
  for pkg in $PACKAGES; do
    if [ "$INSTALL" = 1 ] || [ ! -d "$REPO/$pkg/node_modules" ]; then
      echo "== npm ci in $pkg"
      (cd "$REPO/$pkg" && npm ci --no-audit --no-fund) || { echo "not ok npm ci in $pkg"; return 1; }
      echo "ok npm ci in $pkg"; did=1
    else
      echo "skip $pkg (node_modules present; --install to reinstall)"
    fi
  done
  [ "$did" = 1 ] || echo "nothing to install"
}

check() { # check <label> <command...>: one "ok"/"not ok" line per check
  local label="$1"; shift
  if "$@" > "$LOG_DIR/.check.out" 2>&1; then echo "ok $label"
  else echo "not ok $label"; sed 's/^/    /' "$LOG_DIR/.check.out"; CHECK_FAIL=1; fi
}

suite_scripts() {
  local f
  CHECK_FAIL=0
  for f in deploy/*.sh test-all.sh; do check "bash -n $f" bash -n "$f"; done
  if command -v shellcheck >/dev/null; then
    for f in deploy/*.sh test-all.sh; do check "shellcheck $f" shellcheck -S warning "$f"; done
  else
    echo "skip shellcheck (not installed: brew install shellcheck)"
  fi
  for f in deploy/*.mjs capture/scripts/*.mjs backend/scripts/*.mjs tests/e2e/*.mjs; do
    [ -f "$f" ] && check "node --check $f" node --check "$f"
  done
  for f in demo.py capture/uno-q/*.py capture/scripts/*.py; do
    [ -f "$f" ] && check "py_compile $f" "$PYTHON" -c 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])' "$f"
  done
  check "demo.py --list" "$PYTHON" demo.py --list
  for f in deploy/*.json; do
    [ -f "$f" ] && check "JSON $f" node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f"
  done
  for f in deploy/*.plist.example; do
    [ -f "$f" ] && command -v plutil >/dev/null && check "plutil -lint $f" plutil -lint "$f"
  done
  [ "$CHECK_FAIL" = 0 ]
}

suite_seed() {
  local seed_file="$LOG_DIR/seed-$TEST_HALL.json"
  # backend/scripts/seed.mjs seeds its file's hallId: only the live dinner, for the test hall.
  printf '{"hallId":"%s","hallTimezone":"America/Detroit","menus":[],"referencePortions":[],"portionsServed":[]}\n' \
    "$TEST_HALL" > "$seed_file"
  SEED_FILE="$seed_file" SCRAP_RUN_DIR="$RUN_DIR" "$REPO/deploy/local.sh" seed "--live-dinner=$TODAY"
}

# demo.py's upload_site step needs the upload website; demo runs with --no-start, so start it here
# (or reuse a running one). Like the stack, it is left running.
ensure_upload_site() {
  local url="http://127.0.0.1:$UPLOAD_PORT/api/foods" log="$LOG_DIR/upload-site.log" _
  curl -fsS -m 3 -o /dev/null "$url" 2>/dev/null && return 0
  UPLOAD_DEMO_PORT="$UPLOAD_PORT" node "$REPO/upload_demo/server.mjs" > "$log" 2>&1 < /dev/null &
  UPLOAD_STARTED=$!
  for _ in $(seq 1 40); do
    curl -fsS -m 3 -o /dev/null "$url" 2>/dev/null && {
      echo "  ${D}started the upload website on :$UPLOAD_PORT (pid $UPLOAD_STARTED, log ${log#"$REPO"/})${N}"; return 0; }
    kill -0 "$UPLOAD_STARTED" 2>/dev/null || break
    sleep 0.5
  done
  echo "  ${Y}the upload website did not start; see ${log#"$REPO"/}${N}"
  UPLOAD_STARTED=""
}

stack_gate() { # live suites after `stack` need it up
  if [ "$STACK_UP" = no ]; then skip_suite "$1" "the local stack is not up (see the stack log)"; return 1; fi
  return 0
}

echo "${B}ScrapSaver test-all${N} ${D}($(node --version 2>/dev/null || echo 'node missing'), $("$PYTHON" --version 2>&1), $([ "$LIVE" = 1 ] && echo live || echo offline))${N}"
echo "${D}suites:${SELECTED}${N}"
echo

for suite in $SELECTED; do
  ok=0
  case "$suite" in
    install)        run_suite install checks 0 suite_install && ok=1 ;;
    data|vision|analytics|capture|backend)
                    run_suite "$suite" node 0 in_dir "$REPO/$suite" npm test && ok=1 ;;
    frontend)       run_suite frontend vitest 0 in_dir "$REPO/frontend" npm test && ok=1 ;;
    frontend-build) run_suite frontend-build none 0 in_dir "$REPO/frontend" npm run build && ok=1 ;;
    db)             run_suite db none 0 in_dir "$REPO/db/spacetimedb" npm run typecheck && ok=1 ;;
    tests)          run_suite tests node 0 in_dir "$REPO/tests" npm test && ok=1 ;;
    python)         run_suite python unittest 0 "$PYTHON" -m unittest discover -s capture/uno-q -v && ok=1 ;;
    scripts)        run_suite scripts checks 0 suite_scripts && ok=1 ;;
    stack)
      if run_suite stack none 0 env SCRAP_RUN_DIR="$RUN_DIR" API_PORT="$API_PORT" "$REPO/deploy/local.sh" up; then
        STACK_UP=yes; ok=1
      else STACK_UP=no; fi ;;
    seed)           stack_gate seed && { run_suite seed none 1 suite_seed && ok=1; } ;;
    smoke)          stack_gate smoke && { run_suite smoke smoke 1 node "$REPO/deploy/smoke.mjs" "$API_URL" && ok=1; } ;;
    e2e-flow)       stack_gate e2e-flow && { run_suite e2e-flow node 1 env SCRAP_E2E=1 \
                      node --test "$REPO/tests/e2e/demo-flow.test.mjs" && ok=1; } ;;
    e2e-scrap)      stack_gate e2e-scrap && { run_suite e2e-scrap node 1 env SCRAP_E2E=1 SCRAP_E2E_SERVICE="$TEST_SERVICE" \
                      SCRAP_E2E_PHOTOS="${SCRAP_E2E_PHOTOS:-2}" node --test "$REPO/tests/e2e/scrap-live.test.mjs" && ok=1; } ;;
    e2e-calibration) stack_gate e2e-calibration && { run_suite e2e-calibration node 1 env SCRAP_E2E=1 \
                      SCRAP_E2E_SERVICE="$TEST_SERVICE" node --test "$REPO/tests/e2e/calibration-live.test.mjs" && ok=1; } ;;
    demo)           stack_gate demo && { ensure_upload_site; run_suite demo demo 1 "$PYTHON" "$REPO/demo.py" --simulate --yes --no-open --no-start \
                      --hall "$TEST_HALL" --api "$API_URL" && ok=1; } ;;
  esac
  if [ "$ok" = 0 ] && [ "$FAIL_FAST" = 1 ] && [ "$ANY_FAIL" = 1 ]; then
    echo "${R}--fail-fast: stopping after $suite${N}"; break
  fi
done

rm -f "$LOG_DIR/.check.out"
print_table
if [ "$STACK_UP" = yes ]; then
  echo "${D}The local stack was left running (deploy/local.sh status; stop: deploy/local.sh down).${N}"
fi
if [ -n "$UPLOAD_STARTED" ]; then
  echo "${D}The upload website was left running on :$UPLOAD_PORT (stop: kill $UPLOAD_STARTED).${N}"
fi
[ "$ANY_FAIL" = 0 ]
