# Оплата подписки (ЮKassa)

## Как устроено

- Тарифы – `api/_lib/tariffs.ts` (цены с rcmit.ru/mantis, за камеру в месяц). Тариф выбирается по числу камер: 1 – Старт, 2–4 – Витрина, от 5 – Сеть.
- Пользователь в профиле выбирает камеры и период (месяц или год) → `POST /api/billing/pay` создаёт платёж в ЮKassa → страница оплаты ЮKassa → возврат на `/?payment=return`.
- ЮKassa присылает уведомление на `/api/yookassa/webhook`. Сервер не доверяет телу уведомления и запрашивает платёж у ЮKassa своими ключами. Успешный платёж зачисляется на баланс ровно один раз.
- Сразу после зачисления, а потом каждый месяц, с баланса списывается месячная стоимость тарифа, и «оплачено до» сдвигается на месяц. При оплате за год 12 следующих списаний идут по годовой цене.
- Списание запускают: ежедневный cron Vercel (`/api/cron/charge`, 03:00 UTC = 06:00 МСК) и каждое открытие профиля (`/api/billing/status`). Там же проверяются незавершённые платежи, если уведомление ЮKassa не дошло.
- Если денег на месяц не хватает, подписка помечается «закончилась». После пополнения она продолжается: встык, если перерыв не больше 3 дней, иначе с дня оплаты.
- Пробный период – 7 дней без оплаты, один раз на аккаунт, для Старта и Витрины.

## База (Firestore, проект jinpix-ac93d)

Пишет только сервер (Firebase Admin). Браузер в эти коллекции не ходит.

| Путь | Что хранит |
|---|---|
| `mantis_billing/{uid}` | balance (копейки), plan, cameras, paidUntil, annualUntil, status, trialUsed, autoRenew, email |
| `mantis_billing/{uid}/payments/{id ЮKassa}` | amount, plan, cameras, period, status, credited, createdAt, paidAt |
| `mantis_billing/{uid}/ledger/{id}` | журнал: topup / charge / trial, amount, balanceAfter, from, to, note |

В правилах Firestore закройте эти коллекции от браузера (добавьте перед общими правилами, если они есть):

```
match /mantis_billing/{uid}/{document=**} {
  allow read, write: if false;
}
```

## Переменные окружения Vercel

| Переменная | Откуда |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Console → Project settings → Service accounts → Generate new private key. Содержимое JSON целиком. |
| `YOOKASSA_SHOP_ID` | Личный кабинет ЮKassa → Интеграция → Ключи API (shopId) |
| `YOOKASSA_SECRET_KEY` | Там же, секретный ключ. Для проверки можно сначала взять ключи тестового магазина. |
| `YOOKASSA_VAT_CODE` | Необязательно. Если задан (например `1` – без НДС), к платежу прикладывается чек по 54-ФЗ на почту пользователя. |
| `CRON_SECRET` | Любая случайная строка от 16 символов. Vercel сам передаёт её в ежедневный вызов списания. |
| `APP_URL` | Необязательно. Адрес приложения для возврата после оплаты, по умолчанию https://mantis-web-snowy.vercel.app |

После добавления переменных сделайте Redeploy.

## Уведомления ЮKassa

Личный кабинет ЮKassa → Интеграция → HTTP-уведомления → URL `https://mantis-web-snowy.vercel.app/api/yookassa/webhook`, события `payment.succeeded` и `payment.canceled`.
