// Alle Prüfungen der App. Start: im Ordner tests "npm install" und dann "npm test".
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, makeOpen, reporter, iso, isoYearsAgo, XLSX, JSZip, ROOT, OUT } from './harness.mjs';

const now = new Date().toISOString();
const S = (id, user_id, entry_date, text) => ({ id, user_id, entry_date, text, created_at: now, updated_at: now });

// David (u1) führt seit über drei Jahren ein privates Tagebuch: mehr Einträge, als der Server pro Abruf liefert.
const PRIVATE_COUNT = 1240;
const entries = [];
for (let i = 0; i < PRIVATE_COUNT; i++) {
  entries.push({ id: 'e' + String(i).padStart(5, '0'), user_id: 'u1', entry_date: iso(-i), best_of_day: 'Eintrag ' + i,
    lotta: i % 2 ? 'Lotta ' + i : null, thea: null, mood: ['happy', 'neutral', 'sad'][i % 3],
    photo_path: [5, 40, 1100].includes(i) ? `u1/foto-${i}.jpg` : null });
}
entries.push({ id: 'x1', user_id: 'u3', entry_date: iso(0), best_of_day: 'FREMD privat', lotta: null, thea: null, mood: 'happy', photo_path: null });

const DB = {
  profiles: [
    { id: 'u1', settings: { field1Label: 'Lotta', field2Label: 'Thea', field1Enabled: true, field2Enabled: true, accent: 'red', design: 2, onboarded: true } },
    { id: 'u2', settings: {} }, { id: 'u9', settings: {} }
  ],
  entries,
  partnerships: [
    { user_id: 'u1', partner_id: 'u2', partner_name: 'Hanna', shared_only: false },
    { user_id: 'u2', partner_id: 'u1', partner_name: 'David', shared_only: true }
  ],
  shared_entries: [
    S('s1', 'u1', iso(0), 'Kaffee auf dem Balkon, bevor alle wach waren.'),
    S('s2', 'u2', iso(-1), 'Die Kinder haben zusammen gekocht, ganz ohne Streit.'),
    S('s3', 'u1', iso(-1), 'Erster Abend am Kamin in diesem Herbst.'),
    S('s4', 'u1', iso(-2), 'Mittagessen draußen in der Sonne.'),
    S('s5', 'u3', iso(0), 'FREMD darf nie sichtbar sein'),
    S('s6', 'u1', isoYearsAgo(1), 'Vor einem Jahr: erster Schnee.'),
    S('s7', 'u2', isoYearsAgo(1), 'Vor einem Jahr: Plätzchen gebacken.'),
    S('s8', 'u2', isoYearsAgo(2), 'Vor zwei Jahren: Laternenumzug.')
  ],
  entry_likes: [{ entry_id: 's3', user_id: 'u2', created_at: now }],
  push_subscriptions: [], nudges: []
};

const { server, url } = await startServer();
const browser = await launch();
const open = makeOpen(browser, url, DB);
const { check, finish } = reporter();
const allErrors = [];
const vis = (page, sel) => page.locator(sel).first().isVisible();
const txt = (page, sel) => page.locator(sel).first().innerText();
const toast = (page) => page.locator('#toast').innerText();
const ev = (page, fn, arg) => page.evaluate(fn, arg);
const settle = (page, ms = 250) => page.waitForTimeout(ms);
async function done({ ctx, errors }, label) { allErrors.push(...errors.map(e => label + ' ' + e)); await ctx.close(); }
async function download(page, action, name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), action()]);
  const file = path.join(OUT, name);
  await dl.saveAs(file);
  return { file, suggested: dl.suggestedFilename() };
}

