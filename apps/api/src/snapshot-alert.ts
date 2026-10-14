import nodemailer from "nodemailer";
import { postgresDiagnosticAttachments } from "./postgres-diagnostics";

type SnapshotFailure = { at: string; stage: string; detail: string };

let consecutiveFailures = 0;
let alertSentForIncident = false;
let alertInProgress = false;
let lastAlertAttemptAt = 0;
let testEmailInProgress = false;
let lastTestEmailAt = 0;
let recentFailures: SnapshotFailure[] = [];

const redact = (value: string) => value
  .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, "$1[credentials redacted]@")
  .replace(/(password|passwd|token)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
  .slice(0, 4000);

function describeError(error: unknown) {
  const candidate = error as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } };
  const code = candidate?.code || candidate?.cause?.code;
  const name = candidate?.name || "Error";
  const message = redact(candidate?.message || String(error));
  return `${code ? `${code}: ` : ""}${name}: ${message}`;
}

function thresholdFromEnv() {
  const parsed = Number.parseInt(process.env.SNAPSHOT_DB_FAILURE_THRESHOLD || "3", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

export async function recordSnapshotDatabaseFailure(stage: string, error: unknown) {
  consecutiveFailures += 1;
  const failure = { at: new Date().toISOString(), stage, detail: describeError(error) };
  recentFailures = [...recentFailures.slice(-9), failure];
  console.error(`Snapshot database failure ${consecutiveFailures}/${thresholdFromEnv()} (${stage}): ${failure.detail}`);

  if (consecutiveFailures < thresholdFromEnv() || alertSentForIncident || alertInProgress || Date.now() - lastAlertAttemptAt < 5 * 60_000) return;
  alertInProgress = true;
  lastAlertAttemptAt = Date.now();
  try {
    await sendSnapshotFailureAlert();
    alertSentForIncident = true;
  } catch (mailError) {
    console.error("Could not send snapshot database alert:", describeError(mailError));
  } finally {
    alertInProgress = false;
  }
}

export async function resetSnapshotDatabaseFailures() {
  if (consecutiveFailures) console.info("Snapshot database connection recovered; failure counter reset.");
  consecutiveFailures = 0;
  alertSentForIncident = false;
  lastAlertAttemptAt = 0;
  recentFailures = [];
}

function mailSettings() {
  const host = process.env.SMTP_HOST?.trim();
  const to = process.env.SNAPSHOT_ALERT_EMAIL_TO?.trim();
  const from = process.env.SNAPSHOT_ALERT_EMAIL_FROM?.trim() || process.env.SMTP_USER?.trim();
  if (!host || !to || !from) {
    throw new Error("Brak konfiguracji SMTP_HOST, SNAPSHOT_ALERT_EMAIL_TO lub SNAPSHOT_ALERT_EMAIL_FROM.");
  }

  const port = Number.parseInt(process.env.SMTP_PORT || "587", 10);
  const secure = /^(1|true|yes)$/i.test(process.env.SMTP_SECURE || "") || port === 465;
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;
  if (Boolean(user) !== Boolean(password)) {
    throw new Error("Uzupełnij jednocześnie SMTP_USER i SMTP_PASSWORD albo pozostaw oba puste.");
  }

  return {
    host,
    port: Number.isFinite(port) ? port : 587,
    secure,
    to,
    from,
    user,
    password
  };
}

function createMailTransport(settings: ReturnType<typeof mailSettings>) {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    ...(settings.user && settings.password ? { auth: { user: settings.user, pass: settings.password } } : {})
  });
}

function snapshotFailureDetails() {
  const mostRecent = recentFailures.at(-1);
  const details = recentFailures.map((failure, index) =>
    `${index + 1}. ${failure.at} — etap: ${failure.stage}; ${failure.detail}`
  ).join("\n");

  return [
    `Rodzaj błędu: ${mostRecent?.detail || "brak bieżącego błędu PostgreSQL (test konfiguracji e-mail)"}`,
    `Etap: ${mostRecent?.stage || "test konfiguracji e-mail"}`,
    `Kolejne nieudane operacje bazy: ${consecutiveFailures} (próg alertu: ${thresholdFromEnv()}).`,
    "",
    "Ostatnie błędy:",
    details || "Brak bieżących błędów do zgłoszenia."
  ];
}

export async function sendConfiguredTestEmail() {
  if (testEmailInProgress) throw new Error("Testowy e-mail jest już wysyłany.");
  if (Date.now() - lastTestEmailAt < 30_000) throw new Error("Odczekaj 30 sekund przed kolejnym testem e-maila.");
  const settings = mailSettings();
  const transport = createMailTransport(settings);
  testEmailInProgress = true;
  try {
    await transport.sendMail({
      from: settings.from,
      to: settings.to,
      subject: "[Infrastructure Dashboard] Test konfiguracji e-mail",
      text: [
        "To jest testowa wiadomość z panelu Infrastructure Dashboard.",
        "Jeśli ją otrzymujesz, konfiguracja SMTP i adres odbiorcy działają poprawnie.",
        "Wiadomość zawiera te same szczegóły diagnostyczne i załączniki co alert o błędzie zapisu snapshotów.",
        "To nie jest zgłoszenie awarii; jeśli nie ma bieżącego błędu PostgreSQL, zostanie to wskazane poniżej.",
        `Wysłano: ${new Date().toISOString()}`,
        "",
        ...snapshotFailureDetails(),
        "",
        "Załączniki zawierają ostatnie 100 linii logu kontenera PostgreSQL oraz plik postgresql.log."
      ].join("\n"),
      attachments: await postgresDiagnosticAttachments()
    });
    lastTestEmailAt = Date.now();
    return { ok: true, recipient: settings.to };
  } finally {
    transport.close();
    testEmailInProgress = false;
  }
}

async function sendSnapshotFailureAlert() {
  const settings = mailSettings();
  const transport = createMailTransport(settings);

  const subject = `[Infrastructure Dashboard] Brak zapisu snapshotów do PostgreSQL (${consecutiveFailures} prób)`;
  const text = [
    "Aplikacja nie może zapisać snapshotu storage do PostgreSQL.",
    ...snapshotFailureDetails(),
    "",
    "Załączniki zawierają ostatnie 100 linii logu kontenera PostgreSQL oraz plik postgresql.log."
  ].join("\n");

  try {
    await transport.sendMail({ from: settings.from, to: settings.to, subject, text, attachments: await postgresDiagnosticAttachments() });
  } finally {
    transport.close();
  }
}
