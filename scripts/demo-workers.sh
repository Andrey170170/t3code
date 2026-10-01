#!/usr/bin/env bash
# Workers demo (Trellis docs/v1/stage-b.md, Lane T3-M3 step 5): a lead
# checkpoints, spawns workers into forks, merges one, spawns one from an older
# checkpoint, is refused a revert while a worker runs, discards a fork with a
# purge request confirmed in the UI, and "Fork workspace" makes a visible
# lead. Driven through playwright-cli in an isolated dev T3 against a
# development Trellis, with a checklist like scripts/demo-trellis.sh, whose
# helpers it sources.
#
#   TRELLIS_DEV_ROOT=/trellis/dev-<name> scripts/demo-workers.sh [out-dir]
#   DEMO_SCORE=1 ...   also measures the score (10 checkpoints, 10 single spawns)
#
# Needs what scripts/demo-trellis.sh needs. Costs a few dozen Haiku turns.
DEMO_TITLE="Trellis workers demo"
DEMO_TRELLIS_HELPERS_ONLY=1
# shellcheck source=demo-trellis.sh
source "$(dirname "${BASH_SOURCE[0]}")/demo-trellis.sh" "${1:-/tmp/trellis-workers-demo}"
unset DEMO_TRELLIS_HELPERS_ONLY

