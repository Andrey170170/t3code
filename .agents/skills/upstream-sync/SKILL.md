---
name: upstream-sync
description: Bring upstream pingdotgg/t3code into this fork's dev_vm in three gated stages, a scout report, the merge, then a Forgejo release. Use when asked to sync, merge, or pull upstream changes.
---

# Sync upstream into dev_vm

Three stages. The scout ends at a report and an **approval gate**: the merge and
release start only after Andrei approves that report. Each stage's criterion
says when it is done.

The scratch worktree lives outside the repository (`/tmp/t3-merge-scout`), so
the main checkout stays clean on `dev_vm` until the merge is approved. Every
command names `dev_vm` rather than `HEAD`, since the skill may run from another
branch. Shell variables do not survive the approval gate, so recompute `MB`
when a later stage needs it.

## 1. Scout

```bash
git fetch upstream && git fetch origin   # local dev_vm must equal origin/dev_vm
MB=$(git merge-base dev_vm upstream/main)
git worktree add --detach /tmp/t3-merge-scout dev_vm
cd /tmp/t3-merge-scout && git merge --no-ff --no-commit upstream/main
```

Gather, in the scratch worktree:

- **What's new**: `git log --no-merges $MB..upstream/main`, with commit types
  counted and every `feat`/`perf` read. Highlight changes that touch fork
  features, migrations, updating, or the mobile native build.
- **Conflicts**: resolve each one in the scratch tree, keeping the fork's intent
  on upstream's new structure. Use `resolving-merge-conflicts` for anything
  non-trivial.
- **Overlap**: files changed on both sides,
  `comm -12 <(git diff --name-only $MB dev_vm | sort) <(git diff --name-only $MB upstream/main | sort)`.
  A clean textual merge can still break a fork feature, so read the upstream
  commits behind each overlapping file.
- **Redundant fork patches**: for each fork feature or fix
  (`git log --no-merges upstream/main..dev_vm`), check whether upstream now does
  the same thing. If it does, propose dropping the fork's version.
- **Migration ledger**: list upstream's new migrations, and read the live ledger
  read-only:
  `sqlite3 "file:$HOME/.local/share/t3code/userdata/statev2.sqlite?mode=ro" "select * from effect_sql_migrations order by migration_id"`.
  Every recorded id must carry upstream's name. The fork never adds rows to this
  ledger; fork schema goes in its own table.
- **Build health**: install dependencies, then typecheck each package that
  holds a file from `git diff --name-only $MB dev_vm`. Upstream CI covers the
  rest. Then run these tests (see Gotchas): the fork's
  (`git diff --name-only $MB dev_vm -- '*.test.ts' '*.test.tsx'`), the tests for
  overlapping files, and every test upstream added or changed in a directory
  that holds a fork-changed file. New upstream tests there can assert behavior
  the fork deliberately changed.

Done when the report covers: what's new, every conflict and its resolution, each
adaptation that the typecheck or tests forced, redundant fork patches, semantic
gaps found in the overlap (each with a recommendation: fix now or follow up),
the migration ledger, and typecheck and test results. Present the report, then
stop and wait for approval.

## 2. Merge

1. Fetch again. If `upstream/main` moved, copy the resolved files out, stage
   everything, `git merge --abort`, and merge the new tip. Restore a saved
   resolution only for a file that
   `git diff --name-only <old tip> upstream/main` does not list. Resolve the
   listed files again, since a copy would discard upstream's newer content.
   Then rerun typecheck and tests.
2. Commit in the scratch worktree as
   `merge(upstream): integrate <Month D> updates with fork compatibility`. The
   body names each adaptation and why, with no list of upstream features.
3. The pre-commit hook formats staged files, so check that the result still
   differs from upstream only in fork files. This must print nothing:
   `comm -23 <(git diff --name-only upstream/main HEAD | sort) <(git diff --name-only $(git merge-base dev_vm upstream/main) dev_vm | sort)`
   (run before the fast-forward, while `dev_vm` is still the pre-merge tip).
4. In the main checkout, `git merge --ff-only <merge commit>`, then
   `git push origin dev_vm`.

Done when `dev_vm` on origin is the verified merge commit.

## 3. Release

Follow [Forgejo package operations](../../../docs/operations/forgejo-packages.md),
but run its stages one at a time instead of `npm run release:forgejo`, which
starts Android straight after the WSL desktop build:

1. `node scripts/t3code-forgejo.mjs publish --output /tmp/t3-release-artifact`.
   Read the version and commit from its `build.json`.
2. `scripts/t3code-desktop-release --version V --ref C`.
3. Before Android, confirm WSL is idle and the Windows host has room for this
   VM to grow to about 18 GB. A starved Android build freezes the VM. WSL's own
   `uptime` and `free` should show it idle, and the host's free memory should
   cover the VM's growth (18 GB minus `free -g` total here):
   `ssh wsl_worker '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB"'`.
   Then run `scripts/t3code-android-release --version V --ref C`, and keep an
   eye on swap here while it builds.
4. Download the published server package
   (`node scripts/t3code-forgejo.mjs download --version V --output DIR`) and
   compare its hash with the built artifact.

Done when the report gives the version, the commit, the hash match, and each
client build's outcome. A failed client build is retried on its own, never by
releasing again. Releasing does not install anything or restart a service.

Finish with `git worktree remove --force /tmp/t3-merge-scout`.

## Gotchas

- `scripts/setup-worktree.ts` needs `T3CODE_PROJECT_ROOT`, and Volta cannot
  find `vp` in a worktree that has no `node_modules` yet. Install with the main
  checkout's binary:
  `/home/menshikov/projects/t3code/node_modules/.bin/vp i -- --yes`.
- Typecheck a package with `/tmp/t3-merge-scout/node_modules/.bin/tsc-rs --noEmit`
  run from its directory. It prints hundreds of Effect suggestions; only lines
  matching `: error TS` count.
- Run tests from the scratch root with `./node_modules/.bin/vp test run <files>`.
- `git merge --abort` refuses while edits are unstaged. Stage them first.
- New upstream tests can assert upstream behavior that the fork deliberately
  changed (security headers, version comparison). Update the test to the fork's
  behavior, and name it in the merge commit body.
