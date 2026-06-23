// Supabase Edge Function: send-daily-reminder
//
// Deployment (ohne CLI): Supabase Dashboard > Edge Functions > "Create a new function"
// Name: send-daily-reminder, dann diesen Code in den eingebauten Editor einfügen und deployen.
//
// Benötigte Secrets (Dashboard > Edge Functions > Manage secrets):
//   VAPID_PUBLIC_KEY            (siehe index.html, Konstante VAPID_PUBLIC_KEY)
//   VAPID_PRIVATE_KEY           (privater Schlüssel — NIE ins Repo committen!)
//   SUPABASE_URL                (wird von Supabase automatisch bereitgestellt)
//   SUPABASE_SERVICE_ROLE_KEY   (wird von Supabase automatisch bereitgestellt)

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

webpush.setVapidDetails("mailto:hallo@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

Deno.serve(async (_req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const today = new Date().toISOString().split("T")[0];

  const { data: entriesToday } = await supabase
    .from("entries")
    .select("user_id")
    .eq("entry_date", today);
  const doneUserIds = new Set((entriesToday || []).map((e) => e.user_id));

  const { data: subs, error } = await supabase.from("push_subscriptions").select("*");
  if (error) return new Response(error.message, { status: 500 });

  let sent = 0;
  for (const sub of subs || []) {
    if (doneUserIds.has(sub.user_id)) continue;
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({
          title: "Das Beste des Tages",
          body: "Hast du heute schon dein Bestes des Tages festgehalten?",
          url: "./?action=new",
        })
      );
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      }
    }
  }

  return new Response(JSON.stringify({ sent, skipped: doneUserIds.size }), {
    headers: { "Content-Type": "application/json" },
  });
});
