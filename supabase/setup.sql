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
-- 4) Optional: tägliches Auslösen der Edge Function per pg_cron.
-- Voraussetzung: Extensions "pg_cron" und "pg_net" sind aktiviert
-- (Dashboard > Database > Extensions).
-- Danach die Platzhalter unten ersetzen und den Block separat ausführen.
-- ============================================================

-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
--
-- select cron.schedule(
--   'daily-reminder-push',
--   '0 18 * * *', -- UTC-Zeit anpassen (18:00 UTC = 19/20 Uhr in Deutschland je nach Sommer-/Winterzeit)
--   $$
--   select net.http_post(
--     url := 'https://<DEIN-PROJECT-REF>.supabase.co/functions/v1/send-daily-reminder',
--     headers := jsonb_build_object(
--       'Authorization', 'Bearer <DEIN-SERVICE-ROLE-KEY-ODER-ANON-KEY>',
--       'Content-Type', 'application/json'
--     ),
--     body := '{}'::jsonb
--   );
--   $$
-- );
