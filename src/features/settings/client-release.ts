export type ClientRelease = { version: string; filename: string; sha256: string; size: number; publishedAt: string; downloadUrl: string };
export type ClientUpdateResult = { status: 'up-to-date' | 'installing'; release: ClientRelease };
export function isNewerClientVersion(candidate: string, current: string) {
  const candidateParts = candidate.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const currentParts = current.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(candidateParts.length, currentParts.length); index += 1) {
    if ((candidateParts[index] || 0) !== (currentParts[index] || 0)) return (candidateParts[index] || 0) > (currentParts[index] || 0);
  }
  return false;
}
