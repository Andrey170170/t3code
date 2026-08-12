export interface PublishCommandConfig {
  readonly access: string;
  readonly tag: string;
  readonly provenance: boolean;
  readonly dryRun: boolean;
}

export const createVpPmPublishArgs = (config: PublishCommandConfig): ReadonlyArray<string> => {
  const args = [
    "publish",
    "--filter",
    "t3",
    "--access",
    config.access,
    "--tag",
    config.tag,
    "--no-git-checks",
  ];

  if (config.provenance) args.push("--provenance");
  if (config.dryRun) args.push("--dry-run");

  return args;
};

export const createPnpmPackArgs = (out: string): ReadonlyArray<string> => [
  "pack",
  "--filter",
  "t3",
  "--out",
  out,
  "--json",
];
