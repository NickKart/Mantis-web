# Старая версия Mantis web – вариант B A/B-теста

Копия github.com/Khomutyanskiy/mantiswebv1 на коммите 2c7d700 (с согласия автора) для A/B-теста против новой версии. Подробности – в [docs/ab-test.md](../docs/ab-test.md).

Изменения относительно оригинала:

- `src/ui/subscription.tsx`, кнопки «Подписка» в `index.html` – подписка через ЮKassa из новой версии;
- `src/cloud/firebase.ts` – `idToken()` для сервера оплаты и событие регистрации;
- `src/cloud/account.ts`, `src/multi/model.ts`, `src/pilot/runner.ts`, `src/twin/store.ts`, `src/main.ts` – события A/B-теста (`ab/client.ts`);
- `package.json` – только версия для экрана «О приложении»; зависимости берутся из корня репозитория.

Сборка – `npm run build` в корне (собирает обе версии, старая попадает в `dist/b`), разработка – `npm run dev:b` (http://localhost:5174).
