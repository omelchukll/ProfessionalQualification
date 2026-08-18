ProfessionalQualification — CRUD MVP

ЗАМІНІТЬ У КОРЕНІ GITHUB-РЕПОЗИТОРІЮ 3 ФАЙЛИ:
- index.html
- app.js
- styles.css

Структура даних у поточному репозиторії:
data/index.json
data/references/education-levels.json
data/references/qualifications.json
data/references/specialties.json
data/references/units.json
data/references/programs/<ID>.json
data/references/program-qualifications/<ID>.json

ЯК УВІМКНУТИ РЕДАГУВАННЯ
1. На GitHub створити Fine-grained personal access token.
2. Repository access: Only select repositories -> ProfessionalQualification.
3. Repository permissions -> Contents -> Read and write.
4. На сайті натиснути "Редагування".
5. Ввести token. Owner/repo вже заповнені.
6. Натиснути "Перевірити й підключити".

ВАЖЛИВО
- Token НЕ записаний у JavaScript.
- Token зберігається лише у sessionStorage браузера.
- Після завершення сесії браузера його треба ввести знову.
- Кожен редактор повинен мати власний GitHub-акаунт, доступ до репозиторію і власний token.
- При записі використовується SHA актуальної версії файла; для index.json та qualifications.json є повтор при конфлікті.
- Видалення є фізичним видаленням JSON через GitHub API, але відновлення можливе з історії Git.
- ОП, яка є джерелом поширення для інших ОП, видалити через UI не дозволяється.
- ПК, яка використовується хоча б в одній ОП, видалити через UI не дозволяється.

ФУНКЦІЇ
- Додати ОП.
- Редагувати ОП.
- Видалити ОП.
- Додати нову ПК в довідник.
- Редагувати/видалити ПК (видалення лише якщо не використовується).
- Додати ПК до ОП.
- Вказати первинне погодження або поширення.
- Редагувати/видалити зв’язок ОП–ПК.
- Автоматично оновити data/index.json після змін.

Примітка: для production-версії на 10 редакторів кращою буде авторизація через GitHub App / serverless backend замість персональних token-ів.


ЕКСПОРТ EXCEL
- Кнопка «⬇ Excel» працює без GitHub token, у read-only режимі.
- Можна експортувати поточну відфільтровану вибірку або весь реєстр.
- Формується .xlsx зі стовпчиками A–T, аналогічними вихідному реєстру.
- Для поширеної ПК вихідна ОП записується в A–I, нова ОП — у P–T.
- Кілька ПК в одній клітинці розділяються «; ».
- XLSX генерується безпосередньо в браузері через SheetJS CDN; сервер не потрібен.


НАСТУПНІСТЬ ОП
- Додайте data/program-successions.json у репозиторій поруч із data/index.json.
- data/program-successions-validation.json є службовим файлом перевірки; сайт його не читає.
- У картці ОП з'явиться блок «Наступність освітньої програми».
- Для старої ОП показується «Наступна ОП», для нової — «Попередня ОП».
- Клік по пов'язаній ОП відкриває її картку.
