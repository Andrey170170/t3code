#!/usr/bin/env bash
# Trellis parity demo (docs/v1/t3.md in the Trellis repo, "Parity demo"):
# drives an isolated dev T3 on orchestration V2 against a development Trellis
# through playwright-cli, checks each step against real state (Trellis CLI,
# the dev T3 database read-only, provider logs, files) and prints a checklist.
#
#   scripts/demo-trellis.sh [out-dir]       (default /tmp/trellis-demo)
#
# Each run writes to a new <out-dir>/<run-id>/ and points <out-dir>/latest at
# it; nothing else in <out-dir> is touched.
#
# Needs: a running development Trellis (TRELLIS_DEV_ROOT, default
# /trellis/dev-t3; it must be a /trellis/dev-* root with the `dev` base),
# playwright-cli with a cached Chromium, Codex and Claude logins, `vp i` done
# in this checkout. It starts its own dev T3 with a fresh home in a temporary
# directory and stops only the processes it started. Costs a few Haiku turns
# and a few Codex turns.
set -uo pipefail

die() { echo "error: $*" >&2; exit 1; }
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT_BASE=$(realpath -m "${1:-/tmp/trellis-demo}")
TRELLIS_DEV_ROOT=${TRELLIS_DEV_ROOT:-/trellis/dev-t3}
TRELLIS_REPO=${TRELLIS_REPO:-$HOME/projects/trellis}
CLAUDE_MODEL_LABEL="Claude Haiku 4.5"
CODEX_MODEL_LABEL="GPT-6-Astra"
RUN_ID=$(date +%Y%m%d-%H%M%S)
WORK=$(mktemp -d "/tmp/trellis-demo-$RUN_ID-XXXX")
SESSION="trellis-demo-$$"
HOME_DIR=$WORK/t3home
DB=$HOME_DIR/userdata/statev2.sqlite
export PATH=$REPO/node_modules/.bin:$PATH

OUT=$OUT_BASE/$RUN_ID
[[ ! -e $OUT ]] || die "$OUT already exists"
mkdir -p "$OUT" "$WORK/pw/.playwright"
ln -sfn "$RUN_ID" "$OUT_BASE/latest"
echo '{"browser":{"browserName":"chromium","launchOptions":{"channel":"chromium"}}}' \
  >"$WORK/pw/.playwright/cli.config.json"

# Only ever a development Trellis: a failed `dev.sh env` must not leave an
# inherited (live) TRELLIS_* in place, so its status is checked and the
# result validated before anything talks to Trellis.
unset TRELLIS_ROOT TRELLIS_CONFIG TRELLIS_SOCKET TRELLIS_BIN
DEV_ENV=$(TRELLIS_DEV_ROOT=$TRELLIS_DEV_ROOT "$TRELLIS_REPO/scripts/dev.sh" env) ||
  die "dev.sh env failed for $TRELLIS_DEV_ROOT"
eval "$DEV_ENV"
TRELLIS_ROOT=$(realpath -m "${TRELLIS_ROOT:-}")
case $TRELLIS_ROOT in
  /trellis/dev-*) [[ $TRELLIS_ROOT != */*/*/* ]] || die "$TRELLIS_ROOT is not a /trellis/dev-* root" ;;
  *) die "refusing Trellis root '$TRELLIS_ROOT': only /trellis/dev-* roots" ;;
