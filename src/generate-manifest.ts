import path from "node:path";
import { parseArgs } from "node:util";
import { buildVersionsManifest, type GithubRelease, type ReleaseAsset } from "./lib";

type CliOptions = {
  output: string;
  repo: string;
};

type GithubApiRelease = {
  tag_name?: string;
  assets?: Array<{
    name?: string;
    browser_download_url?: string;
  }>;
};

async function main(): Promise<void> {
  const options = parseCliArgs();
  const releases = await fetchGithubReleases(options.repo);
  const manifest = buildVersionsManifest(options.repo, releases, new Date().toISOString());
  await Bun.write(options.output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(manifest.versions).length} installable PHP versions to ${options.output}`);
}

function parseCliArgs(): CliOptions {
  const values = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      output: { type: "string", default: path.resolve(process.cwd(), "versions.json") },
      repo: { type: "string" }
    },
    allowPositionals: false,
    strict: true
  });

  const repo = values.values.repo ?? process.env.GITHUB_REPOSITORY ?? "";
  if (!repo) {
    throw new Error("--repo is required when GITHUB_REPOSITORY is not set.");
  }

  return {
    output: values.values.output,
    repo
  };
}

async function fetchGithubReleases(repo: string): Promise<GithubRelease[]> {
  const releases: GithubRelease[] = [];

  for (let page = 1; ; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers: buildHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch releases for ${repo}: ${response.status} ${response.statusText}`);
    }

    const pageReleases = await response.json() as GithubApiRelease[];
    if (pageReleases.length === 0) {
      break;
    }

    for (const release of pageReleases) {
      if (typeof release.tag_name !== "string") {
        continue;
      }

      releases.push({
        tagName: release.tag_name,
        assets: normalizeAssets(release.assets ?? [])
      });
    }
  }

  return releases;
}

function normalizeAssets(assets: GithubApiRelease["assets"] | undefined): ReleaseAsset[] {
  return (assets ?? [])
    .filter((asset): asset is { name: string; browser_download_url: string } => {
      return typeof asset?.name === "string" && typeof asset?.browser_download_url === "string";
    })
    .map((asset) => ({
      name: asset.name,
      browserDownloadUrl: asset.browser_download_url
    }));
}

function buildHeaders(): HeadersInit {
  const headers: HeadersInit = {
    Accept: "application/vnd.github+json",
    "User-Agent": "php-binaries-manifest"
  };

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
