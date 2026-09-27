# App mit einer weiteren Person teilen

Checkliste für den Fall, dass neben dir noch jemand die App nutzt. Die Schritte
passieren im Supabase-Dashboard, nicht in der App. Die Menüpunkte können je
nach Dashboard-Version etwas anders heißen.

## 1. Zugriffsschutz prüfen (Pflicht, auch ohne zweite Person)

Die App lädt Einträge ohne eigenen Filter auf den Nutzer. Dass jede Person nur
ihre eigenen Einträge sieht, stellt allein Row Level Security (RLS) auf der
Tabelle `entries` sicher.

**Prüfen:** SQL Editor, dann diese Abfrage ausführen:

```sql
select relname, relrowsecurity from pg_class where relname = 'entries';
select policyname, cmd, qual from pg_policies where tablename = 'entries';
```

- `relrowsecurity = true` und eine Regel mit `auth.uid()`: alles gut.
- `false` oder keine Regel: Abschnitt **0** aus `setup.sql` ausführen.

Der Abschnitt ist mehrfach ausführbar und läuft in einer Transaktion. Entweder
werden Einschalten und Regel beide wirksam oder keins von beiden. So kann es
nicht passieren, dass RLS an ist, die Regel aber fehlt und du dich aussperrst.

Danach einmal in der App prüfen, ob deine Einträge noch da sind.

Die Edge Function für die Erinnerung nutzt den Service-Role-Schlüssel und ist
von RLS nicht betroffen.

## 2. Registrierung: offen oder nur auf Einladung

Solange die Registrierung offen ist, kann jede Person, die die Adresse der App
kennt, einen Account anlegen. Das Repo ist öffentlich.

**Empfehlung: nur auf Einladung.**

1. Authentication, Einstellungen zu Sign In / Providers: neue Registrierungen
   abschalten („Allow new users to sign up“).
2. Authentication, Users, „Invite user“: E-Mail-Adresse deines Freundes
   eintragen.
3. Er bekommt eine Mail mit Link. Nach dem Klick fragt die App ihn nach einem
   Passwort und führt ihn danach durch die Einrichtung.

Drückt jemand bei geschlossener Registrierung auf „Account erstellen“, zeigt
die App „Die Registrierung ist geschlossen. Bitte lass dich einladen.“

## 3. Adressen für die Links in den E-Mails

Authentication, URL Configuration:

- **Site URL** muss die Adresse der App sein, vermutlich
  `https://daiti50552531.github.io/das-beste-des-tages/`
- Dieselbe Adresse unter **Redirect URLs** eintragen.

Sonst führen Bestätigungs-, Einladungs- und Passwort-Links ins Leere.

## 4. E-Mail-Versand

Supabase verschickt Mails standardmäßig über einen eingebauten Dienst, der nur
zum Testen gedacht und stark begrenzt ist. Für eine zweite Person reicht das
wahrscheinlich. Für mehr: eigenen SMTP-Anbieter unter Authentication, SMTP
Settings eintragen. Siehe https://supabase.com/docs/guides/auth/auth-smtp

Die Texte der Mails lassen sich unter Authentication, Email Templates ändern,
zum Beispiel auf Deutsch.

## 5. Was die andere Person wissen sollte

- **Du kannst ihre Einträge lesen.** Als Besitzer des Supabase-Projekts siehst
  du im Dashboard alle Daten. RLS schützt Nutzer voreinander, nicht vor dem
  Admin. Das sollte sie wissen, bevor sie schreibt.
- **Einstellungen gelten pro Gerät.** Name, Extra-Felder, Farbe und Code-Sperre
  liegen im Browser. Auf einem zweiten Gerät richtet sie das neu ein.
- **Erinnerung:** kommt für alle zur selben Uhrzeit, nämlich dann, wenn der
  Cron-Job die Edge Function aufruft.
- **Account löschen** geht nicht in der App, das musst du im Dashboard
  erledigen (Authentication, Users).

## 6. Rechtliches (keine Rechtsberatung)

Für eine einzelne Person im privaten Rahmen greift vermutlich die
Haushaltsausnahme der DSGVO (Art. 2 Abs. 2 lit. c). Sobald mehr Leute oder
Fremde dazukommen, braucht es Datenschutzerklärung, Impressum und einen
Auftragsverarbeitungsvertrag mit Supabase. Stimmungsangaben können als
Gesundheitsdaten gelten, die besonders geschützt sind. Im Zweifel prüfen
lassen.