esac
for path in "${TRELLIS_SOCKET:-}" "${TRELLIS_BIN:-}"; do
  [[ $(realpath -m "$path") == "$TRELLIS_ROOT"/* ]] || die "'$path' is not under $TRELLIS_ROOT"
done
export TRELLIS_ROOT TRELLIS_SOCKET
HOST_NAME=$(hostname)

log() { printf '[%s] %s\n' "$(date +%T)" "$*" | tee -a "$OUT/demo.log" >&2; }
tr_() { "$TRELLIS_BIN" "$@"; }
sql() { sqlite3 -readonly "$DB" "$1"; }
js() { jq -Rn --arg v "$1" '$v'; }

# ---- checklist ----------------------------------------------------------
declare -a CHECKS=()
check() { # id, assertion, evidence, command...
  local id=$1 what=$2 evidence=$3
  shift 3
  local result=FAIL
  if "$@" >>"$OUT/demo.log" 2>&1; then result=PASS; fi
  CHECKS+=("$(printf '%-4s %-4s %s\n          evidence: %s' "$id" "$result" "$what" "$evidence")")
  log "check $id: $result - $what"
}
note() { CHECKS+=("$(printf '%-4s NOTE %s' "$1" "$2")"); }
CURRENT_STEP=setup
step() { CURRENT_STEP=$1; log "step $1: $2"; }
print_checklist() {
  {
    echo "${DEMO_TITLE:-Trellis parity demo}, run $RUN_ID ($(git -C "$REPO" rev-parse --short HEAD)), Trellis $TRELLIS_DEV_ROOT"
    echo "Models: Claude steps $CLAUDE_MODEL_LABEL; Codex steps $CODEX_MODEL_LABEL (Codex default)"
    echo
    printf '%s\n' "${CHECKS[@]}"
    [[ -n ${1:-} ]] && printf '\nABORTED in step %s: %s\nLater steps did not run.\n' "$CURRENT_STEP" "$1"
    echo
    echo "$(printf '%s\n' "${CHECKS[@]}" | grep -c ' PASS ') passed, $(printf '%s\n' "${CHECKS[@]}" | grep -c ' FAIL ') failed"
  } | tee "$OUT/checklist.txt"
}
# A failed UI action stops the run: continuing could send a prompt to the
# wrong thread (for example a host project instead of a new idea).
on_abort() {
  print_checklist "$(cat "$WORK/abort" 2>/dev/null)"
  exit 1
}
trap on_abort USR1
# Stops the run unless the path is inside the dev Trellis root.
guard_trellis_path() {
  [[ $1 == "$TRELLIS_DEV_ROOT"/workspaces/* ]] && return 0
  echo "the thread is not in a Trellis workspace ('$1'); stopping before more prompts go there" >"$WORK/abort"
  on_abort
}

# ---- dev T3 -------------------------------------------------------------
T3_PGID=
start_t3() {
  local logfile=$WORK/dev-$1.log
  rm -f "$WORK/dev.pid"
  # setsid makes the shell a group leader; exec keeps its pid, so the pid is the group.
  (cd "$REPO" && TRELLIS_SOCKET=$TRELLIS_SOCKET setsid bash -c \
    'echo $$ >"$1"; exec vp run dev --home-dir "$2"' _ "$WORK/dev.pid" "$HOME_DIR" >"$logfile" 2>&1 &)
  for _ in $(seq 1 20); do [[ -s $WORK/dev.pid ]] && break; sleep 0.5; done
  T3_PGID=$(<"$WORK/dev.pid")
  for _ in $(seq 1 120); do
    grep -q "Listening on" "$logfile" && break
    sleep 1
  done
  WEB_PORT=$(sed -n 's/.*\[dev-runner\].* webPort=\([0-9]*\).*/\1/p' "$logfile" | head -1)
  ORIGIN=http://localhost:$WEB_PORT
  log "dev T3 ($1) pgid $T3_PGID at $ORIGIN"
}
stop_t3() {
  [[ -n $T3_PGID ]] || return 0
  kill -TERM -- "-$T3_PGID" 2>/dev/null
  for _ in $(seq 1 30); do
    ps -eo pgid= | grep -qw "$T3_PGID" || break
    sleep 1
  done
  ps -eo pgid= | grep -qw "$T3_PGID" && kill -KILL -- "-$T3_PGID" 2>/dev/null
  T3_PGID=
}
cleanup() {
  stop_t3
  mkdir -p "$OUT/t3-logs" && cp -r "$HOME_DIR/userdata/logs/provider" "$OUT/t3-logs/" 2>/dev/null
  (cd "$WORK/pw" && playwright-cli -s="$SESSION" close >/dev/null 2>&1)
  # Evidence without credentials: the startup log prints a pairing token.
  for f in "$WORK"/dev-*.log; do
    [[ -f $f ]] && sed -E 's/(token=)[A-Za-z0-9]+/\1REDACTED/g' "$f" >"$OUT/t3-$(basename "$f")"
  done
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---- browser ------------------------------------------------------------
pwc() { # JS function `async page => ...` on stdin; prints its JSON result
  local f
  f=$(mktemp "$WORK/pw-XXXX.js")
  cat >"$f"
  # A full load of the dev app fetches about 3000 unbundled modules, and
  # Chromium allows 2700 outstanding loaders per renderer. Loaders of earlier
  # documents stay counted until V8 collects them, so after a few reloads a
  # load fails (net::ERR_INSUFFICIENT_RESOURCES) and the renderer crashes.
  # Collecting garbage before each navigation keeps that from piling up.
  local fn
  fn=$(<"$f")
  if [[ $fn == *.goto\(* ]]; then
    printf 'async page => {\n  const cdp = await page.context().newCDPSession(page);\n  await cdp.send("HeapProfiler.collectGarbage");\n  await cdp.detach();\n  return await (%s)(page);\n}\n' "$fn" >"$f"
  fi
  local out rc
  out=$(cd "$WORK/pw" && playwright-cli -s="$SESSION" --raw run-code --filename="$f" 2>&1)
  rc=$?
  printf '%s\n' "$out" >>"$WORK/pw.log"
  if ((rc != 0)); then
    shot "error-step-$CURRENT_STEP"
    { echo "UI action failed:"; sed -n '/### Error/,+3p' <<<"$out"; } | tee "$WORK/abort" >&2
    kill -USR1 $$
    return 1
  fi
  printf '%s\n' "$out"
}
shot() { (cd "$WORK/pw" && playwright-cli -s="$SESSION" screenshot --filename="$OUT/$1.png" >/dev/null); }
path_now() { (cd "$WORK/pw" && playwright-cli -s="$SESSION" --raw eval "() => location.pathname") | tr -d '"'; }
goto() {
  pwc <<JS >/dev/null
async page => {
  await page.goto($(js "$ORIGIN$1"));
  await page.locator('main').first().waitFor({ timeout: 120000 });
  await page.waitForTimeout(1500);
}
JS
}
cookie() { (cd "$WORK/pw" && playwright-cli -s="$SESSION" cookie-list) | grep -o '^t3_session[^ ]*' | head -1; }
rpc() { T3_DEMO_COOKIE=$(cookie) node "$REPO/apps/server/scripts/demo-trellis-rpc.ts" "$ORIGIN" "$@"; }

palette() { # open the command palette, run the command whose title matches
  pwc <<JS >/dev/null
async page => {
  // A focused terminal would take the shortcut.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Command palette' }).waitFor();
  await page.keyboard.type($(js "$1"));
  await page.getByRole('option', { name: new RegExp('^' + $(js "$1")) }).first().click();
  await page.waitForTimeout(800);
}
JS
}
select_model() { # provider tab, option label prefix
  pwc <<JS
async page => {
  await page.getByRole('button', { name: /^(GPT-|Claude )/ }).last().click();
  await page.getByRole('button', { name: $(js "$1"), exact: true }).click();
  const option = page.getByRole('option', { name: new RegExp('^' + $(js "$2") + ' ') });
  if ((await option.count()) === 0) await page.getByRole('option', { name: /^Legacy models/ }).click();
  await option.first().click();
  await page.waitForTimeout(500);
  return await page.getByRole('button', { name: /^(GPT-|Claude )/ }).last().innerText();
}
JS
}
send() { # type a message in the composer and send it; prints the thread id
  pwc <<JS >/dev/null
async page => {
  const composer = page.locator('[contenteditable=true]').first();
  await composer.waitFor({ timeout: 120000 });
  await composer.click();
  await page.keyboard.type($(js "$1"));
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => /^\/[0-9a-f-]{36}\/[^/]+\$/.test(url.pathname), { timeout: 120000 });
}
JS
  basename "$(path_now)"
}
thread_menu() { # thread title; open its action menu and the Move to project submenu
  pwc <<JS >/dev/null
async page => {
  // The menu acts on the open thread, so make sure it is this one.
  const heading = page.getByRole('navigation', { name: 'Thread breadcrumb' }).getByRole('heading', { name: $(js "$1"), exact: true });
  try {
    await heading.waitFor({ timeout: 30000 });
  } catch {
    await page.reload();
    await heading.waitFor({ timeout: 60000 });
  }
  await page.getByRole('button', { name: 'Thread actions for ' + $(js "$1"), exact: true }).click();
  await page.getByRole('button', { name: 'Move to project', exact: true }).hover();
  await page.waitForTimeout(1000);
}
JS
}

# ---- state --------------------------------------------------------------
run_status() { sql "select status from orchestration_v2_projection_runs where thread_id='$1' and ordinal=$2"; }
wait_run() { # thread, ordinal, timeout seconds; prints the final status
  local status=
  for _ in $(seq 1 "${3:-300}"); do
    status=$(run_status "$1" "$2")
    case $status in "" | queued | preparing | starting | running | waiting) sleep 1 ;; *) break ;; esac
  done
  echo "$status"
}
thread_root() { sql "select p.workspace_root from orchestration_v2_projection_threads t join projection_projects p on p.project_id=t.project_id where t.thread_id='$1'"; }
thread_project() { sql "select project_id from orchestration_v2_projection_threads where thread_id='$1'"; }
thread_archived() { sql "select coalesce(archived_at,'') from orchestration_v2_projection_threads where thread_id='$1'"; }
project_title() { sql "select title from projection_projects where project_id='$1'"; }
project_by_root() { sql "select project_id from projection_projects where workspace_root='$1' and deleted_at is null"; }
item_at() { tr_ --json ls | jq -c --arg p "$1" '.[] | select(.path==$p)'; }
last_reply() { sql "select json_extract(payload_json,'\$.text') from orchestration_v2_projection_messages where thread_id='$1' and role='assistant' order by created_at desc limit 1"; }
provider_log() { cat "$HOME_DIR"/userdata/logs/provider/events."$1".log 2>/dev/null; }
page_text() { pwc <<<'async page => await page.locator("body").innerText()' | jq -r .; }

