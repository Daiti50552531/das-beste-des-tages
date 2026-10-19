// Supabase Edge Function: nudge-partner (live seit 19.10.2026, verify_jwt = false)
//
// "Erinnern"-Knopf bei "Wir zwei": schickt der verknüpften Person sofort eine
// Benachrichtigung, dass heute noch ein Eintrag fehlt. Höchstens einmal pro Tag
// und Richtung (Tabelle nudges, siehe setup.sql). Die Anmeldung wird in der
// Funktion selbst über das Token der App geprüft.
//
// Benötigte Secrets: VAPID_PRIVATE_KEY (wie send-daily-reminder).
// Den mailto-Kontakt unten vor dem Deployen durch eine eigene Adresse ersetzen.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_VAPID_PUBLIC_KEY = "BAQvAK4Ysgh3pVjZjqZuYwOOteBBmCNkyOiwtFQC8S6baQoGl7VxuZzyDbz4XRs7u4uz-b3yYQfQwtlzdfG6Kuk";

const clean = (v: string | undefined) =>
  (v ?? "").trim().replace(/^["']|["']$/g, "").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function berlinToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ status: "error", error: "method" }, 405);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(token);
  const me = auth?.user;
  if (!me) return json({ status: "error", error: "unauthorized" }, 401);

  const { data: pair } = await admin.from("partnerships").select("partner_id").eq("user_id", me.id).maybeSingle();
  if (!pair) return json({ status: "no_partner" }, 403);
  const partnerId = pair.partner_id;
  // So heißt die absendende Person aus Sicht der Partnerin/des Partners
  const { data: back } = await admin.from("partnerships").select("partner_name")
    .eq("user_id", partnerId).eq("partner_id", me.id).maybeSingle();
  const fromName = back?.partner_name || "Dein Schatz";
  const today = berlinToday();

  const { data: written } = await admin.from("shared_entries").select("id")
    .eq("user_id", partnerId).eq("entry_date", today).maybeSingle();
  if (written) return json({ status: "already_written" });

  const { data: subs } = await admin.from("push_subscriptions").select("endpoint, p256dh, auth").eq("user_id", partnerId);
  if (!subs || subs.length === 0) return json({ status: "unreachable" });

  const { data: nudge, error: insErr } = await admin.from("nudges")
    .insert({ from_user: me.id, to_user: partnerId, nudge_date: today })
    .select("id, created_at").single();
  if (insErr) {
    const { data: prev } = await admin.from("nudges").select("created_at")
      .eq("from_user", me.id).eq("to_user", partnerId).eq("nudge_date", today).maybeSingle();
    if (prev) return json({ status: "already_nudged", nudged_at: prev.created_at });
    return json({ status: "error", error: insErr.message }, 500);
  }

  webpush.setVapidDetails("mailto:hallo@example.com", APP_VAPID_PUBLIC_KEY, clean(Deno.env.get("VAPID_PRIVATE_KEY")));
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title: "Wir zwei", body: `${fromName} denkt an dich: Was war heute dein schönster Moment?`, url: "./?tab=wir" }),
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    }
  }
  if (sent === 0) {
    // Nichts zugestellt: Sperre für heute wieder aufheben, damit ein neuer Versuch möglich ist
    await admin.from("nudges").delete().eq("id", nudge.id);
    return json({ status: "unreachable" });
  }
  return json({ status: "sent", nudged_at: nudge.created_at });
});
