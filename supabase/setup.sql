-- ============================================================
-- Das Beste des Tages — einmaliges Setup-Skript
-- Bitte komplett im Supabase SQL Editor ausführen (Project > SQL Editor > New query).
-- Sicher für mehrfaches Ausführen (idempotent wo möglich).
-- ============================================================

-- 0) Zugriffsschutz für die Einträge (Row Level Security)
-- Die App lädt Einträge ohne eigenen Filter auf den Nutzer. Dass nur der
-- eigene Account seine Einträge sieht, stellt allein RLS sicher.
-- Entspricht dem Stand im Projekt (geprüft am 16.10.2026).
-- (select auth.uid()) statt auth.uid(): wird einmal pro Abfrage statt für
-- jede Zeile ausgewertet (Supabase-Empfehlung, Linter 0003).
--
-- Prüfen:
--   select relname, relrowsecurity from pg_class where relname = 'entries';
--   select policyname, cmd, qual, with_check from pg_policies where tablename = 'entries';
begin;
alter table entries enable row level security;

drop policy if exists "Users can select own entries" on entries;
create policy "Users can select own entries" on entries for select
  using ((select auth.uid()) = user_id);
drop policy if exists "Users can insert own entries" on entries;
create policy "Users can insert own entries" on entries for insert
  with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update own entries" on entries;
create policy "Users can update own entries" on entries for update
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Users can delete own entries" on entries;
create policy "Users can delete own entries" on entries for delete
  using ((select auth.uid()) = user_id);
commit;

-- 0b) Hinweise des Supabase-Sicherheitschecks (angewendet am 16.10.2026)
-- Trigger-Funktionen mit festem search_path; handle_new_user nicht über die
-- API aufrufbar. Der Trigger auf auth.users feuert trotzdem, das Aufrufrecht
-- wird nur beim Anlegen des Triggers geprüft.
alter function public.handle_new_user() set search_path = '';
alter function public.set_updated_at() set search_path = '';
revoke execute on function public.handle_new_user() from public, anon, authenticated;
create index if not exists idx_error_logs_user_id on public.error_logs (user_id);
create index if not exists idx_push_subscriptions_user_id on public.push_subscriptions (user_id);

-- 0c) "Wir zwei" (angewendet am 17.10.2026)
-- Geteilte Einträge zwischen zwei fest verbundenen Personen. Eigene Tabellen,
-- die private Tabelle entries ist davon nicht betroffen. Die Verknüpfung
-- (partnerships) entsteht automatisch per Trigger (siehe unten) oder von Hand:
--   insert into public.partnerships (user_id, partner_id, partner_name, shared_only)
--   values ('<deine id>', '<ihre id>', 'Hanna', false),
--          ('<ihre id>', '<deine id>', 'David', true);

-- Verknüpfung: pro Person eine Zeile, die auf die andere zeigt.
-- partner_name = wie die Partnerin/der Partner in der App heißt,
-- shared_only = nur den Reiter "Wir zwei" anzeigen.
-- Nutzer können ihre Zeile nur lesen; angelegt wird sie vom Projektbesitzer.
create table if not exists public.partnerships (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  partner_id   uuid not null references auth.users(id) on delete cascade,
  partner_name text not null,
  shared_only  boolean not null default false,
  created_at   timestamptz not null default now(),
  constraint partnerships_not_self check (user_id <> partner_id)
);
create index if not exists idx_partnerships_partner_id on public.partnerships (partner_id);
alter table public.partnerships enable row level security;
create policy "Users read own partnership" on public.partnerships
  for select to authenticated using ((select auth.uid()) = user_id);

-- Geteilte Einträge: pro Person und Tag genau einer.
create table if not exists public.shared_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_date  date not null,
  text        text not null constraint shared_entries_text_length check (char_length(text) between 1 and 5000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint shared_entries_user_date_unique unique (user_id, entry_date)
);
alter table public.shared_entries enable row level security;

-- Lesen: eigene Einträge und die der verbundenen Person.
create policy "Read own and partner shared entries" on public.shared_entries
  for select to authenticated using (
    user_id = (select auth.uid())
    or user_id in (select p.partner_id from public.partnerships p where p.user_id = (select auth.uid()))
  );
-- Schreiben, ändern, löschen: nur eigene.
create policy "Insert own shared entries" on public.shared_entries
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Update own shared entries" on public.shared_entries
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Delete own shared entries" on public.shared_entries
  for delete to authenticated using (user_id = (select auth.uid()));

create trigger tr_shared_entries_updated_at before update on public.shared_entries
  for each row execute function public.set_updated_at();

-- Automatische Verknüpfung (angewendet am 17.10.2026): Sobald die Partnerin
-- ihre E-Mail bestätigt hat, werden beide Zeilen in partnerships angelegt.
-- Erst nach Bestätigung, damit niemand die Verknüpfung mit einer fremden,
-- unbestätigten Adresse auslösen kann. Platzhalter vor dem Ausführen ersetzen.
create or replace function public.link_wir_zwei_partner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id constant uuid := '<deine user id>';
begin
  if lower(new.email) = '<ihre e-mail in kleinbuchstaben>'
     and new.email_confirmed_at is not null
     and new.id <> owner_id then
    insert into public.partnerships (user_id, partner_id, partner_name, shared_only)
    values (owner_id, new.id, 'Hanna', false),
           (new.id, owner_id, 'David', true)
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.link_wir_zwei_partner() from public, anon, authenticated;
create trigger on_auth_user_link_wir_zwei
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.link_wir_zwei_partner();