# Sourced for its helpers (scripts/demo-graduation.sh): stop before the steps.
[[ ${DEMO_TRELLIS_HELPERS_ONLY:-} == 1 ]] && return 0

# ---- start --------------------------------------------------------------
log "out $OUT, work $WORK, Trellis $TRELLIS_DEV_ROOT"
tr_ base ls | grep -qx dev || { log "the dev base is missing on $TRELLIS_DEV_ROOT"; exit 1; }
start_t3 1
PAIR=$(sed -n 's/.*pairingUrl: \(.*\)/\1/p' "$WORK/dev-1.log" | head -1)
for _ in $(seq 1 30); do
  [[ -n $PAIR ]] && break
  sleep 1
  PAIR=$(sed -n 's/.*pairingUrl: \(.*\)/\1/p' "$WORK/dev-1.log" | head -1)
done
(cd "$WORK/pw" && playwright-cli -s="$SESSION" open "$PAIR" >/dev/null && playwright-cli -s="$SESSION" resize 1440 900 >/dev/null)
# Pairing finishes when the app leaves /pair with a session cookie.
pwc <<'JS' >/dev/null
async page => {
  await page.waitForURL((url) => !url.pathname.startsWith('/pair'), { timeout: 180000 });
  await page.locator('main').first().waitFor({ timeout: 180000 });
}
JS
ENV_ID=$(cat "$HOME_DIR/userdata/environment-id")

# ---- 1. Settings -> Trellis ---------------------------------------------
step 1 "turn on Trellis"
S1=$(pwc <<JS
async page => {
  await page.goto($(js "$ORIGIN/settings/trellis"));
  const toggle = page.getByRole('switch', { name: 'Use Trellis workspaces' });
  await toggle.waitFor({ timeout: 180000 });
  if (!(await toggle.isChecked())) await toggle.click();
  const status = page.getByText(/^Connected · workspaces in/);
  await status.waitFor({ timeout: 30000 });
  return await status.innerText();
}
JS
)
shot 01-settings-trellis
echo "$S1" >"$OUT/01-settings-trellis.log"
c1() { grep -q "Connected · workspaces in $TRELLIS_DEV_ROOT" <<<"$S1" && jq -e '.trellis.enabled == true' "$HOME_DIR/userdata/settings.json"; }
check 1 "Use Trellis workspaces is on and the row shows the instance reachable ($TRELLIS_DEV_ROOT)" \
  "$OUT/01-settings-trellis.png" \
  c1

