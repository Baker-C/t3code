import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { listRepoRoots } from "./RepoRoots.ts";

const writeHead = (root: string, branch: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.join(root, ".git"), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(root, ".git", "HEAD"),
      `ref: refs/heads/${branch}\n`,
    );
  });

it.layer(NodeServices.layer)("listRepoRoots", (it) => {
  it.effect("finds nested repos with branches and skips ignored directories", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* fileSystem.makeTempDirectoryScoped();

        yield* writeHead(path.join(workspace, "frontend"), "main");
        yield* writeHead(path.join(workspace, "services", "backend"), "develop");
        // A repo hidden inside node_modules must not be reported.
        yield* writeHead(path.join(workspace, "node_modules", "dep"), "main");
        // A plain directory without .git is not a root.
        yield* fileSystem.makeDirectory(path.join(workspace, "docs"), { recursive: true });

        const result = yield* listRepoRoots({ cwd: workspace });
        const byRelative = new Map(result.roots.map((root) => [root.relativePath, root]));

        assert.equal(result.roots.length, 2);
        assert.equal(byRelative.get("frontend")?.currentBranch, "main");
        assert.equal(byRelative.get("services/backend")?.currentBranch, "develop");
      }),
    ),
  );

  it.effect("reports the workspace root itself as '.' and does not descend into it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* fileSystem.makeTempDirectoryScoped();

        yield* writeHead(workspace, "main");
        yield* writeHead(path.join(workspace, "inner"), "feature");

        const result = yield* listRepoRoots({ cwd: workspace });
        assert.equal(result.roots.length, 1);
        assert.equal(result.roots[0]?.relativePath, ".");
        assert.equal(result.roots[0]?.currentBranch, "main");
      }),
    ),
  );

  it.effect("reports null branch for detached HEAD and a worktree-style .git file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* fileSystem.makeTempDirectoryScoped();

        const detached = path.join(workspace, "detached");
        yield* fileSystem.makeDirectory(path.join(detached, ".git"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(detached, ".git", "HEAD"),
          "0123456789abcdef0123456789abcdef01234567\n",
        );

        const linked = path.join(workspace, "linked");
        yield* fileSystem.makeDirectory(linked, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(linked, ".git"),
          "gitdir: /somewhere/else/.git/worktrees/linked\n",
        );

        const result = yield* listRepoRoots({ cwd: workspace });
        const byRelative = new Map(result.roots.map((root) => [root.relativePath, root]));
        assert.equal(result.roots.length, 2);
        assert.equal(byRelative.get("detached")?.currentBranch, null);
        assert.equal(byRelative.get("linked")?.currentBranch, null);
      }),
    ),
  );

  it.effect("fails with GitCommandError when the workspace root does not exist", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const missing = path.join("Z:", "definitely", "not", "here");
      const result = yield* listRepoRoots({ cwd: missing }).pipe(Effect.flip);
      assert.equal(result._tag, "GitCommandError");
      assert.equal(result.operation, "listRepoRoots");
    }),
  );
});
