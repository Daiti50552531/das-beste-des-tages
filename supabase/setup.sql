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
-- (partnerships) legt der Projektbesitzer an, je eine Zeile pro Person:
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
