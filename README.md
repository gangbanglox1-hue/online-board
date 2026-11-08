# Онлайн-доска

Доска для совместного рисования в реальном времени. Открываете сайт, получаете новую доску со своей ссылкой, отправляете ссылку кому угодно и рисуете вместе. Регистрация не нужна.

Умеет: карандаш, маркер, линии, стрелки, прямоугольники, эллипсы, текст, стикеры, ластик, выделение и перемещение, отмену и повтор, масштаб, курсоры участников с именами, экспорт в PNG, тёмную тему, телефоны.

## Запуск у себя

Нужен Node.js 18 или новее.

```bash
npm install
npm start
```

Откройте http://localhost:3000 — вас перенаправит на новую доску вида `/b/xxxxxxxx`.

Настройки через переменные окружения:

- `PORT` — порт (по умолчанию 3000)
- `DATA_DIR` — папка, где хранятся доски (по умолчанию `./data`)

## Выложить в интернет

### Cloudflare Workers (бесплатно, рекомендуется)

Доски хранятся в Durable Objects, сайт не засыпает, карта не нужна.

1. Cloudflare → **Workers & Pages → Create → Import a repository** → выберите этот репозиторий.
2. Имя проекта оставьте **online-board** (как в `wrangler.toml`). Команду деплоя не меняйте: `npx wrangler deploy`.
3. **Deploy**. Сайт появится по адресу `https://online-board.<ваш-поддомен>.workers.dev`, а каждый push в main будет обновлять его сам.

Локально: `npm run dev` (http://localhost:8787), выложить вручную: `npx wrangler login`, затем `npm run deploy`.

### Свой сервер на Node.js

Подойдёт любой хостинг, который запускает Node.js и поддерживает WebSocket: Render, Railway, Fly.io, свой VPS.

**Render.com:** New → Web Service → подключите репозиторий. Build command: `npm install`, start command: `npm start`. Чтобы доски не пропадали при перезапуске, добавьте Disk с путём `/data` и переменную `DATA_DIR=/data`.

**Docker / VPS:**

```bash
docker build -t online-board .
docker run -d -p 80:3000 -v board-data:/data --restart unless-stopped online-board
```

## Как устроено

- `src/worker.js` + `wrangler.toml` — версия для Cloudflare Workers.
- `server.js` — HTTP-сервер для страницы и WebSocket `/ws` для синхронизации. Каждая доска хранится в `DATA_DIR/<id>.json`.
- `public/index.html` — вся клиентская часть, без сборки.
