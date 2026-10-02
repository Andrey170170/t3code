#!/usr/bin/env bash
# Graduation demo (Trellis docs/v1/stage-b.md, Lane T3-M6 step 3): moves
# with history and graduation, driven through playwright-cli in an isolated
# dev T3 against a development Trellis, with a checklist like
# scripts/demo-trellis.sh, whose helpers it sources.
#
#   TRELLIS_DEV_ROOT=/trellis/dev-<name> scripts/demo-graduation.sh [out-dir]
#
# Needs what scripts/demo-trellis.sh needs. Costs a few Haiku and Codex turns.
DEMO_TITLE="Trellis graduation demo"
DEMO_TRELLIS_HELPERS_ONLY=1
# shellcheck source=demo-trellis.sh
source "$(dirname "${BASH_SOURCE[0]}")/demo-trellis.sh" "${1:-/tmp/trellis-graduation-demo}"
unset DEMO_TRELLIS_HELPERS_ONLY

assistant_texts() { sql "select json_extract(payload_json,'\$.text') from orchestration_v2_projection_messages where thread_id='$1' and role='assistant' order by created_at"; }
user_texts() { sql "select json_extract(payload_json,'\$.text') from orchestration_v2_projection_messages where thread_id='$1' and role='user' order by created_at"; }
max_ordinal() { sql "select coalesce(max(ordinal),0) from orchestration_v2_projection_runs where thread_id='$1'"; }
native_session() { sql "select json_extract(payload_json,'\$.nativeThreadRef.nativeId') from orchestration_v2_projection_provider_threads where thread_id='$1' and json_extract(payload_json,'\$.nativeThreadRef.nativeId') is not null limit 1"; }
slug() { sed 's/[^a-zA-Z0-9]/-/g' <<<"$1"; }
thinking_of() { # transcript path -> thinking text
  jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="thinking") | .thinking' "$1" 2>/dev/null
}
wait_root_change() { # thread, old root, seconds
  local root=
  for _ in $(seq 1 "${3:-120}"); do
    root=$(thread_root "$1")
    [[ -n $root && $root != "$2" ]] && break
    sleep 1
  done
  echo "$root"
}
wait_new_run_done() { # thread, ordinal above which to wait for a finished run, seconds
  local n status
  for _ in $(seq 1 "${3:-300}"); do
    n=$(max_ordinal "$1")
    if ((n > $2)); then
      status=$(run_status "$1" "$n")
      case $status in "" | queued | preparing | starting | running | waiting) ;; *) echo "$n $status"; return ;; esac
    fi
    sleep 1
  done
  echo "$(max_ordinal "$1") timeout"
}
open_thread() { goto "/$ENV_ID/$1"; }

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
pwc <<'JS' >/dev/null
async page => {
  await page.waitForURL((url) => !url.pathname.startsWith('/pair'), { timeout: 180000 });
  await page.locator('main').first().waitFor({ timeout: 180000 });
}
JS
ENV_ID=$(cat "$HOME_DIR/userdata/environment-id")

