const gitShaPattern = /^[0-9a-f]{40}$/i;

export function runtimeNeedsDeployment(
  remoteSha: string,
  runtimeBuildSha: string,
): boolean {
  return (
    gitShaPattern.test(remoteSha) &&
    gitShaPattern.test(runtimeBuildSha) &&
    remoteSha !== runtimeBuildSha
  );
}
