const GIT_URL_PREFIXES = ["http://", "https://", "git://", "ssh://", "file://"];
const SCP_LIKE_URL_PATTERN = /^[^/\s]+@[^/\s]+:/;

export function isGitUrl(repo: string): boolean {
  if (GIT_URL_PREFIXES.some((prefix) => repo.startsWith(prefix))) return true;
  // scp-like syntax (user@host:path) has no URL scheme, so whatever accepts it here
  // hands the raw string to `git clone`/`git ls-remote` as a bare positional argument.
  // If that string starts with `-`, git's own option parser reads it as a flag, not a
  // repository — verified against git 2.55: `--upload-pack=<cmd>@host:path` makes git
  // run `<cmd>` as a real local shell command instead of contacting a remote. Reject
  // it outright rather than let a crafted string reach that argv slot.
  return SCP_LIKE_URL_PATTERN.test(repo) && !repo.startsWith("-");
}