# ---- 2. New idea --------------------------------------------------------
step 2 "new idea"
goto /
palette "New idea"
pwc <<'JS' >/dev/null
async page => {
  await page.waitForURL((url) => url.pathname.startsWith('/draft/'), { timeout: 30000 });
  await page.getByRole('heading', { name: 'What should we build in New idea?' }).waitFor({ timeout: 30000 });
}
JS
select_model Claude "$CLAUDE_MODEL_LABEL" >"$OUT/02-model.log"
T2_SENT=$(date +%s)
IDEA_THREAD=$(send "Create hello.py that prints the date")
IDEA_RUN1=$(wait_run "$IDEA_THREAD" 1 300)
IDEA_PATH=$(thread_root "$IDEA_THREAD")
guard_trellis_path "$IDEA_PATH"
IDEA_NAME=
for _ in $(seq 1 90); do
  IDEA_NAME=$(item_at "$IDEA_PATH" | jq -r 'select(.name_source != "default") | .name')
  [[ -n $IDEA_NAME ]] && page_text | grep -qF "$IDEA_NAME" && break
  IDEA_NAME=
  sleep 1
done
T2_NAMED=$(( $(date +%s) - T2_SENT ))
shot 02-new-idea
{
  echo "thread $IDEA_THREAD, run 1: $IDEA_RUN1"
  echo "idea path: $IDEA_PATH"
  echo "Trellis item: $(item_at "$IDEA_PATH")"
  echo "named in ${T2_NAMED}s after sending"
  echo "--- hello.py"; cat "$IDEA_PATH/hello.py"
} >"$OUT/02-new-idea.log" 2>&1
c2a() { [[ $IDEA_RUN1 == completed && $IDEA_PATH == "$TRELLIS_DEV_ROOT"/workspaces/*/project/idea-* && -f $IDEA_PATH/hello.py ]]; }
c2b() { [[ -n $IDEA_NAME && $T2_NAMED -le 60 ]]; }
check 2a "The first message created a Trellis idea (thread's project is an idea folder) and the turn completed" \
  "$OUT/02-new-idea.log" \
  c2a
check 2b "The sidebar shows the idea under its generated name within a minute (\"$IDEA_NAME\", ${T2_NAMED}s)" \
  "$OUT/02-new-idea.png" c2b

# ---- 3. Claude turn with a checkpoint -----------------------------------
step 3 "install rich"
send "Install rich with pip and use it for colour" >/dev/null
IDEA_RUN2=$(wait_run "$IDEA_THREAD" 2 300)
sleep 3
shot 03-rich-turn
REF2=$(sql "select ref from trellis_checkpoint_refs where target='$IDEA_PATH' and ref like '%/ordinal/2'")
SNAP2=$(sql "select snapshot_id from trellis_checkpoint_refs where ref='$REF2'")
CP2=$(sql "select status from orchestration_v2_projection_checkpoints where thread_id='$IDEA_THREAD' and ordinal_within_scope=2")
{
  echo "run 2: $IDEA_RUN2; T3 checkpoint 2: $CP2"
  echo "ref: $REF2 -> snapshot $SNAP2"
  echo "--- trellis snapshots --target $IDEA_PATH"; tr_ snapshots --target "$IDEA_PATH"
  echo "--- the snapshot"; tr_ --json snapshots --target "$IDEA_PATH" | jq --arg s "$SNAP2" '.[] | select(.id==$s)'
  echo "--- hello.py now"; cat "$IDEA_PATH/hello.py"
  echo "--- hello.py at the ref"; git -C "$IDEA_PATH" show "$REF2:hello.py"
} >"$OUT/03-snapshots.log" 2>&1
c3a() { [[ $IDEA_RUN2 == completed && $CP2 == ready ]] && grep -q rich "$IDEA_PATH/hello.py"; }
c3b() {
  [[ -n $SNAP2 ]] &&
    tr_ --json snapshots --target "$IDEA_PATH" | jq -e --arg s "$SNAP2" --arg r "$REF2" 'any(.[]; .id==$s and .kind=="turn" and .turn==$r)' &&
    git -C "$IDEA_PATH" show "$REF2:hello.py" | grep -q rich
}
check 3a "The turn ended with a ready checkpoint and hello.py imports rich" "$OUT/03-rich-turn.png" \
  c3a
check 3b "trellis snapshots --target <idea> shows the turn snapshot tagged with the checkpoint ref" \
  "$OUT/03-snapshots.log" \
  c3b

# ---- 4. Revert ----------------------------------------------------------
step 4 "revert the rich turn"
pwc <<'JS' >"$OUT/04-revert-notice.log"
async page => {
  await page.getByText('Install rich with pip and use it for colour').first().hover();
  await page.getByRole('button', { name: 'Edit from here' }).nth(1).click();
  await page.getByRole('button', { name: 'Revert files too' }).click();
  const notice = page.getByText(/Restored the files from Trellis snapshot/);
  await notice.waitFor({ timeout: 120000 });
  return await notice.innerText();
}
JS
shot 04-revert
UNDO=$(grep -o 'snap-[a-z0-9]*' "$OUT/04-revert-notice.log" | tail -1)
{
  echo "--- hello.py after revert"; cat "$IDEA_PATH/hello.py"
  echo "--- runs"; sql "select ordinal, status from orchestration_v2_projection_runs where thread_id='$IDEA_THREAD'"
  echo "--- undo snapshot $UNDO"; tr_ --json snapshots --target "$IDEA_PATH" | jq --arg s "$UNDO" '.[] | select(.id==$s)'
} >>"$OUT/04-revert-notice.log" 2>&1
c4a() { [[ -f $IDEA_PATH/hello.py ]] && ! grep -q rich "$IDEA_PATH/hello.py"; }
c4b() {
  [[ $(run_status "$IDEA_THREAD" 2) == rolled_back ]] && grep -q 'trellis rollback' "$OUT/04-revert-notice.log" &&
    tr_ --json snapshots --target "$IDEA_PATH" | jq -e --arg s "$UNDO" 'any(.[]; .id==$s and .kind=="pre-rollback")'
}
check 4a "After the revert hello.py no longer imports rich" "$OUT/04-revert-notice.log" \
  c4a
check 4b "The run is rolled back and the thread shows the undo-snapshot notice naming a pre-rollback snapshot" \
  "$OUT/04-revert.png" \
  c4b

# ---- 5. Codex project, restart, resume ----------------------------------
step 5 "new Trellis project, Codex, restart"
PROJECT_NAME="demo5-$RUN_ID"
palette "New Trellis project"
pwc <<JS >/dev/null
async page => {
  await page.getByRole('textbox', { name: 'Name (optional)' }).fill($(js "$PROJECT_NAME"));
  await page.getByRole('textbox', { name: 'Base (optional)' }).fill('dev');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL((url) => url.pathname.startsWith('/draft/'), { timeout: 180000 });
  await page.locator('[contenteditable=true]').first().waitFor({ timeout: 120000 });
}
JS
select_model Codex "$CODEX_MODEL_LABEL" >"$OUT/05-model.log"
B_THREAD=$(send "Write a README")
B_RUN1=$(wait_run "$B_THREAD" 1 300)
B_PATH=$(thread_root "$B_THREAD")
guard_trellis_path "$B_PATH"
B_PROJECT=$(thread_project "$B_THREAD")
cp "$B_PATH/README.md" "$WORK/readme-1.md" 2>/dev/null
shot 05a-readme
log "restarting the dev T3"
stop_t3
start_t3 2
pwc <<'JS' >/dev/null
async page => {
  await page.reload();
  await page.locator('[contenteditable=true]').first().waitFor({ timeout: 180000 });
}
JS
send "Add a second paragraph" >/dev/null
B_RUN2=$(wait_run "$B_THREAD" 2 300)
sleep 2
shot 05b-after-restart
START_LINE=$(provider_log "$B_THREAD" | grep -m1 '"method":"thread/start"')
RESUME_LINE=$(provider_log "$B_THREAD" | grep -m1 '"method":"thread/resume"')
CODEX_THREAD=$(provider_log "$B_THREAD" | grep -m1 '"method":"thread/started"' | grep -o '"thread":{"id":"[^"]*"' | sed 's/.*"id":"//;s/"//')
{
  echo "project $PROJECT_NAME at $B_PATH (item: $(item_at "$B_PATH" | jq -c '{id,name,base: .workspaces[0].base}'))"
  echo "runs: 1 $B_RUN1, 2 $B_RUN2; Codex thread $CODEX_THREAD"
  echo "--- thread/resume after the restart (T3 provider log, instructions cut)"
  echo "$RESUME_LINE" | sed -E 's/"developer_instructions":"[^"]*"/"developer_instructions":"..."/' | cut -c1-600
  echo "--- README before the restart"; cat "$WORK/readme-1.md"
  echo "--- README after"; cat "$B_PATH/README.md"
} >"$OUT/05-codex-resume.log" 2>&1
FIRST_PARA=$(grep -v '^#' "$WORK/readme-1.md" | grep -m1 .)
c5a() {
  [[ $B_RUN1 == completed && -s $WORK/readme-1.md ]] &&
    tr_ --json ls | jq -e --arg p "$B_PATH" 'any(.[]; .path==$p and .workspaces[0].base=="dev")'
}
c5b() {
  [[ -n $CODEX_THREAD ]] && grep -qF "\"cwd\":\"$B_PATH\"" <<<"$RESUME_LINE" &&
    grep -qF "\"threadId\":\"$CODEX_THREAD\"" <<<"$RESUME_LINE"
}
c5c() {
  [[ $B_RUN2 == completed && -n $FIRST_PARA ]] && grep -qF -- "$FIRST_PARA" "$B_PATH/README.md" &&
    (($(wc -l <"$B_PATH/README.md") > $(wc -l <"$WORK/readme-1.md")))
}
check 5a "The project uses base dev and Codex wrote README.md" "$OUT/05a-readme.png" \
  c5a
check 5b "After the restart the T3 log shows thread/resume of the same Codex thread with the workspace cwd" \
  "$OUT/05-codex-resume.log" \
  c5b
check 5c "The reply continues the README: the first paragraph is kept and the file grew" "$OUT/05b-after-restart.png" \
  c5c

# ---- 6. Preview and terminal --------------------------------------------
step 6 "static server, preview, terminal"
send "Start a static server on port 8000 with python" >/dev/null
B_RUN3=$(wait_run "$B_THREAD" 3 300)
sleep 3
shot 06a-server-turn
RESOLVED=$(rpc trellis.resolvePreviewUrl "{\"threadId\":\"$B_THREAD\",\"url\":\"http://localhost:8000/\"}" 2>>"$OUT/06-preview.log" | jq -r .url)
OPENED=$(rpc preview.open "{\"threadId\":\"$B_THREAD\",\"url\":\"http://localhost:8000/\"}" 2>>"$OUT/06-preview.log" | jq -r .navStatus.url)
HOST_THREAD=$(sql "select t.thread_id from orchestration_v2_projection_threads t join projection_projects p on p.project_id=t.project_id where p.workspace_root not like '$TRELLIS_DEV_ROOT/%' limit 1")
PASSTHROUGH=$(rpc trellis.resolvePreviewUrl "{\"threadId\":\"$HOST_THREAD\",\"url\":\"http://localhost:8000/\"}" 2>>"$OUT/06-preview.log" | jq -r .url)
PUBLISHED=$(tr_ --json previews | jq -r --arg w "$(item_at "$B_PATH" | jq -r .workspace_id)" '.[] | select(.workspace==$w and .port==8000) | .url')
RENDERED=$(pwc <<JS
async page => {
  const tab = await page.context().newPage();
  await tab.setViewportSize({ width: 1440, height: 900 });
  await tab.goto($(js "$RESOLVED"));
  await tab.screenshot({ path: $(js "$OUT/06b-preview.png") });
  const text = await tab.locator('body').innerText();
  await tab.close();
  return text;
}
JS
)
{
  echo "run 3: $B_RUN3"
  echo "trellis.resolvePreviewUrl(localhost:8000) in the Trellis thread -> $RESOLVED"
  echo "preview.open(localhost:8000) -> tab at $OPENED"
  echo "trellis previews for the workspace port 8000 -> $PUBLISHED"
  echo "resolvePreviewUrl in a host-project thread -> $PASSTHROUGH"
  echo "--- rendered page"; echo "$RENDERED" | jq -r . 2>/dev/null || echo "$RENDERED"
} >>"$OUT/06-preview.log"
c6a() { [[ -n $PUBLISHED && $RESOLVED == "$PUBLISHED" && $OPENED == "$PUBLISHED" && $PASSTHROUGH == http://localhost:8000/ ]]; }
c6b() { grep -q 'Directory listing' <<<"$RENDERED" && grep -q 'README.md' <<<"$RENDERED"; }
check 6a "localhost:8000 is rewritten to the workspace's published port (resolvePreviewUrl and preview.open), host threads pass through" \
  "$OUT/06-preview.log" \
  c6a
check 6b "The resolved preview renders the workspace's directory listing (README.md)" "$OUT/06b-preview.png" \
  c6b
pwc <<'JS' >/dev/null
async page => {
  await page.getByRole('button', { name: 'Toggle terminal drawer' }).click();
  const input = page.getByRole('textbox', { name: 'Terminal input' });
  await input.waitFor({ timeout: 60000 });
  await page.waitForTimeout(2000);
  await input.focus();
  await page.keyboard.type('hostname; pwd');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
}
JS
shot 06c-terminal
pwc <<'JS' >/dev/null
async page => { await page.getByRole('button', { name: 'Toggle terminal drawer' }).click(); }
JS
TERM_LOG=$(grep -l 'hostname; pwd' "$HOME_DIR"/userdata/logs/terminals/*.log 2>/dev/null | head -1)
TERM_OUT=$(sed 's/\x1b\][^\x07]*\x07//g; s/\x1b\[[0-9;?]*[a-zA-Z]//g; s/\r//g' "$TERM_LOG" 2>/dev/null | sed -n '/hostname; pwd/,$p' | sed -n '2,3p')
WS_HOST=$(tr_ exec --target "$B_PATH" hostname 2>/dev/null)
{
  echo "terminal output after 'hostname; pwd':"; echo "$TERM_OUT"
  echo "trellis exec hostname: $WS_HOST; host: $HOST_NAME; workspace path: $B_PATH"
} >"$OUT/06-terminal.log"
c6c() { [[ -n $WS_HOST && $(sed -n 1p <<<"$TERM_OUT") == "$WS_HOST" && $WS_HOST != "$HOST_NAME" && $(sed -n 2p <<<"$TERM_OUT") == "$B_PATH" ]]; }
check 6c "Terminal: hostname is the container's (not the host's), pwd is the host path" "$OUT/06c-terminal.png" \
  c6c
note 6 "Adaptation: the Browser panel is desktop-only, so the rewrite is checked over the RPC and the resolved URL is opened directly in Playwright."

# ---- 7. Find in Trellis -------------------------------------------------
step 7 "find in Trellis"
B_TITLE=$(project_title "$B_PROJECT")
goto "/$ENV_ID/$IDEA_THREAD"
palette "Find in Trellis"
pwc <<JS >/dev/null
async page => {
  await page.keyboard.type('README');
  await page.getByRole('option', { name: new RegExp('^' + $(js "$B_TITLE")) }).first().waitFor({ timeout: 30000 });
}
JS
shot 07a-find
pwc <<JS >/dev/null
async page => {
  await page.getByRole('option', { name: new RegExp('^' + $(js "$B_TITLE")) }).first().click();
  await page.waitForTimeout(2500);
}
JS
shot 07b-opened
FOUND_THREAD=$(basename "$(path_now)")
echo "found project '$B_TITLE'; opened thread $FOUND_THREAD in project $(thread_project "$FOUND_THREAD")" >"$OUT/07-find.log"
c7() { [[ -n $B_PROJECT && $(thread_project "$FOUND_THREAD") == "$B_PROJECT" ]]; }
check 7 "Find \"README\" lists the project (by its README) and selecting it opens it" "$OUT/07a-find.png, $OUT/07b-opened.png" \
  c7

# ---- 8. Clone click -----------------------------------------------------
step 8 "clone click"
palette "New Trellis project"
pwc <<'JS' >/dev/null
async page => {
  await page.getByRole('textbox', { name: 'Git URL (optional)' }).fill('https://github.com/pallets/click');
  await page.getByRole('textbox', { name: 'Base (optional)' }).fill('dev');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL((url) => url.pathname.startsWith('/draft/'), { timeout: 180000 });
  await page.locator('[contenteditable=true]').first().waitFor({ timeout: 180000 });
}
JS
select_model Codex "$CODEX_MODEL_LABEL" >"$OUT/08-model.log"
C_THREAD=$(send "List the top-level files in this project")
C_RUN1=$(wait_run "$C_THREAD" 1 300)
sleep 2
shot 08-click
C_PATH=$(thread_root "$C_THREAD")
guard_trellis_path "$C_PATH"
C_PROJECT=$(thread_project "$C_THREAD")
C_REPLY=$(last_reply "$C_THREAD")
# The clone is identified by the path its thread runs in; Trellis may give a
# repeated clone a distinct name, so the name is read rather than assumed.
C_NAME=$(item_at "$C_PATH" | jq -r .name)
C_WS=$(item_at "$C_PATH" | jq -r .workspace_id)
{
  echo "Trellis item: $(item_at "$C_PATH" | jq -c '{id,name,name_source}')"
  echo "T3 project title: $(project_title "$C_PROJECT")"
  echo "--- reply"; echo "$C_REPLY"
} >"$OUT/08-click.log"
c8a() { [[ $C_NAME =~ ^click([^a-z]|$) && $(project_title "$C_PROJECT") == "$C_NAME" && -f $C_PATH/pyproject.toml ]]; }
c8b() { [[ $C_RUN1 == completed ]] && grep -q pyproject.toml <<<"$C_REPLY" && grep -q README.md <<<"$C_REPLY"; }
check 8a "The new clone is named after the repository (\"$C_NAME\") in Trellis and the same in T3" "$OUT/08-click.log" \
  c8a
check 8b "A thread there lists the top-level files" "$OUT/08-click.png" \
  c8b
C_ROW=$(pwc <<JS
async page => await page.getByRole('button', { name: $(js "$(sql "select title from orchestration_v2_projection_threads where thread_id='$C_THREAD'"), $C_NAME"), exact: true }).count()
JS
)
c8c() { [[ $C_ROW == 1 ]]; }
check 8c "The sidebar lists the thread under its own project, not a repository group of all clones" "$OUT/08-click.png" c8c

# ---- 9. Delete and restore ----------------------------------------------
step 9 "trash and restore click"
C_ID=$(item_at "$C_PATH" | jq -r .id)
C_TITLE=$(sql "select title from orchestration_v2_projection_threads where thread_id='$C_THREAD'")
pwc <<JS >"$OUT/09-trash.log"
async page => {
  await page.getByRole('button', { name: /^Thread actions for/ }).click();
  await page.getByRole('button', { name: 'Project settings', exact: true }).click();
  await page.waitForTimeout(2000);
  const own = page.getByRole('button', { name: $(js "Remove checkout $C_PATH"), exact: true });
  const used = (await own.count()) > 0 ? 'Remove checkout (grouped entry)' : 'Move to trash';
  if ((await own.count()) > 0) await own.click();
  else await page.getByRole('button', { name: 'Move to trash' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.waitFor();
  const title = await dialog.getByRole('heading').innerText();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await page.waitForTimeout(4000);
  return used + ': ' + title;
}
JS
goto "/$ENV_ID/$B_THREAD"
shot 09a-sidebar-after-delete
SIDEBAR_AFTER_DELETE=$(page_text)
C_ARCHIVED=$(thread_archived "$C_THREAD")
goto /settings/trellis
shot 09b-trash
{ echo "--- trellis trash"; tr_ --json trash | jq -c '.projects[] | {id,name,deleted_at}'; echo "thread archived_at: $C_ARCHIVED"; } >>"$OUT/09-trash.log"
c9a() {
  tr_ --json trash | jq -e --arg id "$C_ID" 'any(.projects[]; .id==$id)' && [[ -n $C_ARCHIVED ]] &&
    ! grep -qF -- "$C_TITLE" <<<"$SIDEBAR_AFTER_DELETE"
}
check 9a "Deleting click moves it to the Trellis trash, archives its thread and removes it from the sidebar" \
  "$OUT/09a-sidebar-after-delete.png, $OUT/09b-trash.png" \
  c9a
pwc <<JS >>"$OUT/09-trash.log"
async page => {
  // The trash names items only; another trashed item of the same name
  // would make the row ambiguous, so that stops the run.
  const heading = page.getByRole('heading', { name: $(js "$C_NAME"), exact: true });
  const count = await heading.count();
  if (count !== 1) throw new Error(count + ' trash rows are named ' + $(js "$C_NAME"));
  const row = page.locator('div')
    .filter({ has: heading })
    .filter({ has: page.getByRole('button', { name: 'Restore' }) })
    .last();
  await row.getByRole('button', { name: 'Restore' }).click();
  await page.getByText('Restored ' + $(js "$C_NAME")).waitFor({ timeout: 60000 });
  return 'restored';
}
JS
sleep 3
shot 09c-restored-toast
goto "/$ENV_ID/$B_THREAD"
SIDEBAR_AFTER_RESTORE=$(page_text)
goto "/$ENV_ID/$C_THREAD"
shot 09d-restored-thread
echo "after restore: item $(item_at "$C_PATH" | jq -c '{id,deleted_at}'), thread archived_at '$(thread_archived "$C_THREAD")'" >>"$OUT/09-trash.log"
c9b() { tr_ --json ls | jq -e --arg p "$C_PATH" 'any(.[]; .path==$p)' && [[ -z $(thread_archived "$C_THREAD") ]] && grep -qF -- "$C_TITLE" <<<"$SIDEBAR_AFTER_RESTORE"; }
check 9b "Restore brings click back in Trellis and its thread back, unarchived" "$OUT/09d-restored-thread.png" \
  c9b

# ---- 10. Move -----------------------------------------------------------
step 10 "move a new Claude thread to click"
M_THREAD=$(cat /proc/sys/kernel/random/uuid)
rpc orchestration.dispatchCommand "$(jq -nc --arg t "$M_THREAD" --arg p "$B_PROJECT" --arg c "$(cat /proc/sys/kernel/random/uuid)" \
  '{type:"thread.create",createdBy:"user",creationSource:"web",commandId:$c,threadId:$t,projectId:$p,title:"Move me",modelSelection:{instanceId:"claudeAgent",model:"claude-haiku-4-5"},runtimeMode:"full-access",interactionMode:"default",branch:null,worktreePath:null}')" \
  >"$OUT/10-move.log" 2>&1
goto "/$ENV_ID/$B_THREAD"
pwc <<'JS' >/dev/null
async page => {
  await page.getByRole('button', { name: /^Move me, / }).first().click({ timeout: 60000 });
  await page.waitForTimeout(1500);
}
JS
echo "opened from the sidebar: $(path_now) (created $M_THREAD)" >>"$OUT/10-move.log"
thread_menu "Move me"
shot 10a-move-menu
pwc <<JS >/dev/null
async page => {
  // Targets are named "<title> (<kind> · <workspace>)": this run's clone by its workspace.
  await page.getByRole('button', { name: $(js "$C_NAME (Project · $C_WS)"), exact: true }).click();
  await page.waitForTimeout(2000);
}
JS
M_ROOT=$(thread_root "$M_THREAD")
send "Run pwd and reply with only its output" >/dev/null
M_RUN1=$(wait_run "$M_THREAD" 1 300)
sleep 2
shot 10b-moved-thread
M_REPLY=$(last_reply "$M_THREAD")
{
  echo "thread $M_THREAD created in $B_PATH (no message), moved; now in $M_ROOT"
  echo "first turn: $M_RUN1; reply: $M_REPLY"
  echo "Claude cwd in the provider log: $(provider_log "$M_THREAD" | grep -o '"cwd":"[^"]*"' | sort -u | tr '\n' ' ')"
} >>"$OUT/10-move.log"
c10a() { [[ $M_ROOT == "$C_PATH" && $M_RUN1 == completed ]] && grep -qF -- "$C_PATH" <<<"$M_REPLY"; }
check 10a "Move to project -> click moves the thread, and its first turn runs in click's workspace" "$OUT/10b-moved-thread.png" \
  c10a
goto "/$ENV_ID/$IDEA_THREAD"
thread_menu "$(sql "select title from orchestration_v2_projection_threads where thread_id='$IDEA_THREAD'")"
shot 10c-history-limit
LIMIT=$(pwc <<'JS'
async page => await page.getByRole('button', { name: 'This thread has history; graduation will move such threads.' }).isDisabled()
JS
)
c10b() { [[ $LIMIT == true ]]; }
check 10b "The same menu on the step 3 thread shows the M1 limit, disabled" "$OUT/10c-history-limit.png" c10b
note 10 "Adaptation: the UI keeps a new thread as a client draft until its first message, and drafts have no thread menu, so the message-less thread is created over the RPC (orchestration.dispatchCommand thread.create, as API clients do); the move and the first turn go through the UI."

# ---- 11. Context across a move (transcripts) ----------------------------
step 11 "transcript recall spike"
pwc <<<'async page => { await page.keyboard.press("Escape"); }' >/dev/null
SPIKE_START=$(date +%s)
# A is this run's idea (step 2), B its project (step 5), Claude through this
# instance's shim.
SPIKE_SHIM=$TRELLIS_ROOT/shims/claude
echo "A=$IDEA_PATH B=$B_PATH shim=$SPIKE_SHIM" >"$OUT/11-recall-spike.log"
(cd "$REPO" && TRELLIS_SPIKE=1 TRELLIS_SPIKE_A=$IDEA_PATH TRELLIS_SPIKE_B=$B_PATH \
  TRELLIS_SPIKE_SHIM=$SPIKE_SHIM vp run --filter t3 test TrellisClaudeTranscripts.spike) \
  >>"$OUT/11-recall-spike.log" 2>&1
SPIKE_RC=$?
SPIKE_B=$B_PATH
SLUG_DIR=$HOME/.claude/projects/$(sed 's/[^A-Za-z0-9]/-/g' <<<"$SPIKE_B")
{
  echo "--- transcripts the run wrote beside B ($SLUG_DIR)"
  find "$SLUG_DIR" -maxdepth 1 -name '*.jsonl' -newermt "@$SPIKE_START" -printf '%T@ %p\n' | sort -n | while read -r _ f; do
    echo "$(basename "$f")"
    jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="thinking" or .type=="text") | "  \(.type): \(.thinking // .text | gsub("\n"; " ") | .[0:200])"' "$f" | tail -4
  done
} >>"$OUT/11-recall-spike.log" 2>&1
# One test passes (the recall); the guard for missing paths is skipped.
c11() { [[ $SPIKE_RC == 0 ]] && grep -qE 'Tests +1 passed' "$OUT/11-recall-spike.log" && ! grep -q failed "$OUT/11-recall-spike.log"; }
check 11 "Thinking-only recall survives prepare from this run's idea to its project; forkSession with dir B succeeds (spike test)" \
  "$OUT/11-recall-spike.log" c11
note 11 "Transcript-level by design: the UI cannot move a thread with history in M1."

# ---- checklist ----------------------------------------------------------
print_checklist
