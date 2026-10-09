CREATE TABLE "StorageSnapshot" (
  "id" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" TEXT NOT NULL,
  CONSTRAINT "StorageSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "StorageEntry" (
  "id" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "vmId" TEXT NOT NULL,
  "vmName" TEXT NOT NULL,
  "powerState" TEXT,
  "dnsName" TEXT,
  "capacityBytes" BIGINT NOT NULL,
  "freeBytes" BIGINT NOT NULL,
  "usedBytes" BIGINT NOT NULL,
  "disks" JSONB NOT NULL,
  CONSTRAINT "StorageEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StorageSnapshot_capturedAt_idx" ON "StorageSnapshot"("capturedAt");
CREATE INDEX "StorageEntry_vmId_idx" ON "StorageEntry"("vmId");
CREATE INDEX "StorageEntry_snapshotId_idx" ON "StorageEntry"("snapshotId");
ALTER TABLE "StorageEntry" ADD CONSTRAINT "StorageEntry_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "StorageSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
