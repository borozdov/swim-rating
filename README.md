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

```
node server.js
```

Приложение поднимется на `http://localhost:4173`.

## Прод — Docker на Timeweb VPS

Домен `swim-rating.borozdov.ru` (DNS полностью на Timeweb, без делегирования
куда-либо ещё) указывает A-записью прямо на VPS. На сервере:

```
git clone https://github.com/borozdov/swim-rating.git
cd swim-rating
docker compose up -d --build
```

`docker-compose.yml` поднимает два контейнера: `app` (этот же `server.js`) и
`caddy` — обратный прокси, который сам получает и продлевает HTTPS-сертификат
Let's Encrypt (нужно только, чтобы DNS уже указывал на сервер и были открыты
порты 80/443 — секретов/токенов для этого не требуется).

Обновление после изменений в коде — на сервере:

```
cd swim-rating && git pull && docker compose up -d --build
```

## Альтернатива — Cloudflare Workers

В репозитории есть готовый и рабочий, но сейчас не используемый путь деплоя:
`worker/index.js` + `wrangler.jsonc` — тот же прокси и статика одним Worker'ом,
плюс `.github/workflows/deploy.yml` для автодеплоя при push в `main` (нужны
секреты `CLOUDFLARE_API_TOKEN` с правом Workers Scripts: Edit и
`CLOUDFLARE_ACCOUNT_ID`). Не используется в проде, потому что для собственного
домена на Cloudflare Workers пришлось бы делегировать туда DNS всего
`borozdov.ru` — домен сознательно оставлен на Timeweb. Ручной деплой этим
путём: `npx wrangler login && npx wrangler deploy` (заведёт на
`*.workers.dev`, не на свой домен, без переноса DNS).

## Структура

- `public/` — статика: `index.html`, `app.js`, `styles.css`, `fonts/`
  (кириллический сабсет Inter для PDF-экспорта — шрифты jsPDF по умолчанию не
  содержат кириллицы), `icons/` (фавикон, PWA, Open Graph), `robots.txt`,
  `sitemap.xml`, `site.webmanifest`.
- `server.js` — прокси к rsf.lsport.net (кэш + один повтор при обрыве) и
  раздача `public/` на чистом Node `http`, без зависимостей. Крутится в
  Docker в проде и запускается напрямую для локальной разработки.
- `Dockerfile`, `docker-compose.yml`, `Caddyfile` — прод-деплой на VPS.
- `worker/index.js`, `wrangler.jsonc`, `.github/workflows/deploy.yml` —
  альтернативный путь через Cloudflare Workers (см. выше, сейчас не в проде).

## Данные

Данные предоставляются rsf.lsport.net — порталом Федерации водных видов
спорта России. Проект не аффилирован с федерацией.
