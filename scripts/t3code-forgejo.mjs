#!/usr/bin/env node
// Publish immutable source builds, or fetch them before invoking the Linux installer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const { values, positionals } = NodeUtil.parseArgs({
  options: {
    registry: {
      type: "string",
      default:
        process.env.T3CODE_REGISTRY || "https://git.andrei-homelab.com/api/packages/git-god/npm/",
    },
    "token-file": { type: "string", default: process.env.PACKAGE_FOGEJO_TOKEN_FILE },
    source: { type: "string" },
    ref: { type: "string" },
    output: { type: "string" },
    artifact: { type: "string" },
    version: { type: "string", default: "custom" },
    "dry-run": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: true,
});
if (values.help) {
  console.log(`Usage:
  node scripts/t3code-forgejo.mjs publish [--output DIR] [--source PATH] [--ref COMMIT] [--dry-run]
  node scripts/t3code-forgejo.mjs publish --artifact DIR [--dry-run]
  node scripts/t3code-forgejo.mjs check [--version VERSION_OR_TAG]
  node scripts/t3code-forgejo.mjs download --output DIR [--version VERSION_OR_TAG]
  node scripts/t3code-forgejo.mjs install --yes [--version VERSION_OR_TAG]

Options: --registry URL, --token-file PATH (or PACKAGE_FOGEJO_TOKEN_FILE).
Defaults to your git-god Forgejo registry and the custom tag. Publishing builds
committed source in isolation. Install restarts the Linux user service; download
does not. Tokens may also be supplied through an existing user npmrc.
`);
  process.exit(0);
}
const command = positionals[0];
function fail(message) {
  throw new Error(message);
}
function run(program, args, options = {}) {
  const result = NodeChildProcess.spawnSync(program, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${program} failed (${result.status})`);
  return result.stdout?.toString().trim();
}
const registry = new URL(values.registry);
if (
  registry.protocol !== "https:" ||
  registry.username ||
  registry.password ||
  registry.search ||
  registry.hash ||
  !/\/api\/packages\/[^/]+\/npm\/$/.test(registry.pathname)
) {
  fail("Expected an HTTPS Forgejo registry URL ending in /api/packages/OWNER/npm/.");
}
if (positionals.length !== 1 || !["publish", "check", "download", "install"].includes(command))
  fail("Choose publish, check, download, or install; see --help.");
if (command === "install" && !values.yes)
  fail("Install restarts t3code.service. Pass --yes when ready.");
if (values["dry-run"] && command !== "publish") fail("--dry-run applies only to publish.");
if (command === "download" && !values.output) fail("download requires --output DIR.");
const customVersion = /^[0-9]+\.[0-9]+\.[0-9]+-forgejo\.[0-9]+(?:\.g[0-9a-f]{12})?$/;
if (values.version !== "custom" && !customVersion.test(values.version))
  fail("Expected custom or an exact Forgejo build version.");
const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-forgejo-"));
try {
  const env = { ...process.env };
  if (values["token-file"]) {
    const token = NodeFS.readFileSync(values["token-file"], "utf8").trim();
    if (!token || /\s/.test(token)) fail("Token file must contain one token.");
    const npmrc = NodePath.join(temporary, "npmrc");
    NodeFS.writeFileSync(npmrc, `//${registry.host}${registry.pathname}:_authToken=${token}\n`, {
      mode: 0o600,
    });
    env.NPM_CONFIG_USERCONFIG = npmrc;
  }
  const npm = (args, capture = false) =>
    run("npm", args, {
      cwd: temporary,
      env,
      ...(capture ? { stdio: ["ignore", "pipe", "inherit"] } : {}),
    });
  // Only a package-not-found response can start a new release sequence.
  function publishedVersions() {
    const result = NodeChildProcess.spawnSync(
      "npm",
      ["view", "t3", "versions", "--registry", registry.href, "--json"],
      { cwd: temporary, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.error) throw result.error;
    let response;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      fail("Could not read Forgejo package versions; refusing to allocate a release.");
    }
    if (result.status !== 0) {
      if (response?.error?.code === "E404") return [];
      fail("Forgejo package lookup failed; check registry access before publishing.");
    }
    const versions = typeof response === "string" ? [response] : response;
    if (!Array.isArray(versions) || !versions.every((version) => typeof version === "string"))
      fail("Forgejo returned invalid package versions.");
    return versions;
  }
  if (command === "publish") {
    if (values.artifact && (values.source || values.ref || values.output))
      fail("--artifact cannot be combined with build options.");
    const artifact =
      values.artifact || values.output
        ? NodePath.resolve(values.artifact || values.output)
        : NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-release-"));
    console.log(`Artifact directory: ${artifact}`);
    if (!values.artifact) {
      const source = NodePath.resolve(values.source || root);
      const sourceArgs = ["--source", source];
      if (values.ref) sourceArgs.push("--ref", values.ref);
      const resolved = run(
        NodePath.join(root, "scripts/t3code-build"),
        [...sourceArgs, "--check"],
        {
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      const commit = /^commit=([0-9a-f]{40,64})$/m.exec(resolved)?.[1];
      if (!commit) fail("Builder did not resolve a source commit.");
      const sourcePackage = JSON.parse(
        run("git", ["-C", source, "show", `${commit}:apps/server/package.json`], {
          stdio: ["ignore", "pipe", "inherit"],
        }),
      );
      const base = sourcePackage.version?.split("-")[0];
      if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(base)) fail("Invalid upstream package version.");
      let counter = 0n;
      for (const version of publishedVersions()) {
        const match = /^(.+)-forgejo\.([0-9]+)$/.exec(version);
        if (match?.[1] === base && BigInt(match[2]) > counter) counter = BigInt(match[2]);
      }
      const version = `${base}-forgejo.${counter + 1n}`;
      run(NodePath.join(root, "scripts/t3code-build"), [
        "--source",
        source,
        "--ref",
        commit,
        "--output",
        artifact,
        "--app-version",
        version,
      ]);
    }
    const metadata = JSON.parse(NodeFS.readFileSync(NodePath.join(artifact, "build.json"), "utf8"));
    const NodeCrypto = await import("node:crypto");
    const tarball = NodePath.join(artifact, "package.tgz");
    if (
      NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(tarball)).digest("hex") !==
      metadata.sha256
    )
      fail("Artifact hash does not match build.json.");
    const pkg = JSON.parse(
      run("tar", ["-xOf", tarball, "package/package.json"], {
        stdio: ["ignore", "pipe", "inherit"],
      }),
    );
    if (pkg.name !== "t3" || pkg.version !== metadata.version || !customVersion.test(pkg.version))
      fail("Expected a custom t3 source build.");
    if (publishedVersions().includes(pkg.version))
      fail(`t3@${pkg.version} already exists; refusing to overwrite a published release.`);
    console.log(`Publishing t3@${pkg.version} to ${registry.href}`);
    npm([
      "publish",
      tarball,
      "--registry",
      registry.href,
      "--tag",
      "custom",
      "--ignore-scripts",
      ...(values["dry-run"] ? ["--dry-run"] : []),
    ]);
  } else {
    const version = JSON.parse(
      npm(["view", `t3@${values.version}`, "version", "--registry", registry.href, "--json"], true),
    );
    if (typeof version !== "string" || !customVersion.test(version))
      fail("Registry did not return an exact custom build version.");
    console.log(`t3@${version} (${registry.href})`);
    if (command !== "check") {
      const output = values.output
        ? NodePath.resolve(values.output)
        : NodePath.join(temporary, "download");
      NodeFS.mkdirSync(output, { recursive: true });
      const packed = JSON.parse(
        npm(
          [
            "pack",
            `t3@${version}`,
            "--registry",
            registry.href,
            "--pack-destination",
            output,
            "--ignore-scripts",
            "--json",
          ],
          true,
        ),
      );
      const tarball = NodeFS.realpathSync(NodePath.join(output, packed[0].filename));
      console.log(tarball);
      if (command === "install")
        run(NodePath.join(root, "scripts/t3code-install"), [
          "--package",
          tarball,
          "--build-id",
          version,
        ]);
    }
  }
} finally {
  NodeFS.rmSync(temporary, { recursive: true, force: true });
}
