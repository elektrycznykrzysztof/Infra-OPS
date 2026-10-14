# Infrastructure Dashboard

Panel operatorski dla Veeam Backup & Replication, Veeam ONE, VMware vCenter, Sophos Firewall, NetApp ONTAP oraz sesji SSH. Aplikacja składa się z API (Bun + Elysia), interfejsu Vue, PostgreSQL i opcjonalnego bota Discord.

## Uruchomienie

1. Skopiuj konfigurację:

   ```bash
   cp .env.example .env
   ```

2. Ustaw obowiązkowo `APP_USERNAME`, `APP_PASSWORD` i dokładne adresy w `WEB_ORIGINS`. Następnie wpisz dane tylko tych integracji, których używasz.

   Dla Sophos stan zestawionych par VPN jest pobierany z WebAdmin. Możesz użyć osobnego konta tylko do odczytu przez `SOPHOS_WEBADMIN_USERNAME` i `SOPHOS_WEBADMIN_PASSWORD`; opcjonalnie ustaw inny adres w `SOPHOS_WEBADMIN_BASE_URL`. Gdy te pola są puste, aplikacja używa `SOPHOS_BASE_URL`, `SOPHOS_USERNAME` i `SOPHOS_PASSWORD`. Konto WebAdmin musi mieć dostęp do widoku `Current activities > IPsec connections`. Po zmianie `.env` odtwórz kontener: `docker compose up -d --build api`.

3. Uruchom panel:

   ```bash
   docker compose up -d --build
   ```

4. Otwórz `http://ADRES_IP_SERWERA:3011` i zaloguj się danymi Basic Auth z `.env`. Port `3011` jest domyślnie publikowany na wszystkich interfejsach hosta.

Bot Discord jest opcjonalny i działa w osobnym profilu:

```bash
docker compose --profile discord up -d --build
```

Dostęp do komend bota ogranicza lista identyfikatorów użytkowników Discord w `.env`:

```env
DISCORD_ALLOWED_USER_IDS=ID_UZYTKOWNIKA_1,ID_UZYTKOWNIKA_2
```

Po zmianie listy odtwórz kontener bota: `docker compose --profile discord up -d --force-recreate bot`. Starsza zmienna `DISCORD_ALLOWED_USER_ID` nadal działa jako pojedynczy identyfikator, jeśli `DISCORD_ALLOWED_USER_IDS` jest pusta.

## Bezpieczeństwo i reverse proxy

- Port API jest publikowany na wszystkich interfejsach hosta (`0.0.0.0:3011`). Dostęp ogranicz firewallem do zaufanych sieci lub adresów źródłowych.
- TLS powinien kończyć się na reverse proxy. Żądania z tego samego originu co panel są dozwolone automatycznie; `WEB_ORIGINS` służy wyłącznie do dodawania zaufanych originów cross-origin.
- Sekrety integracji są czytane przez backend z `.env`; frontend ich nie otrzymuje.
- Operacje POST wymagają poprawnego `Origin`.
- Terminal przyjmuje wyłącznie literalne adresy IP i zawsze używa portu 22. Fingerprint SHA-256 jest zapamiętywany w wolumenie `ssh_fingerprints` (TOFU).
- `*_ALLOW_SELF_SIGNED=true` wyłącza weryfikację certyfikatu wyłącznie dla danej integracji. Używaj tej opcji tylko w zaufanej sieci.

## Endpointy

API jest dostępne pod ścieżką `/api` i chronione tym samym Basic Auth co panel. Endpoint `/health` pozostaje publiczny na potrzeby healthchecku Dockera.

Historia Storage Usage może zostać wyłączona przez pozostawienie `DATABASE_URL` pustego. W domyślnym Docker Compose baza PostgreSQL jest aktywna, a snapshot wykonywany jest przy pierwszym uruchomieniu w danym dniu, co godzinę (o pełnej godzinie) oraz ręcznie z panelu. Harmonogram można zmienić przez `STORAGE_COLLECTION_CRON`.

Alert o kolejnych błędach zapisu snapshotów do PostgreSQL konfiguruje się przez `SNAPSHOT_DB_FAILURE_THRESHOLD` (domyślnie `3`), `SNAPSHOT_ALERT_EMAIL_TO`, opcjonalnie `SNAPSHOT_ALERT_EMAIL_FROM` oraz ustawienia serwera SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`). Jeśli `SNAPSHOT_ALERT_EMAIL_FROM` jest puste, używana jest wartość `SMTP_USER`. Nieudane pobranie danych z Veeam ONE nie zwiększa licznika awarii. Licznik zeruje się po udanej operacji PostgreSQL. W zakładce `Administration` można ręcznie wysłać testową wiadomość na skonfigurowany adres odbiorcy.

Alert e-mail i wiadomość testowa zawierają załączniki `postgres-container-last-100-lines.log` i `postgresql.log` oraz szczegóły bieżących błędów zapisu snapshotów. Jeśli podczas testu nie ma aktywnego błędu PostgreSQL, wiadomość wyraźnie to zaznaczy zamiast generować fikcyjny błąd. Kontener PostgreSQL kopiuje swój strumień wyjściowy do współdzielonego wolumenu diagnostycznego, dzięki czemu API może dołączyć logi bez dostępu do Docker socketa. Po zmianie konfiguracji kontenera PostgreSQL wdrożenie wymaga jego przebudowania, np. `docker compose up -d --build postgres api`.