api() { curl -s --unix-socket "$TRELLIS_SOCKET" "http://trellis$1"; }
user_texts() { sql "select json_extract(payload_json,'\$.text') from orchestration_v2_projection_messages where thread_id='$1' and role='user' order by created_at"; }
assistant_texts() { sql "select json_extract(payload_json,'\$.text') from orchestration_v2_projection_messages where thread_id='$1' and role='assistant' order by created_at"; }
max_ordinal() { sql "select coalesce(max(ordinal),0) from orchestration_v2_projection_runs where thread_id='$1'"; }
child_by_title() { sql "select thread_id from orchestration_v2_projection_threads where json_extract(payload_json,'\$.lineage.parentThreadId')='$1' and title like '$2%' order by created_at desc limit 1"; }
open_thread() { goto "/$ENV_ID/$1"; }
in_ws() { # workspace path, shell command: runs inside that workspace
  (cd "$1" && tr_ exec -- sh -c "$2")
}
wait_idle() { # thread, ordinal above which a finished run is awaited, seconds; prints "<n> <status>"
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
wait_child_done() { # lead, title prefix, seconds; prints the child's thread id once its first run finished
  local child=
  for _ in $(seq 1 "${3:-400}"); do
    child=$(child_by_title "$1" "$2")
    if [[ -n $child ]]; then
      case $(run_status "$child" 1) in completed | failed | interrupted | cancelled) echo "$child"; return ;; esac
    fi
    sleep 1
  done
  echo "$child"
}
# Sends TEXT to the lead and waits until its turns settle (a checkpoint's
# continuation is a further turn): prints the final "<n> <status>".
lead_turn() {
  local before last sent
  open_thread "$LEAD"
  before=$(max_ordinal "$LEAD")
  sent=$(send "$1")
  [[ $sent == "$LEAD" ]] || log "warning: the message went to $sent, not the lead $LEAD"
  last=$(wait_idle "$LEAD" "$before" "${2:-400}")
  # A tool-ended turn continues: wait for the queue to drain.
  for _ in $(seq 1 30); do
    sleep 2
    [[ $(max_ordinal "$LEAD") == "${last%% *}" ]] && break
    last=$(wait_idle "$LEAD" "${last%% *}" "${2:-400}")
  done
  echo "$last"
}
edit_from() { # message text prefix; opens Edit from here on that user message
  pwc <<JS >/dev/null
async page => {
  const row = page.locator('[data-message-role="user"]').filter({ hasText: $(js "$1") }).last();
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
project_filter_options() {
  pwc <<'JS' | jq -r '.[]'
async page => {
  await page.getByRole('combobox', { name: 'Filter threads by project' }).click();
  await page.waitForTimeout(800);
  const options = await page.getByRole('option').allInnerTexts();
  await page.keyboard.press('Escape');
  return options.map((text) => text.split('\n').pop());
}
JS
}
settings_workspaces() { # project title; opens its settings at the workspace list; prints the list
  pwc <<JS | jq -r .
async page => {
  await page.goto($(js "$ORIGIN/settings/projects"));
  await page.getByRole('button', { name: $(js "$1"), exact: true }).first().click();
  const heading = page.getByText('Trellis workspaces').first();
  await heading.waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  await heading.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const text = await page.locator('main').innerText();
  return text.slice(text.indexOf('Trellis workspaces'), text.indexOf('Danger'));
}
JS
}

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

step 0 "turn on Trellis; a project with a jj repository"
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
PROJECT_NAME="workers-$RUN_ID"
PROJECT=$(tr_ --json new --project "$PROJECT_NAME")
LEAD_WS=$(jq -r .workspace_id <<<"$PROJECT")
PROJECT_ID=$(jq -r .id <<<"$PROJECT")
LEAD_PATH=$(jq -r .path <<<"$PROJECT")
guard_trellis_path "$LEAD_PATH"
in_ws "$LEAD_PATH" 'printf "def greet(name):\n    return f\"hello {name}\"\n" > app.py && jj commit -m "Initial app" && jj bookmark set main -r @-' >"$OUT/00-seed.log" 2>&1
for _ in $(seq 1 60); do [[ -n $(project_by_root "$LEAD_PATH") ]] && break; sleep 1; done
c0() { grep -q "Connected · workspaces in $TRELLIS_DEV_ROOT" <<<"$S0" && [[ -n $(project_by_root "$LEAD_PATH") && -f $LEAD_PATH/app.py ]]; }
check 0 "Trellis is on; project $PROJECT_NAME ($LEAD_WS) has app.py committed on bookmark main and a T3 project" "$OUT/00-seed.log" c0

# ---- 1. The lead checkpoints ----------------------------------------------
step 1 "a lead checkpoints with the tool; its turn ends and continues"
goto /
pwc <<JS >/dev/null
async page => {
  await page.getByRole('button', { name: 'New thread', exact: true }).click();
  await page.getByRole('option', { name: new RegExp($(js "$LEAD_WS")) }).first().click();
  await page.waitForURL((url) => url.pathname.startsWith('/draft/'), { timeout: 30000 });
}
JS
select_model Claude "$CLAUDE_MODEL_LABEL" >"$OUT/01-model.log"
LEAD=$(send 'You are the lead of this Trellis project. Call the trellis_checkpoint tool now with name "base" as the last action of this turn. When you are continued with its result, reply only "checkpoint done".')
R1=$(wait_idle "$LEAD" 1 400)
for _ in $(seq 1 60); do
  user_texts "$LEAD" | grep -q '^\[trellis_checkpoint\] Checkpoint snap-[a-z0-9]* ("base") taken' && break
  sleep 2
done
R1=$(wait_idle "$LEAD" 1 400)
BASE=$(user_texts "$LEAD" | grep -o 'Checkpoint snap-[a-z0-9]* ("base")' | grep -o 'snap-[a-z0-9]*' | head -1)
open_thread "$LEAD"
shot 01-lead-checkpoint
{
  echo "lead $LEAD; first turn and continuation: $(sql "select group_concat(ordinal||':'||status,' ') from orchestration_v2_projection_runs where thread_id='$LEAD'")"
  echo "--- user messages"; user_texts "$LEAD"
  echo "--- trellis snapshots"; tr_ snapshots --target "$LEAD_PATH"
} >"$OUT/01-checkpoint.log" 2>&1
c1() {
  [[ -n $BASE && $(run_status "$LEAD" 1) == interrupted && $R1 == *completed ]] &&
    tr_ --json snapshots --target "$LEAD_PATH" | jq -e --arg s "$BASE" '.[] | select(.id==$s and .kind=="checkpoint")' >/dev/null
}
check 1 "trellis_checkpoint ended the lead's turn (interrupted), took checkpoint $BASE \"base\" and continued the thread with the result" "$OUT/01-lead-checkpoint.png" c1

# ---- 2. Two workers from that checkpoint, without a stop -------------------
step 2 "two fork workers from the checkpoint"
CHECKPOINTS_BEFORE=$(tr_ --json snapshots --target "$LEAD_PATH" | jq '[.[] | select(.kind=="checkpoint")] | length')
lead_turn 'Now call the delegate_task tool twice (mode "async"), then end your turn without waiting. First: title "humanize worker", workspace {"fork": {"from": "latest", "name": "humanize"}}, task: "Run pip install humanize. Add to app.py a function naturalsize_demo() that returns humanize.naturalsize(1000000). Commit with jj commit -m \"Use humanize\" and run jj bookmark set humanize -r @-. Reply with a short summary." Second: title "tests worker", workspace {"fork": {"from": "latest", "name": "tests"}}, task: "Add test_app.py with a test of greet(). Commit with jj commit -m \"Add tests\" and run jj bookmark set tests -r @-. Reply with a short summary."' 400 >"$OUT/02-turn.log"
HUMANIZE=$(wait_child_done "$LEAD" "humanize worker" 600)
TESTS=$(wait_child_done "$LEAD" "tests worker" 600)
SPAWNED=$(tr_ --json workspaces --spawned-by "$LEAD")
HUMANIZE_WS=$(jq -r '.[] | select(.name=="humanize") | .id' <<<"$SPAWNED")
TESTS_WS=$(jq -r '.[] | select(.name=="tests") | .id' <<<"$SPAWNED")
HUMANIZE_PATH=$(jq -r '.[] | select(.name=="humanize") | .path' <<<"$SPAWNED")
TESTS_PATH=$(jq -r '.[] | select(.name=="tests") | .path' <<<"$SPAWNED")
CHECKPOINTS_AFTER=$(tr_ --json snapshots --target "$LEAD_PATH" | jq '[.[] | select(.kind=="checkpoint")] | length')
open_thread "$LEAD"
shot 02-lead-spawned-workers
{
  echo "workers: humanize $HUMANIZE in $HUMANIZE_WS, tests $TESTS in $TESTS_WS"
  echo "worker roots: $(thread_root "$HUMANIZE") $(thread_root "$TESTS")"
  echo "checkpoints in the lead's workspace before/after the spawns: $CHECKPOINTS_BEFORE/$CHECKPOINTS_AFTER"
  echo "--- trellis workspaces --spawned-by $LEAD"; tr_ workspaces --spawned-by "$LEAD"
  echo "--- raw"; jq . <<<"$SPAWNED"
} >"$OUT/02-spawned.log" 2>&1
c2() {
  [[ -n $HUMANIZE_WS && -n $TESTS_WS && $(thread_root "$HUMANIZE") == "$HUMANIZE_PATH" && $(thread_root "$TESTS") == "$TESTS_PATH" ]] &&
    [[ $CHECKPOINTS_BEFORE == "$CHECKPOINTS_AFTER" ]] &&
    jq -e --arg s "$BASE" --arg w "$LEAD_WS" 'map(select(.parent_snapshot==$s and .spawned_by.workspace==$w)) | length == 2' <<<"$SPAWNED" >/dev/null
}
check 2 "delegate_task spawned two workers into forks of checkpoint $BASE (spawned_by the lead), each in its fork's project, without another checkpoint" "$OUT/02-spawned.log" c2

# ---- 3. Hidden from the sidebar, listed in the project's workspaces --------
step 3 "worker forks hidden from the sidebar, listed in the workspace list and by the CLI"
goto /
FILTER=$(project_filter_options)
shot 03a-sidebar-projects
LIST=$(settings_workspaces "$PROJECT_NAME")
shot 03b-workspace-list
pwc <<'JS' >/dev/null
async page => {
  await page.getByRole('button', { name: 'Workers', exact: true }).click();
  await page.waitForTimeout(800);
}
JS
shot 03c-workspace-list-workers
{
  echo "--- project filter options"; echo "$FILTER"
  echo "--- workspace list"; echo "$LIST"
} >"$OUT/03-hidden.log"
c3() {
  grep -qx "$PROJECT_NAME" <<<"$FILTER" && ! grep -q "$PROJECT_NAME · " <<<"$FILTER" &&
    grep -q "humanize" <<<"$LIST" && grep -q "tests" <<<"$LIST" && grep -q 'worker fork of .*hidden from the sidebar' <<<"$LIST"
}
check 3 "The sidebar's projects show $PROJECT_NAME but not its worker forks; its settings list both as worker forks; \`trellis workspaces --spawned-by\` lists them" "$OUT/03-hidden.log" c3

# ---- 4. A worker installs, commits on a bookmark, finishes ------------------
step 4 "the humanize worker's package, bookmark and summary"
{
  echo "--- humanize worker run: $(run_status "$HUMANIZE" 1)"
  echo "--- jj bookmarks in its fork"; in_ws "$HUMANIZE_PATH" 'jj bookmark list'
  echo "--- humanize installed in its fork (pip, user or venv)"
  in_ws "$HUMANIZE_PATH" 'python3 -m pip show humanize 2>/dev/null | head -2; find / -xdev -path "*site-packages/humanize/__init__.py" 2>/dev/null | head -3'
  echo "--- trellis changes in its fork"; tr_ changes --target "$HUMANIZE_PATH"
  echo "--- app.py in its fork"; cat "$HUMANIZE_PATH/app.py"
  echo "--- summary activity on the fork"; api "/v1/activities?target=$HUMANIZE_WS&kind=summary" | jq .
} >"$OUT/04-worker.log" 2>&1
open_thread "$HUMANIZE"
shot 04-humanize-worker
c4() {
  [[ $(run_status "$HUMANIZE" 1) == completed ]] && grep -q '^humanize:' "$OUT/04-worker.log" &&
    grep -qE '^Name: humanize|site-packages/humanize/__init__.py' "$OUT/04-worker.log" &&
    grep -q naturalsize_demo "$HUMANIZE_PATH/app.py" &&
    [[ $(api "/v1/activities?target=$HUMANIZE_WS&kind=summary" | jq 'length') -ge 1 ]]
}
check 4 "The humanize worker installed humanize, committed on bookmark humanize in its fork, and its result is the fork's summary activity" "$OUT/04-worker.log" c4

# ---- 5. The lead merges -------------------------------------------------------
step 5 "the lead runs merge-brief, fetches and confirms merged"
lead_turn 'Merge the humanize worker'"'"'s fork into this workspace using only shell commands: run `trellis merge-brief humanize`, run the `jj git fetch` lines it prints, then make the working copy a merge of main and the fetched humanize bookmark (for example `jj new main humanize@<remote> -m "Merge humanize"`, with the remote the brief names), install humanize here the same way the worker did (environment changes are not merged automatically), and confirm with `trellis merged humanize SNAP` using the fork snapshot id from the brief. Reply with the snapshot id you confirmed.' 600 >"$OUT/05-turn.log"
open_thread "$LEAD"
shot 05-lead-merged
MERGED=$(api "/v1/activities?target=$LEAD_WS&kind=merged")
{
  echo "--- merged activity"; jq . <<<"$MERGED"
  echo "--- the lead's commands (from its provider log)"; provider_log "$LEAD" | grep -o '"command":"[^"]*trellis merge[^"]*"' | sort -u
  echo "--- app.py in the lead after the fetch"; cat "$LEAD_PATH/app.py"
  echo "--- trellis log"; tr_ log --target "$LEAD_PATH" --all
  echo "--- reply"; last_reply "$LEAD"
} >"$OUT/05-merge.log" 2>&1
c5() {
  jq -e --arg w "$HUMANIZE_WS" '.[0].data.fork == $w' <<<"$MERGED" >/dev/null &&
    grep -q naturalsize_demo "$LEAD_PATH/app.py" && grep -q 'trellis merge-brief humanize' "$OUT/05-merge.log"
}
check 5 "The lead ran trellis merge-brief humanize, fetched the bookmark (app.py now has naturalsize_demo) and confirmed it with trellis merged" "$OUT/05-merge.log" c5

# ---- 6. A third worker from the earlier checkpoint -------------------------
step 6 "a worker from the earlier checkpoint starts from that older state"
lead_turn 'Call the trellis_checkpoint tool now with name "after-merge" as the last action of this turn; when continued, reply only "ok".' 400 >"$OUT/06a-turn.log"
lead_turn "Call the delegate_task tool (mode \"async\") with title \"old-state worker\", workspace {\"fork\": {\"from\": \"$BASE\", \"name\": \"oldstate\"}} and task: \"Does app.py define naturalsize_demo? Answer yes or no and list the files here. Change nothing.\" Then end your turn." 400 >"$OUT/06b-turn.log"
OLD=$(wait_child_done "$LEAD" "old-state worker" 600)
OLD_WS_JSON=$(tr_ --json workspaces --spawned-by "$LEAD" | jq -c '.[] | select(.name=="oldstate")')
OLD_PATH=$(jq -r .path <<<"$OLD_WS_JSON")
open_thread "$OLD"
shot 06-old-state-worker
{
  echo "old-state fork: $OLD_WS_JSON"
  echo "--- its app.py"; cat "$OLD_PATH/app.py"
  echo "--- worker replies"; assistant_texts "$OLD"
} >"$OUT/06-old-state.log" 2>&1
c6() {
  [[ $(jq -r .parent_snapshot <<<"$OLD_WS_JSON") == "$BASE" ]] && ! grep -q naturalsize_demo "$OLD_PATH/app.py" &&
    assistant_texts "$OLD" | grep -qiE "\bno\b|does not|doesn't|not defined|only .*greet"
}
check 6 "A worker spawned from $BASE (before the merge) works in a fork without naturalsize_demo and says so" "$OUT/06-old-state.log" c6

# ---- 7. Revert refused while an in-workspace worker runs ---------------------
step 7 "revert refused naming a running worker in the workspace"
lead_turn 'Call the delegate_task tool (mode "async") with title "sleeper", workspace "parent" and task: "Run python3 -c '"'"'import time; time.sleep(300)'"'"' in the foreground and wait for it to exit, then reply done." Then end your turn.' 300 >"$OUT/07-turn.log"
SLEEPER=
for _ in $(seq 1 120); do
  SLEEPER=$(child_by_title "$LEAD" "sleeper")
  [[ -n $SLEEPER && $(run_status "$SLEEPER" 1) == running ]] && break
  sleep 1
done
sleep 10
open_thread "$LEAD"
edit_from "Call the delegate_task tool (mode \"async\") with title \"sleeper\""
shot 07a-edit-from-here
pwc <<'JS' >/dev/null
async page => {
  await page.getByRole('button', { name: 'Revert files too' }).click();
  await page.waitForTimeout(3000);
}
JS
shot 07b-revert-refused
REFUSAL=$(page_text | grep -o '"sleeper[^"]*" is still working in this Trellis workspace[^.]*\.' | head -1)
{
  echo "sleeper $SLEEPER run: $(run_status "$SLEEPER" 1)"
  echo "refusal: $REFUSAL"
  echo "lead runs rolled back: $(sql "select count(*) from orchestration_v2_projection_runs where thread_id='$LEAD' and status='rolled_back'")"
} >"$OUT/07-revert.log"
c7() { [[ -n $REFUSAL ]] && [[ $(sql "select count(*) from orchestration_v2_projection_runs where thread_id='$LEAD' and status='rolled_back'") == 0 ]]; }
check 7 "Revert files in the lead is refused while its in-workspace worker runs, naming it: $REFUSAL" "$OUT/07b-revert-refused.png" c7
# The sleeper is done with: later checkpoints would otherwise wait on it.
pwc <<'JS' >/dev/null
async page => {
  await page.keyboard.press('Escape');
}
JS
lead_turn 'Call the task_cancel tool for your "sleeper" task, then reply "cancelled".' 300 >"$OUT/07c-turn.log"

# ---- 8. Discard, unmerged in the trash, purge request confirmed -------------
step 8 "discard the tests fork; an agent's purge request confirmed in the UI"
lead_turn 'We will not merge the tests worker'"'"'s fork. Call the trellis_discard_fork tool with fork "tests". Then call trellis_discard_fork again with fork "tests", requestPurge true and reason "superseded by the humanize merge". Reply with whether Trellis reported unmerged work.' 400 >"$OUT/08-turn.log"
TRASH=$(api /v1/trash | jq -c --arg w "$TESTS_WS" '.workspaces[] | select(.id==$w)')
open_thread "$LEAD"
shot 08a-lead-discard
pwc <<JS >/dev/null
async page => {
  await page.goto($(js "$ORIGIN/settings/trellis"));
  await page.getByText('asked to purge it').first().waitFor({ timeout: 60000 });
}
JS
TRASH_UI=$(page_text | grep -A2 -m1 '^tests$')
shot 08b-trash-purge-request
pwc <<'JS' >/dev/null
async page => {
  const row = page.getByText('asked to purge it').first().locator('xpath=ancestor::*[.//button][1]');
  await row.getByRole('button', { name: 'Purge', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).waitFor({ timeout: 10000 });
}
JS
shot 08c-purge-confirm
pwc <<'JS' >/dev/null
async page => {
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.waitForTimeout(5000);
}
JS
shot 08d-purged
AFTER=$(api /v1/trash | jq -c --arg w "$TESTS_WS" '[.workspaces[] | select(.id==$w)] | length')
{
  echo "trash entry before the purge: $TRASH"
  echo "--- trash in the UI"; echo "$TRASH_UI"
  echo "entries for $TESTS_WS after the purge: $AFTER"
  echo "--- lead reply"; last_reply "$LEAD"
} >"$OUT/08-discard.log"
c8() {
  jq -e '.unmerged == true and .purge_requested != null and .expires_at == null' <<<"$TRASH" >/dev/null &&
    [[ $AFTER == 0 && ! -d $TESTS_PATH ]]
}
check 8 "trellis_discard_fork trashed the tests fork (unmerged, kept until purged) and filed a purge request, which the trash showed and the user confirmed" "$OUT/08-discard.log" c8

# ---- 9. Fork workspace -----------------------------------------------------------
step 9 "Fork workspace makes a visible fork whose thread is a lead"
settings_workspaces "$PROJECT_NAME" >/dev/null
pwc <<'JS' >/dev/null
async page => {
  await page.getByRole('button', { name: 'Fork…' }).first().click();
  await page.getByRole('dialog').getByText('after-merge').waitFor({ timeout: 30000 });
  await page.getByLabel('Name (optional)').fill('try-b');
}
JS
shot 09a-fork-dialog
pwc <<'JS' >/dev/null
async page => {
  await page.getByRole('button', { name: 'Fork', exact: true }).click();
  await page.waitForURL((url) => url.pathname.startsWith('/draft/'), { timeout: 120000 });
  await page.waitForTimeout(1500);
}
JS
shot 09b-fork-draft
select_model Claude "$CLAUDE_MODEL_LABEL" >/dev/null
FORK_LEAD=$(send "Reply with the names of the files in this folder, nothing else.")
F1=$(wait_run "$FORK_LEAD" 1 300)
TRYB=$(tr_ --json workspaces | jq -c --arg p "$PROJECT_ID" '.[] | select(.name=="try-b" and .project_id==$p)')
goto /
FILTER9=$(project_filter_options)
shot 09c-fork-visible
{
  echo "try-b: $TRYB"
  echo "fork lead $FORK_LEAD in $(thread_root "$FORK_LEAD"): run $F1, relationship $(sql "select coalesce(json_extract(payload_json,'\$.lineage.relationshipToParent'),'none') from orchestration_v2_projection_threads where thread_id='$FORK_LEAD'")"
  echo "--- project filter"; echo "$FILTER9"
} >"$OUT/09-fork-workspace.log"
c9() {
  jq -e '.spawned_by == null' <<<"$TRYB" >/dev/null && [[ $F1 == completed ]] &&
    [[ $(thread_root "$FORK_LEAD") == $(jq -r .path <<<"$TRYB") ]] && grep -qx "$PROJECT_NAME · try-b" <<<"$FILTER9"
}
check 9 "\"Fork workspace\" from after-merge made try-b without spawned_by, listed in the sidebar, where a new thread is a lead" "$OUT/09-fork-workspace.log" c9

# ---- score (optional) ---------------------------------------------------------
if [[ ${DEMO_SCORE:-} == 1 ]]; then
  step 10 "score: 10 checkpoints, 10 single fork spawns"
  open_thread "$LEAD"
  SINCE=$(date -u +%FT%TZ)
  lead_turn 'Score run: take 10 checkpoints in a row with the trellis_checkpoint tool, named score-1 through score-10. Call it with score-1 now; each time you are continued with a result, immediately call it again with the next name, without other tool calls or text. After score-10, reply "all done".' 1200 >/dev/null
  SPAWN_SINCE=$(date -u +%FT%TZ)
  for i in $(seq 1 10); do
    lead_turn "Call the delegate_task tool once (mode \"async\") with title \"score w$i\", workspace {\"fork\": {\"from\": \"latest\", \"name\": \"score-w$i\"}} and task \"Reply ok, using no tools.\" Then end your turn." 300 >/dev/null
    wait_child_done "$LEAD" "score w$i" 300 >/dev/null
  done
  python3 - "$DB" "$LEAD" "$SINCE" "$SPAWN_SINCE" "$HOME_DIR/userdata/logs/provider/events.$LEAD.log" >"$OUT/10-score.log" <<'PY'
import sqlite3, json, sys, statistics, datetime as dt, re
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
lead, since, spawn_since, log = sys.argv[2:6]
ts = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
def pct(xs, p):
    xs = sorted(xs); k = (len(xs) - 1) * p; f = int(k); c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)
def tool_starts(name, lo, hi=None):
    out = []
    for (p,) in db.execute("select payload_json from orchestration_v2_projection_turn_items where thread_id=? and type='dynamic_tool' and json_extract(payload_json,'$.toolName')=?", (lead, name)):
        t = ts(json.loads(p)["startedAt"])
        if t >= ts(lo) and (hi is None or t < ts(hi)): out.append(t)
    return sorted(out)
turns = sorted(ts(s) for (s,) in db.execute("select started_at from orchestration_v2_projection_provider_turns where thread_id=? and started_at is not null", (lead,)))
cp = [next(t for t in turns if t > t0 + 0.05) - t0 for t0 in tool_starts("mcp__t3-code__trellis_checkpoint", since, spawn_since)]
kids = []
for (tid, created) in db.execute("select thread_id, created_at from orchestration_v2_projection_threads where json_extract(payload_json,'$.lineage.parentThreadId')=? and created_at>=? order by created_at", (lead, spawn_since)):
    run = db.execute("select json_extract(payload_json,'$.startedAt') from orchestration_v2_projection_runs where thread_id=? and ordinal=1", (tid,)).fetchone()[0]
    first = db.execute("select min(started_at) from orchestration_v2_projection_provider_turns where thread_id=?", (tid,)).fetchone()[0]
    kids.append((ts(created), ts(run) if run else None, ts(first) if first else None))
starts = tool_starts("mcp__t3-code__delegate_task", spawn_since)
spawns = [k[2] - t0 for t0, k in zip(starts, kids) if k[2]]
for t0, (created, run, first) in zip(starts, kids):
    print(f"  spawn: child created +{created - t0:.2f} s, run started +{(run or t0) - t0:.2f} s, first provider turn +{(first or t0) - t0:.2f} s")
for name, xs in (("checkpoint -> continuation turn start", cp), ("fork spawn -> worker's first turn", spawns)):
    print(f"{name}: n={len(xs)} median {statistics.median(xs):.2f} s p95 {pct(xs, 0.95):.2f} s  [{' '.join(f'{x:.2f}' for x in xs)}]")
reads = []
for line in open(log):
    if line[1:20] < since[:19] or line[1:20] >= spawn_since[:19] or '"stop_reason"' not in line: continue
    m = re.search(r'"cache_creation_input_tokens":(\d+),"cache_read_input_tokens":(\d+)', line)
    if m: reads.append((int(m.group(1)), int(m.group(2))))
reads = list(dict.fromkeys(reads))
shares = [r / (w + r) for w, r in reads if w + r]
print(f"continuation turns: cache read share min {min(shares):.1%} max {max(shares):.1%} over {len(shares)} results")
PY
  cat "$OUT/10-score.log" | tee -a "$OUT/demo.log"
  c10() { grep -q 'n=10' "$OUT/10-score.log" && [[ $(grep -c 'n=10' "$OUT/10-score.log") == 2 ]]; }
  check 10 "Score measured over 10 checkpoints and 10 single fork spawns: $(tr '\n' ';' <"$OUT/10-score.log")" "$OUT/10-score.log" c10
fi

# The T3 database, for checking any number above.
sqlite3 "$DB" "VACUUM INTO '$OUT/t3-state.sqlite'" 2>/dev/null
print_checklist
