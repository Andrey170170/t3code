#!/usr/bin/env python3
"""Exercise Forgejo release boundaries without network or service access."""

from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.0.13-forgejo.20260913.g123456789abc"
REGISTRY = "https://forgejo.example.invalid/api/packages/test-owner/npm/"


class T3CodeForgejoTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        scripts = self.root / "scripts"
        scripts.mkdir()
        shutil.copy2(ROOT / "scripts/t3code-forgejo.mjs", scripts / "t3code-forgejo.mjs")
        installer = scripts / "t3code-install"
        installer.write_text("#!/bin/sh\necho 'Service installation forbidden in tests' >&2\nexit 99\n")
        installer.chmod(0o755)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "npm.jsonl"
        self.artifact = self.root / "artifact"
        self.artifact.mkdir()
        manifest = json.dumps({"name": "t3", "version": VERSION}).encode()
        tarball = self.artifact / "package.tgz"
        with tarfile.open(tarball, "w:gz") as archive:
            entry = tarfile.TarInfo("package/package.json")
            entry.size = len(manifest)
            archive.addfile(entry, io.BytesIO(manifest))
        (self.artifact / "build.json").write_text(json.dumps({
            "version": VERSION,
            "sha256": hashlib.sha256(tarball.read_bytes()).hexdigest(),
        }))
        npm = self.bin / "npm"
        npm.write_text("""#!/usr/bin/python3
import json, os, pathlib, shutil, sys
args = sys.argv[1:]
if os.environ.get('MOCK_EXPECT_TOKEN'):
    config = pathlib.Path(os.environ['NPM_CONFIG_USERCONFIG'])
    assert config.stat().st_mode & 0o777 == 0o600
    assert os.environ['MOCK_EXPECT_TOKEN'] in config.read_text()
    pathlib.Path(os.environ['MOCK_CONFIG_PATH']).write_text(str(config))
with open(os.environ['MOCK_NPM_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
if args[0] == 'view':
    if args[1] == 't3':
        print(os.environ.get('MOCK_VERSIONS', '[]'))
        sys.exit(int(os.environ.get('MOCK_VIEW_STATUS', '0')))
    print(json.dumps(os.environ['MOCK_VERSION']))
elif args[0] == 'pack':
    output = pathlib.Path(args[args.index('--pack-destination') + 1])
    shutil.copyfile(os.environ['MOCK_ARTIFACT'], output / 't3-custom.tgz')
    print(json.dumps([{'filename': 't3-custom.tgz'}]))
elif args[0] == 'publish':
    assert '--dry-run' in args, 'Real publishing is forbidden in tests'
else:
    raise SystemExit('Unexpected npm command')
""")
        npm.chmod(0o755)
        node = shutil.which("node")
        self.assertIsNotNone(node)
        self.node = node
        self.env = os.environ | {
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "MOCK_NPM_LOG": str(self.log),
            "MOCK_VERSION": VERSION,
            "MOCK_ARTIFACT": str(tarball),
        }
        self.env.pop("PACKAGE_FOGEJO_TOKEN_FILE", None)

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [self.node, str(self.root / "scripts/t3code-forgejo.mjs"), *args],
            env=self.env, text=True, capture_output=True,
        )

    def calls(self) -> list[list[str]]:
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_invalid_registry_rejected_before_npm(self) -> None:
        for registry in (
            "http://forgejo.example.invalid/api/packages/test/npm/",
            "https://registry.npmjs.org/",
            "https://secret@forgejo.example.invalid/api/packages/test/npm/",
            REGISTRY + "?token=secret",
            REGISTRY + "#fragment",
        ):
            with self.subTest(registry=registry):
                result = self.run_cli("check", "--registry", registry)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Expected an HTTPS Forgejo registry URL", result.stderr)
                self.assertEqual(self.calls(), [])

    def test_integrity_mismatch_rejected_before_publish(self) -> None:
        (self.artifact / "package.tgz").write_bytes(b"replaced artifact")
        result = self.run_cli("publish", "--artifact", str(self.artifact), "--registry", REGISTRY, "--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Artifact hash does not match", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_dry_run_targets_explicit_registry_and_custom_tag(self) -> None:
        result = self.run_cli("publish", "--artifact", str(self.artifact), "--registry", REGISTRY, "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [
            ["view", "t3", "versions", "--registry", REGISTRY, "--json"], [
            "publish", str(self.artifact / "package.tgz"), "--registry", REGISTRY,
            "--tag", "custom", "--ignore-scripts", "--dry-run",
        ]])

    def test_download_pins_tag_resolution_before_pack(self) -> None:
        output = self.root / "download"
        result = self.run_cli("download", "--output", str(output), "--registry", REGISTRY)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [
            ["view", "t3@custom", "version", "--registry", REGISTRY, "--json"],
            ["pack", f"t3@{VERSION}", "--registry", REGISTRY,
             "--pack-destination", str(output), "--ignore-scripts", "--json"],
        ])
        self.assertEqual((output / "t3-custom.tgz").read_bytes(), (self.artifact / "package.tgz").read_bytes())

    def test_install_requires_yes_before_npm_or_service(self) -> None:
        result = self.run_cli("install", "--registry", REGISTRY)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Pass --yes", result.stderr)
        self.assertEqual(self.calls(), [])


    def prepare_source_build(self) -> None:
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        manifest = self.root / "apps/server/package.json"
        manifest.parent.mkdir(parents=True)
        manifest.write_text(json.dumps({"version": "0.0.13"}))
        subprocess.run(["git", "-C", str(self.root), "add", "apps"], check=True)
        subprocess.run([
            "git", "-C", str(self.root), "-c", "user.name=Test",
            "-c", "user.email=test@example.invalid", "commit", "-qm", "source",
        ], check=True)
        builder = self.root / "scripts/t3code-build"
        builder.write_text("""#!/usr/bin/python3
import hashlib, io, json, pathlib, subprocess, sys, tarfile
args = sys.argv[1:]
source = args[args.index('--source') + 1]
if '--check' in args:
    commit = subprocess.check_output(['git', '-C', source, 'rev-parse', 'HEAD'], text=True).strip()
    print('commit=' + commit)
    sys.exit(0)
version = args[args.index('--app-version') + 1]
output = pathlib.Path(args[args.index('--output') + 1])
output.mkdir(parents=True, exist_ok=True)
manifest = json.dumps({'name': 't3', 'version': version}).encode()
tarball = output / 'package.tgz'
with tarfile.open(tarball, 'w:gz') as archive:
    member = tarfile.TarInfo('package/package.json')
    member.size = len(manifest)
    archive.addfile(member, io.BytesIO(manifest))
(output / 'build.json').write_text(json.dumps({
    'version': version, 'sha256': hashlib.sha256(tarball.read_bytes()).hexdigest(),
}))
""")
        builder.chmod(0o755)

    def test_counter_selects_next_release_for_upstream_base(self) -> None:
        self.prepare_source_build()
        self.env["MOCK_VERSIONS"] = json.dumps([
            "0.0.13-forgejo.2", "0.0.13-forgejo.12",
            "0.0.14-forgejo.99", VERSION,
        ])
        output = self.root / "new-release"
        result = self.run_cli("publish", "--output", str(output), "--registry", REGISTRY, "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((output / "build.json").read_text())["version"], "0.0.13-forgejo.13")

    def test_missing_package_starts_at_one(self) -> None:
        self.prepare_source_build()
        self.env["MOCK_VERSIONS"] = json.dumps({"error": {"code": "E404"}})
        self.env["MOCK_VIEW_STATUS"] = "1"
        output = self.root / "first-release"
        result = self.run_cli("publish", "--output", str(output), "--registry", REGISTRY, "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((output / "build.json").read_text())["version"], "0.0.13-forgejo.1")

    def test_registry_errors_do_not_allocate_or_publish(self) -> None:
        self.prepare_source_build()
        for response in ('{"error":{"code":"E401"}}', '{"error":{"code":"E503"}}', 'broken'):
            with self.subTest(response=response):
                self.env["MOCK_VERSIONS"] = response
                self.env["MOCK_VIEW_STATUS"] = "1"
                output = self.root / "failed-release"
                result = self.run_cli("publish", "--output", str(output), "--registry", REGISTRY, "--dry-run")
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((output / "package.tgz").exists())
                self.assertFalse(any(call[0] == "publish" for call in self.calls()))

    def test_existing_artifact_version_is_never_republished(self) -> None:
        self.env["MOCK_VERSIONS"] = json.dumps([VERSION])
        result = self.run_cli("publish", "--artifact", str(self.artifact), "--registry", REGISTRY, "--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("already exists", result.stderr)
        self.assertFalse(any(call[0] == "publish" for call in self.calls()))

    def test_counter_version_can_be_installed(self) -> None:
        self.env["MOCK_VERSION"] = "0.0.13-forgejo.3"
        result = self.run_cli("check", "--version", "0.0.13-forgejo.3", "--registry", REGISTRY)
        self.assertEqual(result.returncode, 0, result.stderr)


    def test_publish_without_output_retains_artifact(self) -> None:
        self.prepare_source_build()
        result = self.run_cli("publish", "--registry", REGISTRY, "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        output_line = next(line for line in result.stdout.splitlines() if line.startswith("Artifact directory: "))
        output = Path(output_line.removeprefix("Artifact directory: "))
        self.addCleanup(shutil.rmtree, output)
        self.assertTrue((output / "package.tgz").is_file())
        self.assertEqual(json.loads((output / "build.json").read_text())["version"], "0.0.13-forgejo.1")

    def test_shared_token_file_uses_private_temporary_config(self) -> None:
        token_file = self.root / "token"
        token_file.write_text("fake-test-token")
        token_file.chmod(0o600)
        config_path = self.root / "config-path"
        self.env.update({
            "PACKAGE_FOGEJO_TOKEN_FILE": str(token_file),
            "MOCK_EXPECT_TOKEN": "fake-test-token",
            "MOCK_CONFIG_PATH": str(config_path),
        })
        result = self.run_cli("check", "--registry", REGISTRY)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("fake-test-token", result.stdout + result.stderr)
        self.assertFalse(Path(config_path.read_text()).exists())


if __name__ == "__main__":
    unittest.main()
