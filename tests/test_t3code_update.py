#!/usr/bin/env python3
"""Integration tests for safe T3 updater and installer state transitions."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class T3CodeUpdateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "dotfiles"
        self.home = Path(self.temp.name) / "home"
        self.bin = Path(self.temp.name) / "bin"
        self.log = Path(self.temp.name) / "commands.log"
        for directory in (
            self.root / "scripts",
            self.root / "config/t3code",
            self.home / "projects",
            self.bin,
        ):
            directory.mkdir(parents=True, exist_ok=True)

        for name in ("t3code-update", "t3code-install", "t3code-run", "t3code-pair"):
            shutil.copy2(ROOT / "scripts" / name, self.root / "scripts" / name)
        shutil.copy2(
            ROOT / "config/t3code/t3code.service",
            self.root / "config/t3code/t3code.service",
        )
        (self.root / "config/t3code/VERSION").write_text("1.2.3\n")

        self._write_executable(
            self.root / "scripts/t3code-build",
            """#!/usr/bin/env bash
set -euo pipefail
printf 'builder' >> "$MOCK_LOG"
printf ' %q' "$@" >> "$MOCK_LOG"
printf '\\n' >> "$MOCK_LOG"
[[ ${MOCK_BUILD_FAIL:-0} == 0 ]] || exit 42
if [[ " $* " == *' --check '* ]]; then
  printf 'commit %s\\n' "${MOCK_COMMIT}"
  exit 0