// ---------- Quelltext: feste Versionen der Bibliotheken ----------
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const cdn = [...html.matchAll(/https:\/\/cdn\.jsdelivr\.net\/npm\/[^'"\s]+/g)].map(m => m[0]);
  await check('Alle Bibliotheken haben eine feste Version', () => cdn.length >= 4 && cdn.every(u => /@\d+\.\d+\.\d+/.test(u)));
  await check('Service Worker sichert dieselben Bibliotheks-Adressen wie die App lädt', () =>
    [...sw.matchAll(/https:\/\/cdn\.jsdelivr\.net\/npm\/[^'"\s]+/g)].every(m => html.includes(m[0])));
}

// ---------- Privates Tagebuch: nichts darf verloren gehen ----------
{
  const s = await open('u1'); const { page } = s;
  await settle(page, 600);
  await check('Alle 1240 Einträge geladen, obwohl der Server höchstens 1000 pro Abruf liefert', async () =>
    (await ev(page, () => allEntriesCache.length)) === PRIVATE_COUNT);
  await check('Der älteste Eintrag ist dabei', async () =>
    await ev(page, (d) => allEntriesCache.some(e => e.entry_date === d), iso(-(PRIVATE_COUNT - 1))));
  await check('Fremde private Einträge sind nicht dabei', async () => !(await ev(page, () => allEntriesCache.some(e => e.user_id !== 'u1'))));
  await check('Reiter: Wir zwei zuerst, „Tagebuch“ statt „Heute“, David startet im Tagebuch', async () =>
    (await page.locator('.tabbar .tab-btn').first().getAttribute('id')) === 'tabbtn-wir' &&
    (await txt(page, '#tabbtn-heute')).trim() === 'Tagebuch' && await vis(page, '#tab-heute'));
  await check('„An diesem Tag“ zeigt jedes frühere Jahr: vor 1, 2 und 3 Jahren', async () => {
    const t = await txt(page, '#onThisDayContent');
    return t.includes('Vor 1 Jahr') && t.includes('Vor 2 Jahren') && t.includes('Vor 3 Jahren');
  });
  await check('Datumskacheln im Tagebuch zeigen heute', async () =>
    (await page.locator('#editorTiles .wir-tile').allInnerTexts())[1] === String(new Date().getDate()));

  await page.click('#tabbtn-statistik'); await settle(page, 400);
  await check('Statistik zählt alle Einträge', async () => (await txt(page, '#statTotal')).trim() === String(PRIVATE_COUNT));
  await page.click('#tabbtn-verlauf'); await settle(page, 400);
  await check('Verlauf: Monatsüberschrift und Tageskachel', async () =>
    (await page.locator('.month-head').count()) >= 1 && (await page.locator('.entry-card .entry-day-num').count()) >= 10);
  await page.locator('.entry-card').first().click(); await settle(page, 450);
  await check('Detailansicht öffnet mit Datumskacheln', async () =>
    (await page.locator('#detailSheet.open').count()) === 1 && (await page.locator('#detailTiles .wir-tile').count()) === 4);
  await page.click('#detailCloseBtn'); await settle(page, 400);

  // Backup
  await page.click('#tabbtn-mehr'); await settle(page);
  await page.click('#exportTriggerBtn'); await settle(page);
  const x = await download(page, () => page.click('#exportXlsxBtn'), 'journal.xlsx');
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(x.file).Sheets['Journal']);
  await check('Excel-Backup enthält alle 1240 Einträge', () => rows.length === PRIVATE_COUNT);
  await check('Excel-Backup nennt die Foto-Datei zum Eintrag', () =>
    rows.filter(r => r.photo).length === 3 && rows.find(r => r.entry_date === iso(-5)).photo === iso(-5) + '.jpg');
  await settle(page, 300);
  await check('Meldung nennt die Zahl der gesicherten Einträge', async () => (await toast(page)).includes('1240 Einträge'));

  await page.click('#exportTriggerBtn'); await settle(page);
  const z = await download(page, () => page.click('#exportPhotosBtn'), 'fotos.zip');
  const zip = await JSZip.loadAsync(fs.readFileSync(z.file));
  await check('Foto-Backup: ZIP mit allen drei Fotos, benannt nach Datum', () =>
    /^Journal_Fotos_\d{4}-\d{2}-\d{2}\.zip$/.test(z.suggested) && Object.keys(zip.files).sort().join() ===
      [iso(-5), iso(-40), iso(-1100)].map(d => d + '.jpg').sort().join());

  await ev(page, () => { window.__missingPhotos = ['u1/foto-40.jpg']; });
  await page.click('#exportTriggerBtn'); await settle(page);
  await download(page, () => page.click('#exportPhotosBtn'), 'fotos-luecke.zip');
  await settle(page, 300);
  await check('Foto-Backup warnt, wenn ein Foto fehlt', async () => (await toast(page)).includes('1 von 3 Fotos fehlen'));

  await ev(page, () => { window.__offline = true; });
  await page.click('#exportTriggerBtn'); await settle(page);
  await download(page, () => page.click('#exportCsvBtn'), 'journal-offline.csv');
  await settle(page, 300);
  await check('Backup ohne Verbindung warnt, statt Vollständigkeit vorzutäuschen', async () => (await toast(page)).includes('Keine Verbindung'));
  await ev(page, () => { window.__offline = false; });

  // Einstellungen
  await check('Mehr zeigt für David alle Bereiche', async () => await vis(page, '#openSettingsBtn') && await vis(page, '#deleteAllBtn'));
  await page.click('#mehrThemeSeg [data-theme="dark"]'); await settle(page, 150);
  await check('Erscheinungsbild lässt sich auf Dunkel stellen', async () =>
    await ev(page, () => document.body.classList.contains('dark-mode') && localStorage.getItem('theme') === 'dark'));
  await page.click('#mehrThemeSeg [data-theme="light"]');
  await page.selectOption('#reminderHour', '21'); await settle(page, 900);
  await check('Uhrzeit der Erinnerung wird gespeichert, auch in Supabase', async () =>
    (await ev(page, () => window.__db.profiles.find(p => p.id === 'u1').settings.reminderHour)) === 21 && (await toast(page)).includes('21 Uhr'));
  await page.click('#changePasswordBtn'); await settle(page);
  await page.fill('#newPassword', 'neues123'); await page.fill('#confirmPassword', 'neues123');
  await page.click('#setPasswordBtn'); await settle(page, 300);
  await check('Passwort ändern funktioniert aus „Mehr“', async () => !(await vis(page, '#recoveryModal')) && (await toast(page)).includes('Passwort gesetzt'));
  await page.click('.setting-toggle-row .switch'); await settle(page, 300);
  await check('Code-Sperre lässt sich einrichten', async () => (await page.locator('#pinModal:not(.hidden)').count()) === 1);
  await page.click('#pinCancelBtn');
  await done(s, 'david-privat');
}

// ---------- Einstellungen überleben eine Neuinstallation ----------
{
  const s = await open('u1', { settings: null }); const { page } = s;
  await settle(page, 500);
  await check('Neuinstallation: Felder Lotta und Thea kommen aus Supabase zurück, ohne Einrichtungsdialog', async () =>
    await vis(page, '#field1Wrap') && (await txt(page, '#field1EditorLabel')) === 'Lotta' && (await txt(page, '#field2EditorLabel')) === 'Thea' &&
    !(await vis(page, '#onboardingModal')));
  await settle(page, 800);
  await check('Gespeicherte Einstellungen werden nicht mit Vorgaben überschrieben', async () =>
    (await ev(page, () => window.__db.profiles.find(p => p.id === 'u1').settings.field1Label)) === 'Lotta');
  await done(s, 'neuinstallation');
}

// ---------- Wir zwei aus Davids Sicht ----------
{
  const s = await open('u1', { query: '?tab=wir' }); const { page } = s;
  await check('?tab=wir (Tipp auf eine Benachrichtigung) öffnet Wir zwei', async () => await vis(page, '#tab-wir'));
  await check('Schalter „Ich | Hanna“, eigener Eintrag von heute', async () =>
    (await txt(page, '#wirPartnerBtn')) === 'Hanna' && (await txt(page, '#wirCard')).includes('Kaffee auf dem Balkon'));
  await check('Heute vor 1 und 2 Jahren als Knöpfe', async () => {
    const t = await page.locator('#wirMemories .wir-memory').allInnerTexts();
    return t.length === 2 && t[0].includes('Heute vor 1 Jahr') && t[1].includes('Heute vor 2 Jahren');
  });
  await page.locator('#wirMemories .wir-memory').first().click(); await settle(page);
  await check('Tipp springt zum Tag vor einem Jahr', async () =>
    (await txt(page, '#wirCard')).includes('erster Schnee') && (await txt(page, '#wirTodayBtn')) === 'Zu heute' && !(await vis(page, '#wirMemories')));
  await page.click('#wirTodayBtn'); await settle(page);

  // Erinnern
  await page.click('#wirPartnerBtn'); await settle(page);
  await check('Hanna hat heute nichts geschrieben: Knopf „Hanna erinnern“', async () => (await txt(page, '#wirCard [data-wir-nudge]')).includes('Hanna erinnern'));
  await check('Fremde Einträge sind nie sichtbar', async () => !(await ev(page, () => document.body.innerText.includes('FREMD'))));
  await page.click('#wirCard [data-wir-nudge]'); await settle(page, 300);
  await check('Erinnern ruft die Funktion auf und zeigt „Erinnert um …“', async () => {
    const c = (await ev(page, () => window.__invokes)).at(-1);
    return c.name === 'nudge-partner' && c.body.type === 'nudge' && (await txt(page, '#wirCard')).includes('Erinnert um');
  });

  // Herz
  await page.click('#wirPrevBtn'); await settle(page);
  await check('Hannas Eintrag von gestern hat einen Herz-Knopf', async () => (await page.getAttribute('#wirCard .wir-like', 'aria-pressed')) === 'false');
  await page.click('#wirCard .wir-like'); await settle(page, 300);
  await check('Herz wird gespeichert', async () =>
    (await page.getAttribute('#wirCard .wir-like', 'aria-pressed')) === 'true' &&
    await ev(page, () => window.__db.entry_likes.some(l => l.entry_id === 's2' && l.user_id === 'u1')));
  await page.click('#wirCard .wir-like'); await settle(page, 300);
  await check('Herz lässt sich zurücknehmen', async () => !(await ev(page, () => window.__db.entry_likes.some(l => l.entry_id === 's2'))));
  await page.click('#wirCard .wir-like'); await settle(page, 300);
  await page.click('#wirMeBtn'); await settle(page);
  await check('Eigener Eintrag zeigt „Hanna gefällt das“', async () => (await txt(page, '#wirCard')).includes('Hanna gefällt das'));

  // Entwurf und neuer Eintrag (vor drei Tagen ist noch leer)
  await page.click('#wirPrevBtn'); await page.click('#wirPrevBtn'); await settle(page);
  await check('Leerer Tag bietet „Nachtragen“ an', async () => (await txt(page, '#wirCard .wir-write-btn')) === 'Nachtragen');
  await page.click('#wirCard .wir-write-btn'); await settle(page, 400);
  await check('Schreibfeld hat sofort den Fokus', async () => await ev(page, () => document.activeElement.id === 'wirText'));
  await page.fill('#wirText', 'Halb geschriebener Gedanke');
  await page.click('#wirWriteBack'); await settle(page, 400);
  await check('Zurück sichert den Text als Entwurf', async () =>
    (await toast(page)).includes('Entwurf') && (await txt(page, '#wirCard .wir-write-btn')) === 'Entwurf weiterschreiben');
  await page.reload({ waitUntil: 'load' }); await settle(page, 600);
  await page.click('#tabbtn-wir'); for (let i = 0; i < 3; i++) await page.click('#wirPrevBtn'); await settle(page);
  await page.click('#wirCard .wir-write-btn'); await settle(page, 400);
  await check('Entwurf ist nach dem Schließen der App noch da', async () => (await page.inputValue('#wirText')) === 'Halb geschriebener Gedanke');
  await ev(page, () => { window.__offline = true; });
  await page.click('#wirSaveBtn'); await settle(page, 300);
  await check('Speichern ohne Verbindung: Hinweis, Text bleibt als Entwurf', async () =>
    (await toast(page)).includes('bleibt als Entwurf') && await vis(page, '#wirWrite') &&
    await ev(page, () => localStorage.getItem('wir_draft_v1_u1').includes('Halb geschriebener')));
  await ev(page, () => { window.__offline = false; });
  await page.fill('#wirText', 'Fertiger Gedanke');
  await page.click('#wirSaveBtn'); await settle(page, 400);
  await check('Speichern legt den Eintrag am richtigen Tag an und löscht den Entwurf', async () =>
    await ev(page, (d) => window.__db.shared_entries.some(r => r.user_id === 'u1' && r.entry_date === d && r.text === 'Fertiger Gedanke') &&
      localStorage.getItem('wir_draft_v1_u1') === '{}', iso(-3)));
  await check('Neuer Eintrag meldet „hat geschrieben“ an Hanna', async () => {
    const c = (await ev(page, () => window.__invokes)).at(-1);
    return c.name === 'nudge-partner' && c.body.type === 'wrote' && c.body.entry_date === iso(-3);
  });
  await page.click('#wirCard .wir-edit'); await settle(page, 400);
  await page.fill('#wirText', 'Fertiger Gedanke, verbessert');
  await page.click('#wirSaveBtn'); await settle(page, 400);
  await check('Bearbeiten ändert den Text, ohne Hanna erneut zu benachrichtigen', async () =>
    (await txt(page, '#wirCard')).includes('verbessert') && (await ev(page, () => window.__invokes.filter(c => c.body.type === 'wrote').length)) === 1);
  await check('Das private Tagebuch bleibt unberührt', async () => (await ev(page, () => window.__db.entries.filter(e => e.user_id === 'u1').length)) === PRIVATE_COUNT);
  await page.click('#wirCard .wir-edit'); await settle(page, 400);
  await page.fill('#wirText', ''); await page.click('#wirSaveBtn'); await settle(page, 400);
  await check('Leeren löscht den Eintrag', async () => !(await ev(page, (d) => window.__db.shared_entries.some(r => r.user_id === 'u1' && r.entry_date === d), iso(-3))));
  await page.click('#toastUndoBtn'); await settle(page, 400);
  await check('Rückgängig stellt ihn wieder her', async () => (await txt(page, '#wirCard')).includes('verbessert'));

  // Verlauf
  await page.click('#wirTodayBtn'); await page.click('#wirHistoryBtn'); await settle(page, 450);
  await check('Unser Verlauf: nach Tagen gruppiert, neuester zuerst', async () => {
    const h = await page.locator('.wir-day h3').allInnerTexts();
    return (await txt(page, '#wirHistTitle')) === 'Unser Verlauf' && h[0] === 'Heute' && h[1] === 'Gestern';
  });
  await check('Fehlender Eintrag als Platzhalter, Herz am Eintrag sichtbar', async () =>
    (await page.locator('.wir-day').first().locator('.is-missing').innerText()).includes('Kein Eintrag an diesem Tag') &&
    (await page.locator('.wir-bubble-heart').count()) === 2);
  await page.click('#wirChips button[data-who="partner"]'); await settle(page, 150);
  await check('Filter „Hanna“ zeigt nur Hannas Einträge', async () =>
    (await page.locator('.wir-bubble').count()) === 3 && (await page.locator('.wir-bubble:not(.is-partner)').count()) === 0);
  await page.click('#wirChips button[data-who="both"]');
  await page.fill('#wirSearch', 'kamin'); await settle(page, 150);
  await check('Suche findet den Treffer', async () => (await page.locator('.wir-bubble').count()) === 1);
  await page.fill('#wirSearch', '');
  await page.locator('.wir-bubble.is-partner:not(.is-missing)').first().click(); await settle(page, 450);
  await check('Tipp auf einen Eintrag springt zu Tag und Person', async () =>
    !(await vis(page, '#wirHistory')) && (await page.getAttribute('#wirPartnerBtn', 'aria-pressed')) === 'true' && (await txt(page, '#wirCard')).includes('Kinder'));

  // Backup
  await page.click('#tabbtn-mehr'); await settle(page);
  const x = await download(page, () => page.click('#wirExportBtn'), 'wir.xlsx');
  const wb = XLSX.readFile(x.file);
  const all = XLSX.utils.sheet_to_json(wb.Sheets['Alle Einträge']);
  await check('Wir-zwei-Backup: zwei Blätter, alle Einträge, Herz vermerkt, nichts Fremdes', () =>
    wb.SheetNames.join() === 'Nach Tagen,Alle Einträge' && all.length === 8 && all.filter(r => r.Herz === 'ja').length === 2 &&
    !JSON.stringify(all).includes('FREMD'));
  await done(s, 'david-wir');
}

// ---------- Hanna: sieht nur Wir zwei ----------
{
  const s = await open('u2', { settings: { onboarded: false }, welcomeSeen: false }); const { page } = s;
  await check('Hanna startet auf Wir zwei mit Begrüßung, ohne Einrichtungsdialog', async () =>
    await vis(page, '#tab-wir') && await vis(page, '#wirWelcome') && (await txt(page, '#wirWelcomePartner')).includes('„David“') && !(await vis(page, '#onboardingModal')));
  await page.click('#wirWelcomeBtn'); await settle(page);
  await check('Hanna sieht nur die Reiter Wir zwei und Mehr', async () => {
    const v = []; for (const id of ['wir', 'heute', 'verlauf', 'statistik', 'mehr']) v.push(await vis(page, '#tabbtn-' + id));
    return v.join() === 'true,false,false,false,true';
  });
  await check('Hanna hat heute nichts geschrieben: „Jetzt schreiben“', async () => (await txt(page, '#wirCard .wir-write-btn')) === 'Jetzt schreiben');
  await page.click('#wirPartnerBtn'); await settle(page);
  await check('Hanna sieht Davids Eintrag, aber keinen Erinnern-Knopf', async () =>
    (await txt(page, '#wirCard')).includes('Kaffee') && (await page.locator('#wirCard [data-wir-nudge]').count()) === 0);
  await check('Hanna sieht nichts aus Davids privatem Tagebuch', async () =>
    !(await ev(page, () => document.body.innerText.includes('Eintrag 0'))) && (await ev(page, () => allEntriesCache.length)) === 0);
  await page.click('#tabbtn-mehr'); await settle(page);
  await check('Mehr für Hanna: Benachrichtigungen, Backup, Passwort, Abmelden, aber keine privaten Werkzeuge', async () =>
    await vis(page, '#reminderHour') && await vis(page, '#wirExportBtn') && await vis(page, '#changePasswordBtn') && await vis(page, '#logoutBtn') &&
    !(await vis(page, '#openSettingsBtn')) && !(await vis(page, '#exportTriggerBtn')) && !(await vis(page, '#deleteAllBtn')));
  await page.reload({ waitUntil: 'load' }); await settle(page, 600);
  await check('Begrüßung erscheint nur einmal', async () => !(await vis(page, '#wirWelcome')));
  await done(s, 'hanna');
}
{
  const s = await open('u2', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  const { page } = s;
  await page.click('#tabbtn-mehr'); await settle(page);
  await page.click('#reminderToggle + .slider'); await settle(page, 300);
  await check('iPhone in Safari: Hinweis auf den Home-Bildschirm, Schalter bleibt aus', async () =>
    (await toast(page)).includes('Home-Bildschirm') && !(await page.isChecked('#reminderToggle')));
  await done(s, 'hanna-iphone');
}

// ---------- Neue, noch nicht verknüpfte Person ----------
{
  const s = await open('u9', { settings: { onboarded: false }, welcomeSeen: false }); const { page } = s;
  await check('Unverknüpft ohne Tagebuch: nur Wir zwei, Begrüßung ohne Namen', async () =>
    await vis(page, '#tab-wir') && !(await vis(page, '#tabbtn-heute')) && (await txt(page, '#wirWelcomePartner')).includes('Sobald ihr verbunden seid'));
  await page.click('#wirWelcomeBtn'); await settle(page);
  await check('Unverknüpft: kein Partner-Schalter, Hinweis sichtbar', async () => !(await vis(page, '#wirPartnerBtn')) && await vis(page, '#wirNote'));
  await done(s, 'unverknuepft');
}

// ---------- Anmelden und Registrieren ----------
{
  const s = await open(null); const { page } = s;
  await check('Anmeldung: neuer Schlüsseltyp oder alter Schlüssel ist gesetzt', async () => /^(sb_publishable_|eyJ)/.test(await ev(page, () => window.__clientKey)));
  await page.fill('#authEmail', 'x@example.org'); await page.fill('#authPassword', 'falsch1');
  await ev(page, () => { window.__signinResult = { data: {}, error: { message: 'Invalid login credentials', code: 'invalid_credentials' } }; });
  await page.click('#loginBtn'); await settle(page, 300);
  await check('Falsches Passwort: verständliche Meldung', async () => (await toast(page)).includes('E-Mail oder Passwort stimmt nicht'));
  await done(s, 'anmelden');
}
{
  const s = await open(null, { query: '?registrieren' }); const { page } = s;
  await check('?registrieren öffnet direkt „Account erstellen“', async () => (await txt(page, '#loginBtn')) === 'Account erstellen' && await vis(page, '#pwHint'));
  await page.fill('#authEmail', 'neu@example.org'); await page.fill('#authPassword', '123');
  await page.click('#loginBtn'); await settle(page, 200);
  await check('Zu kurzes Passwort wird abgefangen', async () => (await toast(page)).includes('mindestens 6') && !(await ev(page, () => !!window.__signup)));
  await page.fill('#authPassword', 'geheim123'); await page.click('#loginBtn'); await settle(page, 300);
  await check('Registrierung zeigt „Fast geschafft“ mit der Adresse', async () =>
    (await ev(page, () => window.__signup.email)) === 'neu@example.org' && await vis(page, '#authSent') && (await txt(page, '#authSentEmail')) === 'neu@example.org');
  await page.click('#authResendBtn'); await settle(page, 200);
  await check('Bestätigungsmail lässt sich erneut senden', async () => (await ev(page, () => window.__resend && window.__resend.email)) === 'neu@example.org');
  await done(s, 'registrieren');
}
{
  const s = await open(null, { query: '#error=access_denied&error_code=otp_expired&error_description=x' }); const { page } = s;
  await check('Abgelaufener Link: verständlicher Hinweis', async () => (await toast(page)).includes('abgelaufen'));
  await done(s, 'link');
}

await check('Keine JavaScript-Fehler in allen Durchläufen', () => { if (allErrors.length) console.log(allErrors.join('\n')); return allErrors.length === 0; });
const bad = finish();
await browser.close(); server.close();
process.exit(bad ? 1 : 0);
