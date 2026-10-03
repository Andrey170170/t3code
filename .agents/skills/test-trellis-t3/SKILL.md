---
name: test-trellis-t3
description: Test T3's Trellis integration (Trellis threads, ideas, workspaces, previews, checkpoints, forks, the Trellis settings page) against a development Trellis instead of the live one. Use for any change to Trellis code in T3, or a flow that needs a Trellis root.
---

# Test T3 against a development Trellis

This extends [test-t3-app](../test-t3-app/SKILL.md): start the app, verify and
retain the same way, with the dev server pointed at a Trellis **dev root**
instead of the live Trellis (`/trellis`), which holds the user's real work.

## Start the dev Trellis

In the Trellis checkout (its `trellis-dev` skill has the details), use your
lane's dev root and port range:

```sh
export TRELLIS_DEV_ROOT=/trellis/dev-NAME
scripts/dev.sh up            # build, prepare, serve; prints login commands if needed
eval "$(scripts/dev.sh env)" # TRELLIS_ROOT, TRELLIS_CONFIG, TRELLIS_SOCKET, TRELLIS_BIN
"$TRELLIS_BIN" status        # agent_homes: the provider homes its workspaces mount
```

If `up` reports a home that is not logged in, ask the user to run the
printed login command; never log in yourself.

## Start T3 on it

Start `vp run dev` with the variables above in its environment, plus the
provider homes the dev root mounts, so Trellis threads run from them (a
thread whose provider home differs from the mounted one fails, naming both):

```sh
CLAUDE_CONFIG_DIR=~/.local/share/trellis-dev-homes/claude \
CODEX_HOME=~/.local/share/trellis-dev-homes/codex vp run dev
```

T3 then reads the dev root's socket; Settings → Trellis shows the root it
uses. Confirm that before testing: a dev server without
`TRELLIS_SOCKET` talks to the live Trellis.

## Verify and clean up

Exercise the flow, then check its Trellis side with `"$TRELLIS_BIN"`
(`workspaces`, `log`, `activities`, `ports`) or, when something fails,
Trellis's `trellis-debug` steps. When done, stop the workspaces the test
started (`"$TRELLIS_BIN" stop --target WS`), then `scripts/dev.sh down` in the
Trellis checkout, besides what test-t3-app retains or stops.