fi
output=''
while (($#)); do
  if [[ $1 == --output ]]; then output=$2; shift 2; else shift; fi
done
mkdir -p "$output"
printf '%s' "${MOCK_PACKAGE:-artifact-one}" > "$output/package.tgz"
printf '{"commit":"%s"}\\n' "$MOCK_COMMIT" > "$output/build.json"
""",
        )
        self._write_executable(
            self.bin / "node",
            """#!/usr/bin/env bash
set -euo pipefail
printf 'node' >> "$MOCK_LOG"; printf ' %q' "$@" >> "$MOCK_LOG"; printf '\\n' >> "$MOCK_LOG"
if [[ ${1:-} == -p && ${2:-} == process.execPath ]]; then readlink -f "$0"; exit 0; fi
if [[ ${1:-} == -p && ${2:-} == JSON.parse* ]]; then
  /usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"])' "$3"
  exit 0
fi
if [[ ${1:-} == -p && ${2:-} == require* ]]; then printf '%s\\n' "${MOCK_INSTALLED_VERSION:-9.8.7}"; exit 0; fi
[[ ${1:-} == */t3code-forgejo.mjs ]] && exit 0
[[ ${2:-} == --help ]] && exit 0
exit 2
""",
        )
        self._write_executable(
            self.bin / "npm",
            """#!/usr/bin/env bash
set -euo pipefail
printf 'npm' >> "$MOCK_LOG"; printf ' %q' "$@" >> "$MOCK_LOG"; printf '\\n' >> "$MOCK_LOG"
if [[ ${1:-} == view ]]; then printf '%s\\n' "${MOCK_NPM_VERSION:-1.2.4}"; exit 0; fi
[[ ${MOCK_NPM_FAIL:-0} == 0 ]] || exit 51
prefix=''
while (($#)); do
  if [[ $1 == --prefix ]]; then prefix=$2; shift 2; else shift; fi
done
mkdir -p "$prefix/node_modules/t3/dist"
printf 'export {}\\n' > "$prefix/node_modules/t3/dist/bin.mjs"
printf '{"version":"%s"}\\n' "${MOCK_INSTALLED_VERSION:-9.8.7}" > "$prefix/node_modules/t3/package.json"
""",
        )
        self._write_executable(
            self.bin / "systemctl",
            """#!/usr/bin/env bash
printf 'systemctl' >> "$MOCK_LOG"; printf ' %q' "$@" >> "$MOCK_LOG"; printf '\\n' >> "$MOCK_LOG"
""",
        )
        self._write_executable(self.bin / "curl", "#!/usr/bin/env bash\nexit 0\n")

        self.source = Path(self.temp.name) / "source"
        self.source.mkdir()
        self.env = os.environ.copy()
        self.env.update(
            HOME=str(self.home),
            PATH=f"{self.bin}:{self.env['PATH']}",
            MOCK_LOG=str(self.log),
            MOCK_COMMIT="a" * 40,
            T3CODE_BASE=str(self.home / "t3data"),
            T3CODE_WORKDIR=str(self.home / "projects"),
            T3CODE_NODE=str(self.bin / "node"),
        )
        subprocess.run(
            ["git", "init", "-q"], cwd=self.root, check=True, env=self.env
        )
        subprocess.run(
            ["git", "add", "config/t3code/VERSION"],
            cwd=self.root,
            check=True,
            env=self.env,
        )
        subprocess.run(
            [
                "git", "-c", "user.name=T3 Test", "-c", "user.email=t3@example.invalid",
                "commit", "-qm", "test baseline",
            ],
            cwd=self.root,
            check=True,
            env=self.env,
        )

    @staticmethod
    def _write_executable(path: Path, body: str) -> None:
        path.write_text(body)
        path.chmod(0o755)

    def run_update(self, *args: str, **overrides: str) -> subprocess.CompletedProcess[str]:
        env = self.env | overrides
        return subprocess.run(
            [str(self.root / "scripts/t3code-update"), *args],
            cwd=self.root,
            env=env,
            text=True,
            capture_output=True,
        )

    def run_install(self, *args: str, **overrides: str) -> subprocess.CompletedProcess[str]:
        env = self.env | overrides
        return subprocess.run(
            [str(self.root / "scripts/t3code-install"), *args],
            cwd=self.root,
            env=env,
            text=True,
            capture_output=True,
        )

    def commands(self) -> str:
        return self.log.read_text() if self.log.exists() else ""

    def version(self) -> str:
        return (self.root / "config/t3code/VERSION").read_text()

    def git(self, repo: Path, *args: str) -> str:
        result = subprocess.run(
            ["git", *args], cwd=repo, env=self.env, text=True, capture_output=True, check=True
        )
        return result.stdout.strip()

    def make_source_repo(self) -> tuple[Path, str, str]:
        source = Path(self.temp.name) / "real-source"
        source.mkdir()
        self.git(source, "init", "-q")
        (source / "selected.txt").write_text("first\n")
        self.git(source, "add", "selected.txt")
        self.git(
            source, "-c", "user.name=T3 Test", "-c", "user.email=t3@example.invalid",
            "commit", "-qm", "first",
        )
        first = self.git(source, "rev-parse", "HEAD")
        (source / "selected.txt").write_text("second\n")
        self.git(source, "add", "selected.txt")
        self.git(
            source, "-c", "user.name=T3 Test", "-c", "user.email=t3@example.invalid",
            "commit", "-qm", "second",
        )
        second = self.git(source, "rev-parse", "HEAD")
        return source, first, second

    def run_real_build_check(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(ROOT / "scripts/t3code-build"), *args, "--check"],
            cwd=self.root,
            env=self.env,
            text=True,
            capture_output=True,
        )

    def test_default_update_checks_forgejo_without_installing(self) -> None:
        result = self.run_update("--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.log.read_text()
        self.assertIn("t3code-forgejo.mjs check", commands)
        self.assertNotIn("npm view", commands)
        self.assertNotIn("systemctl", commands)

    def test_default_update_yes_installs_forgejo(self) -> None:
        result = self.run_update("--yes", "0.0.40-forgejo.2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("t3code-forgejo.mjs install --version 0.0.40-forgejo.2 --yes", self.log.read_text())

    def test_real_builder_local_head_requires_clean_but_ref_is_exact(self) -> None:
        source, first, _second = self.make_source_repo()
        (source / "selected.txt").write_text("dirty\n")

        default = self.run_real_build_check("--source", str(source))
        selected = self.run_real_build_check("--source", str(source), "--ref", first)

        self.assertNotEqual(default.returncode, 0)
        self.assertIn("source checkout is dirty", default.stderr)
        self.assertEqual(selected.returncode, 0, selected.stderr)
        self.assertIn(f"commit={first}\n", selected.stdout)
        self.assertEqual((source / "selected.txt").read_text(), "dirty\n")

    def test_real_builder_remote_tag_and_branch_resolve_without_modifying_repo(self) -> None:
        source, first, second = self.make_source_repo()
        self.git(source, "tag", "release-test", first)
        self.git(source, "branch", "build-test", second)
        before_head = self.git(source, "rev-parse", "HEAD")
        before_status = self.git(source, "status", "--porcelain=v1")
        remote = source.as_uri()

        for ref, expected in (("release-test", first), ("build-test", second)):
            with self.subTest(ref=ref):
                result = self.run_real_build_check("--repo", remote, "--ref", ref)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"commit={expected}\n", result.stdout)

        self.assertEqual(self.git(source, "rev-parse", "HEAD"), before_head)
        self.assertEqual(self.git(source, "status", "--porcelain=v1"), before_status)

    def test_source_check_is_read_only(self) -> None:
        before = self.version()
        result = self.run_update("--source", str(self.source), "--ref", "topic", "--check")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.version(), before)
        self.assertIn("--source", self.commands())
        self.assertIn("--ref topic", self.commands())
        self.assertIn("--check", self.commands())
        self.assertNotIn("npm", self.commands())
        self.assertNotIn("systemctl", self.commands())
        self.assertFalse((self.home / ".config/t3code/update.lock").exists())

    def test_build_only_retains_artifact_without_installing(self) -> None:
        output = Path(self.temp.name) / "retained"
        result = self.run_update(
            "--source", str(self.source), "--build-only", "--output", str(output)
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((output / "package.tgz").is_file())
        self.assertEqual(self.version(), "1.2.3\n")
        self.assertNotIn("npm", self.commands())
        self.assertNotIn("systemctl", self.commands())

    def test_custom_deploy_uses_exact_artifact_build_id_and_leaves_pin(self) -> None:
        package = b"chosen artifact"
        expected = f"git-{'a' * 40}-{hashlib.sha256(package).hexdigest()[:12]}"
        result = self.run_update(
            "--repo", "https://example.invalid/fork.git", "--ref", "feature", "--yes",
            MOCK_PACKAGE=package.decode(),
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.version(), "1.2.3\n")
        service_env = (self.home / ".config/t3code/service.env").read_text()
        self.assertIn(f"T3CODE_BUILD_ID={expected}\n", service_env)
        self.assertIn(f"runtime/builds/{expected}/node_modules/t3/dist/bin.mjs", service_env)
        self.assertIn("--repo https://example.invalid/fork.git", self.commands())
        self.assertIn("--ref feature", self.commands())
        self.assertIn(f"runtime/builds/{expected}", self.commands())
        self.assertIn("systemctl --user restart t3code.service", self.commands())

    def test_failed_build_never_touches_installed_service(self) -> None:
        config = self.home / ".config/t3code"
        config.mkdir(parents=True)
        service_env = config / "service.env"
        service_env.write_text("T3CODE_BUILD_ID=existing\n")

        result = self.run_update("--source", str(self.source), "--yes", MOCK_BUILD_FAIL="1")

        self.assertEqual(result.returncode, 42)
        self.assertEqual(service_env.read_text(), "T3CODE_BUILD_ID=existing\n")
        self.assertEqual(self.version(), "1.2.3\n")
        self.assertNotIn("npm", self.commands())
        self.assertNotIn("systemctl", self.commands())

    def test_dirty_npm_version_pin_blocks_update_before_install(self) -> None:
        (self.root / "config/t3code/VERSION").write_text("1.2.2\n")
        result = self.run_update("--npm", "--yes")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("has staged or unstaged changes", result.stderr)
        self.assertEqual(self.version(), "1.2.2\n")
        self.assertNotIn("npm install", self.commands())
        self.assertNotIn("systemctl", self.commands())

    def test_failed_npm_update_restores_pin_when_custom_runtime_stays_selected(self) -> None:
        config = self.home / ".config/t3code"
        config.mkdir(parents=True)
        custom_entry = self.home / "t3data/runtime/builds/git-existing/node_modules/t3/dist/bin.mjs"
        service_env = config / "service.env"
        original_config = (
            "T3CODE_BUILD_ID=git-existing\n"
            f"T3CODE_NODE={self.bin / 'node'}\n"
            f"T3CODE_ENTRY={custom_entry}\n"
            f"T3CODE_BASE={self.home / 't3data'}\n"
            f"T3CODE_WORKDIR={self.home / 'projects'}\n"
        )
        service_env.write_text(original_config)

        result = self.run_update("--npm", "--yes", MOCK_NPM_FAIL="1")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.version(), "1.2.3\n")
        self.assertEqual(service_env.read_text(), original_config)
        self.assertIn("restoring the previous npm VERSION pin", result.stderr)
        self.assertNotIn("systemctl", self.commands())

    def test_failed_artifact_install_does_not_switch_service(self) -> None:
        config = self.home / ".config/t3code"
        config.mkdir(parents=True)
        service_env = config / "service.env"
        service_env.write_text("T3CODE_BUILD_ID=existing\nT3CODE_NODE=" + str(self.bin / "node") + "\n")
        artifact = Path(self.temp.name) / "broken.tgz"
        artifact.write_text("broken")

        result = self.run_install(
            "--package", str(artifact), "--build-id", "git-deadbeef", MOCK_NPM_FAIL="1"
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(service_env.read_text(), "T3CODE_BUILD_ID=existing\nT3CODE_NODE=" + str(self.bin / "node") + "\n")
        self.assertNotIn("systemctl", self.commands())

    def test_build_id_collision_rejects_different_artifact_before_switch(self) -> None:
        build_id = "git-collision"
        runtime = self.home / "t3data/runtime/builds" / build_id
        runtime.mkdir(parents=True)
        (runtime / ".install-complete").touch()
        (runtime / "package.sha256").write_text(hashlib.sha256(b"old").hexdigest() + "\n")
        config = self.home / ".config/t3code"
        config.mkdir(parents=True)
        service_env = config / "service.env"
        service_env.write_text("T3CODE_BUILD_ID=existing\nT3CODE_NODE=" + str(self.bin / "node") + "\n")
        artifact = Path(self.temp.name) / "new.tgz"
        artifact.write_bytes(b"new")

        result = self.run_install("--package", str(artifact), "--build-id", build_id)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("already exists with a different artifact", result.stderr)
        self.assertEqual(service_env.read_text(), "T3CODE_BUILD_ID=existing\nT3CODE_NODE=" + str(self.bin / "node") + "\n")
        self.assertNotIn("npm", self.commands())
        self.assertNotIn("systemctl", self.commands())


if __name__ == "__main__":
    unittest.main()
