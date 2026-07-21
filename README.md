# Рейтинг пловцов

Неофициальный клиент рейтинга Федерации водных видов спорта России (ФВВСР).
Поиск и фильтрация лучших результатов по дистанциям, стилям, полу, году
рождения, бассейну (25/50 м) и региону. Избранное, поиск себя по нескольким
дистанциям сразу, экспорт результата и списка в PNG/PDF.

Ванильные HTML/CSS/JS без сборки и без зависимостей — исходники подключены
напрямую через `<script>`/`<link>`.

`/api/top` и `/api/locations` — POST-запросы к rsf.lsport.net, поэтому фронтенд
всегда нужен вместе с прокси: чисто статический хостинг (например, GitHub
Pages) их не примет и ответит 405.

## Запуск локально

Без Cloudflare-аккаунта — простой Node-сервер:

```
node server.js
```

Приложение поднимется на `http://localhost:4173`.

Ближе к продакшену — через Wrangler (тот же Worker, что и в проде):

```
npx wrangler dev
```

## Деплой на Cloudflare Workers

Вручную:

```
npx wrangler login   # один раз
npx wrangler deploy
```

Автоматически — `.github/workflows/deploy.yml` деплоит на каждый push в
`main` через [wrangler-action](https://github.com/cloudflare/wrangler-action).
Чтобы он заработал, один раз добавить в **Settings → Secrets and variables →
Actions** этого репозитория два секрета:

- `CLOUDFLARE_API_TOKEN` — API-токен с правом **Workers Scripts: Edit** на
  нужный аккаунт (dashboard.cloudflare.com → **My Profile → API Tokens →
  Create Token**, шаблон "Edit Cloudflare Workers" подходит как есть).
- `CLOUDFLARE_ACCOUNT_ID` — ID аккаунта (виден в дашборде справа на странице
  любого домена/Workers).

После этого `git push` в `main` — единственное, что нужно для выката прода.

## Структура

- `public/` — статика: `index.html`, `app.js`, `styles.css`, `fonts/`
  (кириллический сабсет Inter для PDF-экспорта — шрифты jsPDF по умолчанию не
  содержат кириллицы), `icons/` (фавикон, PWA, Open Graph), `robots.txt`,
  `sitemap.xml`, `site.webmanifest`.
- `worker/index.js` — Cloudflare Worker: проксирует `/api/top` и
  `/api/locations` к rsf.lsport.net (с кэшем через Workers Cache API и одним
  повтором при обрыве соединения), остальные пути отдаёт из `public/` через
  ASSETS-биндинг. Используется в проде (`wrangler.jsonc`).
- `server.js` — тот же прокси на чистом Node `http`, без Cloudflare —
  для локальной разработки без аккаунта/CLI.
- `.github/workflows/deploy.yml` — автодеплой на Cloudflare Workers при push
  в `main` (см. выше про секреты).

## Данные

Данные предоставляются rsf.lsport.net — порталом Федерации водных видов
спорта России. Проект не аффилирован с федерацией.
