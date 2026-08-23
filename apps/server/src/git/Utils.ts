// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function isGitRepository(cwd: string): boolean {
  return NodeFS.existsSync(NodePath.join(cwd, ".git"));
}

/**
 * The repository that owns a linked worktree, or null when `cwd` is not one.
 *
 * A linked worktree's `.git` is a file reading `gitdir: <repo>/.git/worktrees/<name>`,
 * while a main working tree's `.git` is a directory. `git worktree remove`
 * must run from the owning repository - it fails when its cwd is inside the
 * worktree being removed - so callers need this to pick a cwd. The null return
 * for a main working tree is also the guard that keeps retirement from ever
 * pointing `git worktree remove` at a project root.
 */
export function resolveLinkedWorktreeRepositoryRoot(cwd: string): string | null {
  const gitPath = NodePath.join(cwd, ".git");
  let gitPathStat: NodeFS.Stats;
  try {
    gitPathStat = NodeFS.statSync(gitPath);
  } catch {
    return null;
  }
  if (!gitPathStat.isFile()) {
    return null;
  }

  const gitDir = /^gitdir:\s*(.+)$/m.exec(NodeFS.readFileSync(gitPath, "utf8"))?.[1]?.trim();
  if (!gitDir) {
    return null;
  }

  const repositoryGitDir = NodePath.dirname(NodePath.dirname(gitDir));
  if (NodePath.basename(repositoryGitDir) !== ".git") {
    return null;
  }
  return NodePath.dirname(repositoryGitDir);
}
