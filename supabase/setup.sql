-- ============================================================
-- Das Beste des Tages — einmaliges Setup-Skript
-- Bitte komplett im Supabase SQL Editor ausführen (Project > SQL Editor > New query).
-- Sicher für mehrfaches Ausführen (idempotent wo möglich).
-- ============================================================

-- 1) Foto-Anhänge: Spalte auf der entries-Tabelle
alter table entries add column if not exists photo_path text;

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