-- 0d) App-Einstellungen pro Person (angewendet am 17.10.2026): Feldnamen, Farbe, Name.
-- Liegen zusätzlich zum Gerät in profiles.settings, damit sie eine Neuinstallation
-- der App überleben. Die Code-Sperre bleibt nur auf dem Gerät.
alter table public.profiles add column if not exists settings jsonb not null default '{}'::jsonb;

-- 0e) "Erinnern"-Knopf bei "Wir zwei" (angewendet am 19.10.2026)
-- Edge Function nudge-partner (supabase/nudge-partner.ts) schreibt hier mit der
-- service role; höchstens eine Erinnerung pro Tag und Richtung.
create table if not exists public.nudges (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references auth.users(id) on delete cascade,
  to_user uuid not null references auth.users(id) on delete cascade,
  nudge_date date not null,
  created_at timestamptz not null default now(),
  constraint nudges_once_per_day unique (from_user, to_user, nudge_date)
);
create index if not exists idx_nudges_to_user on public.nudges (to_user);
alter table public.nudges enable row level security;
create policy "Read own nudges" on public.nudges
  for select to authenticated
  using ((select auth.uid()) = from_user or (select auth.uid()) = to_user);

-- Für den Knopf: Kann die Partnerin/der Partner Benachrichtigungen empfangen, und wurde heute schon erinnert?
create or replace function public.wir_nudge_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with p as (select partner_id from public.partnerships where user_id = (select auth.uid()))
  select jsonb_build_object(
    'reachable', exists (select 1 from public.push_subscriptions s join p on s.user_id = p.partner_id),
    'nudged_at', (select n.created_at from public.nudges n join p on n.to_user = p.partner_id
                  where n.from_user = (select auth.uid())
                    and n.nudge_date = (now() at time zone 'Europe/Berlin')::date)
  );
$$;
revoke all on function public.wir_nudge_status() from public, anon;
grant execute on function public.wir_nudge_status() to authenticated;

-- 1) Foto-Anhänge: Spalte auf der entries-Tabelle
alter table entries add column if not exists photo_path text;

-- 1b) Duplikat-Schutz: pro Nutzer und Tag genau ein Eintrag.
-- Hinweis: Schlägt fehl, falls es bereits doppelte Datums-Einträge gibt —
-- dann zuerst Duplikate löschen und den Befehl erneut ausführen.
create unique index if not exists entries_user_date_unique
  on entries (user_id, entry_date);

-- 1a) Privater Storage-Bucket für Fotos (pro Nutzer isoliert)
insert into storage.buckets (id, name, public)
values ('entry-photos', 'entry-photos', false)
on conflict (id) do nothing;

drop policy if exists "Users can upload own photos" on storage.objects;
create policy "Users can upload own photos"
on storage.objects for insert to authenticated
with check (bucket_id = 'entry-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can view own photos" on storage.objects;
create policy "Users can view own photos"
on storage.objects for select to authenticated
using (bucket_id = 'entry-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can delete own photos" on storage.objects;
create policy "Users can delete own photos"
on storage.objects for delete to authenticated
using (bucket_id = 'entry-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- 2) Automatisches Fehler-Tracking
create table if not exists error_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  message text,
  stack text,
  url text,
  created_at timestamptz default now()
);
alter table error_logs enable row level security;

drop policy if exists "Users can insert own error logs" on error_logs;
create policy "Users can insert own error logs" on error_logs
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "Users can view own error logs" on error_logs;
create policy "Users can view own error logs" on error_logs
  for select to authenticated using (auth.uid() = user_id);

-- 3) Tägliche Erinnerung (Push-Benachrichtigungen)
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz default now()
);
alter table push_subscriptions enable row level security;

drop policy if exists "Users manage own subscriptions" on push_subscriptions;
create policy "Users manage own subscriptions" on push_subscriptions
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- 4) Tägliche Erinnerung per pg_cron (angewendet am 17.10.2026)
-- Voraussetzung: Extensions "pg_cron", "pg_net" und "supabase_vault".
-- Der Zeitplan ruft die Edge Function um 18 und 19 Uhr UTC auf; sie sendet
-- nur, wenn es in Berlin 20 Uhr ist (Sommer- und Winterzeit).
-- Statt eines API-Schlüssels prüft die Funktion ein Geheimnis aus dem Vault.
-- ============================================================

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'reminder_cron_secret', 'Aufruf von send-daily-reminder durch pg_cron');

create or replace function public.verify_reminder_secret(candidate text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'reminder_cron_secret' and decrypted_secret = candidate
  );
$$;
revoke all on function public.verify_reminder_secret(text) from public, anon, authenticated;
grant execute on function public.verify_reminder_secret(text) to service_role;

select cron.schedule('daily-reminder-push', '0 18,19 * * *', $cron$
  select net.http_post(
    url := 'https://<DEIN-PROJECT-REF>.supabase.co/functions/v1/send-daily-reminder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-reminder-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reminder_cron_secret')
    ),
    body := '{}'::jsonb
  );
$cron$);
