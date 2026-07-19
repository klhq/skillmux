export interface RepoSource {
  url: string;
  skillPath?: string;
}

const GIT_URL_PREFIXES = ["http://", "https://", "git://", "ssh://"];
const SCP_LIKE_URL_PATTERN = /^[^/\s]+@[^/\s]+:/;

function isGitUrl(repo: string): boolean {
  return GIT_URL_PREFIXES.some((prefix) => repo.startsWith(prefix)) || SCP_LIKE_URL_PATTERN.test(repo);
}

export function resolveRepoSource(repo: string): RepoSource {
  if (isGitUrl(repo)) return { url: repo };

  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name) {
    throw new Error(`invalid repo "${repo}": expected owner/repo, owner/repo/path, or a git URL`);
  }
  const url = `https://github.com/${owner}/${name}.git`;
  return rest.length > 0 ? { url, skillPath: rest.join("/") } : { url };
}
