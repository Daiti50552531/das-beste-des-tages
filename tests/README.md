# Tests

Browser-Tests mit Playwright. Supabase wird im Browser nachgebildet, es werden
keine echten Daten gelesen oder geschrieben.

```
cd tests
npm install          # xlsx und jszip; Playwright muss vorhanden sein (npm i -D playwright)
npm test
```

Geprüft wird unter anderem, dass alle Einträge geladen werden, auch wenn der
Server pro Abruf nur 1000 Zeilen liefert, dass Backups vollständig sind und
dass bei "Wir zwei" niemand fremde oder private Einträge sieht.
