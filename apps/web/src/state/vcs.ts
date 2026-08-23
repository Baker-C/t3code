import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);
/**
 * Web-only: the repo roots inside a project folder back the battle
 * new-worktree picker, which has no mobile surface. Roots change only when
 * the folder gains or loses a repo, so the answer stays fresh for a while.
 */
export const vcsRepoRoots = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:vcs:list-repo-roots",
  tag: WS_METHODS.vcsListRepoRoots,
  staleTimeMs: 60_000,
  idleTtlMs: 5 * 60_000,
});
