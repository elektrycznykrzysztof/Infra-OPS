import { PrismaClient } from "../generated/client";
import { Cron } from "croner";
import { getStorageUsage } from "./integrations";
import { configured } from "./config";
import { normalizeStorageEntry } from "./storage-disks";
import { recordSnapshotDatabaseFailure, resetSnapshotDatabaseFailures } from "./snapshot-alert";

const databaseEnabled = Boolean(process.env.DATABASE_URL?.trim());
const prisma = databaseEnabled ? new PrismaClient() : null;

const serialize = (entry: any) => normalizeStorageEntry({
  ...entry,
  capacityBytes: Number(entry.capacityBytes),
  freeBytes: Number(entry.freeBytes),
  usedBytes: Number(entry.usedBytes)
});

export async function captureStorage(reason: "startup" | "manual" | "scheduled") {
  if (!prisma) return { enabled: false, captured: 0 };
  if (!configured("veeamOne")) return { enabled: true, configured: false, captured: 0 };
  const entries = await getStorageUsage();
  let snapshot;
  try {
    snapshot = await prisma.storageSnapshot.create({
      data: {
        reason,
        entries: { create: entries.map((item: any) => ({
          vmId: item.id, vmName: item.name || item.id, powerState: item.powerState || null, dnsName: item.dnsName || null,
          capacityBytes: BigInt(Math.round(item.capacityBytes || 0)), freeBytes: BigInt(Math.round(item.freeBytes || 0)),
          usedBytes: BigInt(Math.round(item.usedBytes || 0)), disks: item.disks || []
        })) }
      }
    });
  } catch (error) {
    await recordSnapshotDatabaseFailure("snapshot zapis", error);
    throw error;
  }
  await resetSnapshotDatabaseFailures();
  return { enabled: true, snapshotId: snapshot.id, captured: entries.length, reason };
}

export async function latestStorage() {
  if (!prisma) return { enabled: false, entries: [], capturedAt: null };
  const snapshot = await prisma.storageSnapshot.findFirst({ orderBy: { capturedAt: "desc" }, include: { entries: true } });
  return snapshot ? { enabled: true, capturedAt: snapshot.capturedAt, reason: snapshot.reason, entries: snapshot.entries.map(serialize) } : { enabled: true, capturedAt: null, entries: [] };
}

export async function storageGrowth() {
  if (!prisma) return { enabled: false, points: [] };
  const snapshots = (await prisma.storageSnapshot.findMany({ orderBy: { capturedAt: "desc" }, take: 365, include: { entries: true } })).reverse();
  return { enabled: true, points: snapshots.map((snapshot) => {
    const entries = snapshot.entries.map(serialize);
    return {
      at: snapshot.capturedAt, reason: snapshot.reason,
      capacityBytes: entries.reduce((sum, item) => sum + item.capacityBytes, 0),
      usedBytes: entries.reduce((sum, item) => sum + item.usedBytes, 0),
      vms: entries.map((entry) => ({
        vmId: entry.vmId,
        vmName: entry.vmName,
        capacityBytes: entry.capacityBytes,
        usedBytes: entry.usedBytes,
        usageKnown: Array.isArray(entry.disks) && entry.disks.some((disk: any) => disk?.usageKnown === true)
      }))
    };
  }) };
}

export async function vmStorageHistory(vmId: string) {
  if (!prisma) return { enabled: false, points: [] };
  const entries = await prisma.storageEntry.findMany({ where: { vmId }, orderBy: { snapshot: { capturedAt: "asc" } }, include: { snapshot: true }, take: 365 });
  return { enabled: true, vmId, points: entries.map((entry) => ({ at: entry.snapshot.capturedAt, reason: entry.snapshot.reason, ...serialize(entry) })) };
}

export async function startStorageSchedule() {
  if (!prisma) return;
  new Cron(process.env.STORAGE_COLLECTION_CRON || "0 * * * *", async () => {
    try { await captureStorage("scheduled"); } catch (error) { console.error("Scheduled snapshot:", (error as Error).message); }
  });

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  let count: number;
  try {
    count = await prisma.storageSnapshot.count({ where: { capturedAt: { gte: startOfDay } } });
  } catch (error) {
    await recordSnapshotDatabaseFailure("sprawdzenie dzisiejszych snapshotów", error);
    console.error("Storage snapshot check:", (error as Error).message);
    return;
  }
  await resetSnapshotDatabaseFailures();
  if (!count) {
    try { await captureStorage("startup"); } catch (error) { console.error("Startup snapshot:", (error as Error).message); }
  }
}
