// Supabase Edge Function: send-daily-reminder (live seit 17.10.2026, verify_jwt = false)
//
// Erinnert um 20 Uhr (Europe/Berlin) per Web-Push an "Wir zwei", aber nur, wer an dem Tag
// noch keinen geteilten Eintrag hat. Hat die Partnerin/der Partner schon geschrieben,
// nennt der Text ihren/seinen Namen.
//
// Aufruf nur durch pg_cron mit dem Geheimnis aus dem Vault (Header x-reminder-secret),
// geprüft über public.verify_reminder_secret (siehe setup.sql, Abschnitt 4).
// Parameter zum Testen: ?dry (nichts senden, nur Vorschau), ?force (Uhrzeit ignorieren).
//
// Benötigte Secrets (Dashboard > Edge Functions > Manage secrets):
//   VAPID_PRIVATE_KEY           (privater Schlüssel, NIE ins Repo committen!)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY werden automatisch bereitgestellt.
// Den mailto-Kontakt unten vor dem Deployen durch eine eigene Adresse ersetzen.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Öffentlicher Schlüssel, identisch mit dem in index.html
const APP_VAPID_PUBLIC_KEY = "BAQvAK4Ysgh3pVjZjqZuYwOOteBBmCNkyOiwtFQC8S6baQoGl7VxuZzyDbz4XRs7u4uz-b3yYQfQwtlzdfG6Kuk";

// Schlüssel aus den Secrets ohne Anführungszeichen, Leerzeichen und "="-Auffüllung
const clean = (v: string | undefined) =>
  (v ?? "").trim().replace(/^["']|["']$/g, "").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function berlinNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}

Deno.serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const secret = req.headers.get("x-reminder-secret") ?? "";
  const { data: ok, error: authErr } = await supabase.rpc("verify_reminder_secret", { candidate: secret });
  if (authErr) return json({ error: "auth check failed", detail: authErr.message }, 500);
  if (ok !== true) return json({ error: "forbidden" }, 403);

  const envPublic = clean(Deno.env.get("VAPID_PUBLIC_KEY"));
  const vapidMatchesApp = envPublic === APP_VAPID_PUBLIC_KEY;
  try {
    webpush.setVapidDetails("mailto:hallo@example.com", APP_VAPID_PUBLIC_KEY, clean(Deno.env.get("VAPID_PRIVATE_KEY")));
  } catch (e) {
    return json({ error: "vapid", detail: String(e), vapidMatchesApp, envPublicLength: envPublic.length }, 500);
  }

  const params = new URL(req.url).searchParams;
  const dry = params.has("dry");
  const { date, hour } = berlinNow();
  // Der Zeitplan läuft um 18 und 19 Uhr UTC; gesendet wird nur, wenn es in Berlin 20 Uhr ist.
  if (!params.has("force") && hour !== 20) return json({ skipped: "not 20:00 in Berlin", hour, date });

  const [subsRes, writtenRes, pairsRes] = await Promise.all([
    supabase.from("push_subscriptions").select("user_id, endpoint, p256dh, auth"),
    supabase.from("shared_entries").select("user_id").eq("entry_date", date),
    supabase.from("partnerships").select("user_id, partner_id, partner_name"),
  ]);
  const err = subsRes.error || writtenRes.error || pairsRes.error;
  if (err) return json({ error: err.message }, 500);

  const done = new Set((writtenRes.data || []).map((r) => r.user_id));
  const partnerOf = new Map((pairsRes.data || []).map((p) => [p.user_id, p]));

  let sent = 0, skipped = 0;
  const failed: unknown[] = [];
  const preview: unknown[] = [];
  for (const sub of subsRes.data || []) {
    if (done.has(sub.user_id)) { skipped++; continue; }
    const p = partnerOf.get(sub.user_id);
    const body = p && done.has(p.partner_id)
      ? `${p.partner_name} hat schon geschrieben. Und was war heute dein schönster Moment?`
      : "Was war heute dein schönster Moment? Halte ihn kurz fest.";
    if (dry) { preview.push({ user: sub.user_id.slice(0, 8), body }); continue; }
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title: "Wir zwei", body, url: "./?tab=wir" }),
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      failed.push({ user: sub.user_id.slice(0, 8), code });
      if (code === 404 || code === 410) {
        await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      }
    }
  }
  return json({ date, sent, skipped, failed, vapidMatchesApp, ...(dry ? { preview } : {}) });
});
