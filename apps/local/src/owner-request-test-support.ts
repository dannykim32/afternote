// Synthetic owner clients use the same per-connection sequence contract as AppKit.
// Reuse the serialized envelope itself when testing replay rejection.
const sequences = new Map<string, number>();
export function nextOwnerSequence(connection: { connectionId: string; peerPid: number }): number {
  const key = `${connection.connectionId}:${connection.peerPid}`;
  const sequence = (sequences.get(key) ?? 0) + 1;
  sequences.set(key, sequence);
  return sequence;
}
