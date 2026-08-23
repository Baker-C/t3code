/**
 * Enumerates the git repository roots inside a project folder. A project's
 * workspaceRoot may itself be a repo, or contain several independent repos
 * (e.g. frontend/ and backend/); battles spanning repos use this to offer a
 * per-repo worktree choice. Pure filesystem read: no git subprocess.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { GitCommandError, type VcsListRepoRootsResult, type VcsRepoRoot } from "@t3tools/contracts";

const MAX_SCAN_DEPTH = 3;

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".t3",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".venv",
  "vendor",
]);

/** Reads HEAD without spawning git; detached HEAD reports null. */
const readCurrentBranch = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  repoRoot: string,
): Effect.Effect<string | null> =>
  fileSystem.readFileString(path.join(repoRoot, ".git", "HEAD")).pipe(
    Effect.map((contents) => {
      const trimmed = contents.trim();
      return trimmed.startsWith("ref: refs/heads/")
        ? trimmed.slice("ref: refs/heads/".length)
        : null;
    }),
    // A .git file (worktree/submodule pointer) or unreadable HEAD is still a
    // repo boundary; it just has no readable branch from here.
    Effect.catch(() => Effect.succeed(null)),
  );

export const listRepoRoots = (input: {
  readonly cwd: string;
}): Effect.Effect<VcsListRepoRootsResult, GitCommandError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const roots: Array<VcsRepoRoot> = [];

    const scan = (directory: string, depth: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const hasGitEntry = yield* fileSystem
          .exists(path.join(directory, ".git"))
          .pipe(Effect.catch(() => Effect.succeed(false)));
        if (hasGitEntry) {
          const relative = path.relative(input.cwd, directory);
          roots.push({
            path: directory,
            relativePath: relative === "" ? "." : relative.replaceAll("\\", "/"),
            currentBranch: yield* readCurrentBranch(fileSystem, path, directory),
          });
          // Nested repos below a found root are that repo's concern.
          return;
        }
        if (depth >= MAX_SCAN_DEPTH) {
          return;
        }
        const entries = yield* fileSystem
          .readDirectory(directory)
          .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
        for (const entry of entries) {
          if (entry.startsWith(".") || SKIPPED_DIRECTORIES.has(entry)) {
            continue;
          }
          const entryPath = path.join(directory, entry);
          const info = yield* fileSystem.stat(entryPath).pipe(Effect.orElseSucceed(() => null));
          if (info !== null && info.type === "Directory") {
            yield* scan(entryPath, depth + 1);
          }
        }
      });

    const rootExists = yield* fileSystem
      .exists(input.cwd)
      .pipe(Effect.catch(() => Effect.succeed(false)));
    if (!rootExists) {
      return yield* new GitCommandError({
        operation: "listRepoRoots",
        command: "scan",
        cwd: input.cwd,
        detail: `Workspace root does not exist: ${input.cwd}`,
      });
    }

    yield* scan(input.cwd, 0);
    return { roots };
  });
