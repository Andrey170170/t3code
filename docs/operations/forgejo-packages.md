# Custom server packages on Forgejo

The custom `t3` package includes the server CLI and built web client. Desktop
installers still use the existing `dist:desktop:*` commands; this npm workflow
installs the server on Linux or downloads its package on other machines.

The default registry is
`https://git.andrei-homelab.com/api/packages/git-god/npm/`. Override it with
`--registry URL` or `T3CODE_REGISTRY`. Forgejo SSH access is separate from npm
access: create a personal access token with package read/write permission for
publishing (read permission is sufficient for installation). Save it in a file
readable only by your account and set `PACKAGE_FOGEJO_TOKEN_FILE` to its path.
The helper uses a temporary npm authentication file and removes it afterward;
an existing user npmrc is also supported when no token file is supplied.

## Build and publish

From this checkout, with Node 24 and npm installed:

```bash
export PACKAGE_FOGEJO_TOKEN_FILE="$HOME/.config/local_packager/forgejo-token"
# Build committed source and publish the next numbered release.
npm run publish:forgejo
# Or preview first, retaining an artifact for later publication.
npm run publish:forgejo -- --ref HEAD --output /tmp/t3-package --dry-run
npm run publish:forgejo -- --artifact /tmp/t3-package
```

Without `--ref`, the source checkout must be clean. `--ref HEAD` explicitly
selects committed content, excluding any local edits. The builder uses an
isolated Git snapshot, the pinned package manager and frozen lockfile, and the
existing server/web production build. Versions look like
`0.0.40-forgejo.1`, then `.2`: each upstream base version has its own automatic
counter, selected from the versions already in Forgejo. Source metadata records
the exact commit. The `custom` tag selects the most recently published build,
including when upgrading from the older timestamp-based versions. Registry
lookup failures stop publication. Concurrent publishers can select the same
number; the loser must rebuild against the updated registry, never overwrite.
A dry run does not reserve its number. Without `--output`, the artifact is
retained in a printed temporary directory.
Keep `package.tgz` and `build.json` together for provenance and hash validation.

## Install without this repository

Normal npm works. Set `PACKAGE_FOGEJO_TOKEN_FILE` to a local token file on the
other machine, then run the following in a POSIX shell with Node 24 and npm:

```bash
(
  set -eu
  export NPM_CONFIG_USERCONFIG="$(mktemp)"
  trap 'rm -f "$NPM_CONFIG_USERCONFIG"' EXIT
  printf '//git.andrei-homelab.com/api/packages/git-god/npm/:_authToken=%s\n' \
    "$(cat "$PACKAGE_FOGEJO_TOKEN_FILE")" > "$NPM_CONFIG_USERCONFIG"
  registry='https://git.andrei-homelab.com/api/packages/git-god/npm/'
  npm install --global "$(npm view t3@custom dist.tarball --registry "$registry")"
)
t3 serve
```

This uses Forgejo for the `t3` tarball and your normal registry for its public
dependencies. Repeat the npm installation to update; replace `custom` with an
exact version to pin it. Use a writable npm global prefix or a Node version
manager. npm does not automatically read `PACKAGE_FOGEJO_TOKEN_FILE`; the
snippet creates a temporary registry authentication config from it. If you
already have Forgejo authentication in your npmrc, only the `npm install`
command (with the registry variable) is needed.

This installs the CLI and bundled web interface. `t3 serve` runs in the
foreground; it does not install the Linux user service. The service helper
below preserves the existing service settings and uses a separate state path.

## Download or install the Linux user service

Check out this repository for the small installation helpers; installation does
not build the application or require workspace dependencies. Alternatively,
copy `scripts/t3code-*` and `config/t3code/` preserving their relative layout.
Node and npm must already be available, and the machine must reach Forgejo.
Native dependencies may require platform build tools.

```bash
export PACKAGE_FOGEJO_TOKEN_FILE="$HOME/.config/local_packager/forgejo-token"
node scripts/t3code-forgejo.mjs check
node scripts/t3code-forgejo.mjs download --output /tmp/t3-download
# Installs the selected package, configures and restarts the user service.
node scripts/t3code-forgejo.mjs install --yes
# Or select an exact version:
node scripts/t3code-forgejo.mjs install --yes --version 0.0.40-forgejo.1
```

Downloads resolve `custom` to an exact version first. The installer consumes the
retrieved tarball, while runtime dependencies use the machine's normal npm
registry; it does not redirect public dependency lookups to Forgejo.

New services bind to loopback on port 3773 and use your home directory as the
working directory. For a remotely reachable first install, set `T3CODE_HOST`,
`T3CODE_ORIGIN`, and optionally `T3CODE_PORT` and `T3CODE_WORKDIR`. Existing
`~/.config/t3code/service.env` settings are preserved. New state defaults to
`~/.local/share/t3code`; existing `~/.t3` is not used. Run `t3code-pair DEVICE`
after installation to obtain a device pairing link. To start the user service
at boot, run `sudo scripts/t3code-enable-linger` once.

For subsequent updates, use `t3code-update --check`, then `t3code-update`
(prompts before restart) or `t3code-update --yes`. Forgejo is the default;
`t3code-update --npm` explicitly selects upstream npm releases. Finish active work before installation: it
restarts the service, retains older runtimes, and does not automatically undo
database migrations or create a backup.

These helpers were ported from `~/dotfiles`. Existing dotfiles entry points are
unchanged until installation from this repository replaces the updater link.

Upstream 0.0.41 and later ship executable archives, while this fork's Forgejo
channel retains the Node-based npm package and the service helpers above.
Use `t3code-update` or reinstall from Forgejo to update these builds. Built-in
`t3 update` and remote server updates reject Forgejo builds because those paths
download upstream executable archives. Do not use `t3 service install` to replace
the custom service; use the Forgejo installer above to preserve its settings.
