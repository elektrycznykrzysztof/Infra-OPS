import { open } from "node:fs/promises";
import { join } from "node:path";

const diagnosticDirectory = process.env.POSTGRES_DIAGNOSTICS_DIR?.trim() || "/var/log/postgresql";
const maximumAttachmentBytes = 5 * 1024 * 1024;

async function readLogTail(filename: string) {
  const file = await open(join(diagnosticDirectory, filename), "r");
  try {
    const size = (await file.stat()).size;
    const bytesToRead = Math.min(size, maximumAttachmentBytes);
    const buffer = Buffer.alloc(bytesToRead);
    await file.read(buffer, 0, bytesToRead, Math.max(0, size - bytesToRead));
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
}

async function readOrExplain(filename: string) {
  try {
    return await readLogTail(filename);
  } catch (error) {
    return `Nie udało się odczytać ${filename}: ${(error as Error).message}`;
  }
}

export async function postgresDiagnosticAttachments() {
  const [containerLog, postgresLog] = await Promise.all([
    readOrExplain("postgres-container.log"),
    readOrExplain("postgresql.log")
  ]);
  const last100Lines = containerLog.split(/\r?\n/).filter(Boolean).slice(-100).join("\n");

  return [
    {
      filename: "postgres-container-last-100-lines.log",
      contentType: "text/plain; charset=utf-8",
      content: last100Lines || "Log kontenera PostgreSQL jest pusty."
    },
    {
      filename: "postgresql.log",
      contentType: "text/plain; charset=utf-8",
      content: postgresLog || "Log PostgreSQL jest pusty."
    }
  ];
}