step 0 "turn on Trellis"
S0=$(pwc <<JS
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
c0() { grep -q "Connected · workspaces in $TRELLIS_DEV_ROOT" <<<"$S0"; }
check 0 "Trellis is on and reachable at $TRELLIS_DEV_ROOT" "$OUT/demo.log" c0

# ---- 1. An idea with three Claude turns ----------------------------------
step 1 "Claude idea: a private word, a pip install, a script"
goto /
palette "New idea"
pwc <<'JS' >/dev/null
async page => {
  await page.waitForURL((url) => url.pathname.startsWith('/draft/'), { timeout: 30000 });
}
JS
select_model Claude "$CLAUDE_MODEL_LABEL" >"$OUT/01-model.log"
IDEA_THREAD=$(send "Think of a random six-letter English word in your reasoning only. Never write it in a reply until I ask for it. Reply only: ok")
R1=$(wait_run "$IDEA_THREAD" 1 300)
IDEA_PATH=$(thread_root "$IDEA_THREAD")
guard_trellis_path "$IDEA_PATH"
send "Install the rich package with pip (pip install --user rich) and check that python3 can import it. Keep the reply short." >/dev/null
R2=$(wait_run "$IDEA_THREAD" 2 400)
send "Create clock.py here that prints the current time in green using rich, run it once, and keep the reply short." >/dev/null
R3=$(wait_run "$IDEA_THREAD" 3 400)
shot 01-idea-three-turns
SID=$(native_session "$IDEA_THREAD")
TRANSCRIPT_A="$CLAUDE_HOME/projects/$(slug "$IDEA_PATH")/$SID.jsonl"
THINKING_A=$(thinking_of "$TRANSCRIPT_A")
{
  echo "thread $IDEA_THREAD runs: $R1 $R2 $R3; idea $IDEA_PATH; session $SID"
  echo "transcript: $TRANSCRIPT_A"
  echo "--- thinking (turn 1..3)"; echo "$THINKING_A" | head -40
  echo "--- replies"; assistant_texts "$IDEA_THREAD"
  echo "--- files"; ls -la "$IDEA_PATH"
} >"$OUT/01-idea.log" 2>&1
c1() { [[ $R1 == completed && $R2 == completed && $R3 == completed && -f $IDEA_PATH/clock.py && -s $TRANSCRIPT_A && -n $THINKING_A ]]; }
check 1 "An idea with three completed Claude turns (a private word, pip install rich, clock.py); turn 1's thinking is in the transcript" "$OUT/01-idea.log" c1

# ---- 2. A tool call graduates it -----------------------------------------
step 2 "trellis_graduate from the thread"
send 'Graduate this idea into its own Trellis project now with the trellis_graduate tool, base "dev" and name "Rich clock", as the last thing you do.' >/dev/null
PROJECT_PATH=$(wait_root_change "$IDEA_THREAD" "$IDEA_PATH" 300)
CONT=$(wait_new_run_done "$IDEA_THREAD" 4 400)
open_thread "$IDEA_THREAD"
shot 02-graduated-by-tool
IDEA_ITEM=$(curl -s --unix-socket "$TRELLIS_SOCKET" "http://trellis/v1/projects?all=true&light=true" | jq -c --arg p "$IDEA_PATH" '.[] | select(.path==$p) | {id, kind, name, graduated_to}')
{
  echo "thread root now: $PROJECT_PATH (was $IDEA_PATH)"
  echo "continuation run: $CONT"
  echo "idea item: $IDEA_ITEM"
  echo "--- user messages"; user_texts "$IDEA_THREAD"
  echo "--- replies"; assistant_texts "$IDEA_THREAD"
  echo "--- project files"; ls -la "$PROJECT_PATH"
} >"$OUT/02-graduated.log" 2>&1
c2() {
  [[ $PROJECT_PATH == "$TRELLIS_DEV_ROOT"/workspaces/*/project && $PROJECT_PATH != "$IDEA_PATH" && -f $PROJECT_PATH/clock.py ]] &&
    user_texts "$IDEA_THREAD" | grep -q 'graduated into the project "Rich clock"' &&
    [[ $CONT == *completed ]]
}
check 2 "A trellis_graduate call ended the turn, graduated the idea, moved the same thread into the project and continued it there" "$OUT/02-graduated.png" c2

# ---- 3. The thread recalls the private word ------------------------------
step 3 "recall across the move"
N=$(max_ordinal "$IDEA_THREAD")
send "Which six-letter word did you pick at the very start of this conversation? Reply with the word only." >/dev/null
RECALL=$(wait_new_run_done "$IDEA_THREAD" "$N" 300)
WORD=$(last_reply "$IDEA_THREAD" | tr -cd 'a-zA-Z' | tr 'A-Z' 'a-z')
shot 03-recall
TRANSCRIPT_B="$CLAUDE_HOME/projects/$(slug "$PROJECT_PATH")/$SID.jsonl"
FIRST_REPLY=$(assistant_texts "$IDEA_THREAD" | head -1)
{
  echo "recall run: $RECALL; word: $WORD; same session $SID"
  echo "transcript now: $TRANSCRIPT_B (exists: $([[ -f $TRANSCRIPT_B ]] && echo yes || echo no)); old: $([[ -f $TRANSCRIPT_A ]] && echo still there || echo gone)"
  echo "turn 1 reply: $FIRST_REPLY"
  echo "word in turn-1 thinking: $(grep -qi "$WORD" <<<"$THINKING_A" && echo yes || echo no)"
} >"$OUT/03-recall.log" 2>&1
c3() { [[ ${#WORD} -eq 6 && -f $TRANSCRIPT_B ]] && grep -qi "$WORD" <<<"$THINKING_A" && ! grep -qi "$WORD" <<<"$FIRST_REPLY"; }
check 3 "The thread continues in the project and recalls the word it only thought (\"$WORD\"), resuming the same Claude session from its relocated transcript" "$OUT/03-recall.log" c3

# ---- 4. The project carries the environment record -----------------------
step 4 "environment record"
tr_ changes --graduation --target "$PROJECT_PATH" >"$OUT/04-changes-graduation.log" 2>&1
N=$(max_ordinal "$IDEA_THREAD")
send "Run trellis changes --graduation and list, in one short line, the packages it says were installed while this was an idea." >/dev/null
wait_new_run_done "$IDEA_THREAD" "$N" 300 >/dev/null
shot 04-environment-record
c4() { grep -qi rich "$OUT/04-changes-graduation.log"; }
check 4 "\`trellis changes --graduation\` in the project lists the pip install of rich from the idea" "$OUT/04-changes-graduation.log" c4

# ---- 5. Restore across the move refused, rewind allowed ------------------
step 5 "pre-move restore refused, rewind allowed"
open_thread "$IDEA_THREAD"
edit_from() { # message text prefix; clicks Edit from here on that user message
  pwc <<JS >/dev/null
async page => {
  const row = page.locator('[data-message-role="user"]').filter({ hasText: $(js "$1") }).last();
  // The timeline is virtualized: scroll up until the message is rendered.
  for (let i = 0; i < 60 && (await row.count()) === 0; i++) {
    await page.mouse.move(850, 400);
    await page.mouse.wheel(0, -1200);
    await page.waitForTimeout(250);
  }
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByRole('button', { name: 'Edit from here' }).first().click({ force: true });
  await page.getByRole('alertdialog').waitFor({ timeout: 10000 });
}
JS
}
edit_from "Install the rich package"
shot 05a-edit-from-here
pwc <<'JS' >/dev/null
async page => {
  await page.getByRole('button', { name: 'Revert files too' }).click();
  await page.waitForTimeout(3000);
}
JS
shot 05b-restore-refused
REFUSAL=$(page_text | grep -o "This turn ran before the thread moved[^.]*\." | head -1)
ROLLED_BEFORE=$(sql "select count(*) from orchestration_v2_projection_runs where thread_id='$IDEA_THREAD' and status='rolled_back'")
edit_from "Install the rich package"
pwc <<'JS' >/dev/null
async page => {
  await page.getByRole('button', { name: 'Revert and keep changes' }).click();
  await page.waitForTimeout(5000);
}
JS
ROLLED_AFTER=0
for _ in $(seq 1 60); do
  ROLLED_AFTER=$(sql "select count(*) from orchestration_v2_projection_runs where thread_id='$IDEA_THREAD' and status='rolled_back'")
  ((ROLLED_AFTER > 0)) && break
  sleep 1
done
shot 05c-rewind-allowed
{
  echo "refusal shown: $REFUSAL"
  echo "rolled back runs before: $ROLLED_BEFORE, after the rewind: $ROLLED_AFTER"
  echo "project files after the rewind (unchanged):"; ls -la "$PROJECT_PATH"
} >"$OUT/05-boundary.log" 2>&1
c5() { [[ -n $REFUSAL && $ROLLED_BEFORE -eq 0 && $ROLLED_AFTER -gt 0 && -f $PROJECT_PATH/clock.py ]]; }
check 5 "Restoring files from a pre-move turn is refused with the boundary message; rewinding only the conversation works" "$OUT/05-boundary.png" c5

# ---- 6. The Graduate action on a Codex idea ------------------------------
step 6 "Graduate action on a Codex idea"
goto /
palette "New idea"
pwc <<'JS' >/dev/null
async page => {
  await page.waitForURL((url) => url.pathname.startsWith('/draft/'), { timeout: 30000 });
}
JS
select_model Codex "$CODEX_MODEL_LABEL" >"$OUT/06-model.log"
CODEX_THREAD=$(send "Create notes.md here containing a two-line poem about trees. Keep the reply short.")
C1=$(wait_run "$CODEX_THREAD" 1 400)
CODEX_IDEA=$(thread_root "$CODEX_THREAD")
guard_trellis_path "$CODEX_IDEA"
palette "Graduate idea"
pwc <<'JS' >/dev/null
async page => {
  await page.getByRole('dialog').filter({ hasText: 'Graduate' }).waitFor({ timeout: 10000 });
  await page.getByText(/\(default\)/).first().waitFor({ timeout: 20000 });
  await page.getByRole('combobox', { name: 'Base' }).click();
  await page.waitForTimeout(800);
}
JS
shot 06a-graduate-dialog-base-picker
pwc <<'JS' >/dev/null
async page => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.getByLabel('Name (optional)').fill('Tree notes');
  await page.getByRole('button', { name: 'Graduate', exact: true }).click();
  await page.getByRole('dialog').filter({ hasText: 'Graduate' }).waitFor({ state: 'detached', timeout: 600000 });
  await page.waitForTimeout(2000);
}
JS
CODEX_PROJECT=$(wait_root_change "$CODEX_THREAD" "$CODEX_IDEA" 120)
shot 06b-graduated-by-action
# An idle thread only moves: no turn starts until the user writes.
N=$(max_ordinal "$CODEX_THREAD")
send "What is your current working directory, and is notes.md in it? Answer in one line." >/dev/null
C3=$(wait_new_run_done "$CODEX_THREAD" "$N" 300)
shot 06c-codex-continues
{
  echo "codex thread $CODEX_THREAD: idea $CODEX_IDEA -> $CODEX_PROJECT; last run $C3"
  echo "--- user messages"; user_texts "$CODEX_THREAD"
  echo "--- replies"; assistant_texts "$CODEX_THREAD"
} >"$OUT/06-codex.log" 2>&1
c6() {
  [[ $C1 == completed && $N -eq 1 && $CODEX_PROJECT == "$TRELLIS_DEV_ROOT"/workspaces/*/project && -f $CODEX_PROJECT/notes.md && $C3 == *completed ]] &&
    last_reply "$CODEX_THREAD" | grep -qF "$CODEX_PROJECT"
}
check 6 "The Graduate action (base picker) graduates a Codex idea without starting a turn; the same thread continues in the project's workspace" "$OUT/06-codex.log" c6

# ---- 7. trellis graduate from the CLI -------------------------------------
step 7 "CLI graduation picked up"
goto /
palette "New idea"
pwc <<'JS' >/dev/null
async page => {
  await page.waitForURL((url) => url.pathname.startsWith('/draft/'), { timeout: 30000 });
}
JS
select_model Codex "$CODEX_MODEL_LABEL" >/dev/null
CLI_THREAD=$(send "Create todo.txt here listing three chores. Keep the reply short.")
L1=$(wait_run "$CLI_THREAD" 1 400)
CLI_IDEA=$(thread_root "$CLI_THREAD")
guard_trellis_path "$CLI_IDEA"
tr_ graduate --target "$CLI_IDEA" --base dev --name "Chores" >"$OUT/07-cli-graduate.log" 2>&1
T7=$(date +%s)
CLI_PROJECT=$(wait_root_change "$CLI_THREAD" "$CLI_IDEA" 60)
T7=$(( $(date +%s) - T7 ))
open_thread "$CLI_THREAD"
shot 07a-cli-graduation-picked-up
L_AFTER=$(max_ordinal "$CLI_THREAD")
send "Is todo.txt in your current working directory? Answer in one line with the directory." >/dev/null
L2=$(wait_new_run_done "$CLI_THREAD" "$L_AFTER" 300)
shot 07b-cli-thread-continues
{
  echo "cli thread $CLI_THREAD: $CLI_IDEA -> $CLI_PROJECT in ${T7}s; runs before the next message: $L_AFTER; next run $L2"
  echo "--- user messages"; user_texts "$CLI_THREAD"
  echo "--- replies"; assistant_texts "$CLI_THREAD"
} >>"$OUT/07-cli-graduate.log" 2>&1
c7() {
  [[ $L1 == completed && $CLI_PROJECT == "$TRELLIS_DEV_ROOT"/workspaces/*/project && $L_AFTER -eq 1 && $L2 == *completed ]] &&
    last_reply "$CLI_THREAD" | grep -qF "$CLI_PROJECT"
}
check 7 "\`trellis graduate\` on the host is picked up by the catalog sync (${T7}s): the thread moves without a continuation and continues there" "$OUT/07-cli-graduate.log" c7

print_checklist
