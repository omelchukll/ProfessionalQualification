ProfessionalQualification — read-only MVP

Структура в репозиторії:

index.html
app.js
styles.css
data/
  index.json
  references/
    education-levels.json
    qualifications.json
    specialties.json
    units.json
  programs/
  program-qualifications/

ВАЖЛИВО:
Не відкривайте index.html подвійним кліком (file://), бо браузер може блокувати fetch JSON.
Запустіть через локальний HTTP server або GitHub Pages.

Локально, якщо встановлено Python:
  python -m http.server 8080

Потім відкрийте:
  http://localhost:8080/

Для GitHub Pages:
1. Покласти index.html, app.js, styles.css у корінь репозиторію.
2. Покласти data/ поруч.
3. У GitHub: Settings -> Pages -> Deploy from a branch -> main / root.
