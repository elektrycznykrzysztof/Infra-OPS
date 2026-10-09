type StorageDisk = {
  name?: string;
  capacityBytes?: number | null;
  freeBytes?: number | null;
  usedBytes?: number | null;
  usageKnown?: boolean;
  mountPoints?: string[];
  [key: string]: unknown;
};

const mountPath = (disk: StorageDisk) => String(disk.name || disk.path || disk.mountPoint || "");
const isPosixMountPath = (disk: StorageDisk) => mountPath(disk).startsWith("/");

/**
 * Veeam ONE exposes Linux guest filesystems as mount paths but omits the source
 * device/filesystem ID. Bind mounts therefore repeat the same size and free
 * space under many directory paths. Collapse those repeated measurements while
 * retaining the paths as aliases for display.
 */
export function deduplicateLinuxMountPoints(disks: StorageDisk[]) {
  if (!disks.some(isPosixMountPath)) return disks;

  const unique: StorageDisk[] = [];
  for (const disk of disks) {
    const capacityBytes = Number(disk.capacityBytes || 0);
    const freeBytes = Number(disk.freeBytes);
    const canMatch = disk.usageKnown === true && capacityBytes > 0 && Number.isFinite(freeBytes);
    const toleranceBytes = Math.max(2 * 1024 * 1024, capacityBytes * 0.00001);
    const existing = canMatch && isPosixMountPath(disk)
      ? unique.find((candidate) => {
        if (candidate.usageKnown !== true || Number(candidate.capacityBytes) !== capacityBytes) return false;
        const candidateFreeBytes = Number(candidate.freeBytes);
        return Number.isFinite(candidateFreeBytes) && Math.abs(candidateFreeBytes - freeBytes) <= toleranceBytes;
      })
      : undefined;

    const paths = Array.isArray(disk.mountPoints) && disk.mountPoints.length
      ? disk.mountPoints
      : [mountPath(disk)].filter(Boolean);
    if (!existing) {
      unique.push(isPosixMountPath(disk) ? { ...disk, mountPoints: [...new Set(paths)] } : { ...disk });
      continue;
    }

    existing.mountPoints = [...new Set([...(existing.mountPoints || [mountPath(existing)]), ...paths])];
  }
  return unique;
}

export function normalizeStorageEntry(entry: any) {
  const disks = deduplicateLinuxMountPoints(Array.isArray(entry.disks) ? entry.disks : []);
  const knownDisks = disks.filter((disk) => disk.usageKnown === true && Number.isFinite(Number(disk.usedBytes)));
  const capacityBytes = knownDisks.length
    ? knownDisks.reduce((sum, disk) => sum + Number(disk.capacityBytes || 0), 0)
    : Number(entry.capacityBytes || 0);
  const freeBytes = knownDisks.length
    ? knownDisks.reduce((sum, disk) => sum + Number(disk.freeBytes || 0), 0)
    : Number(entry.freeBytes || 0);
  const usedBytes = knownDisks.length
    ? knownDisks.reduce((sum, disk) => sum + Number(disk.usedBytes || 0), 0)
    : Number(entry.usedBytes || 0);

  return {
    ...entry,
    capacityBytes,
    freeBytes,
    usedBytes,
    usageKnown: knownDisks.length > 0 || entry.usageKnown === true,
    disks
  };
}
