# Онлайн-доска

Доска для совместного рисования в реальном времени. Открываете сайт, получаете новую доску со своей ссылкой, отправляете ссылку кому угодно и рисуете вместе. Регистрация не нужна.

Умеет: карандаш и маркер (с Shift — прямая линия), линии, стрелки, прямоугольники, эллипсы, текст, стикеры, картинки (кнопка, Ctrl+V или перетаскивание файла; размер меняется за уголок), ластик, выделение и перемещение, отмену и повтор, масштаб, перемещение доски правой кнопкой мыши, живые курсоры и линии других участников прямо во время рисования, экспорт в PNG, тёмную тему, телефоны.

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

## Где работает

**https://online-board.risuem.workers.dev** — Cloudflare Workers. Доски и картинки хранятся в Durable Objects (SQLite), по одному объекту на доску.

## Выложить в интернет

### Cloudflare Workers (бесплатно)

Нужен API-токен Cloudflare по шаблону «Edit Cloudflare Workers».

```bash
npm install
```

```bash
CLOUDFLARE_API_TOKEN=<токен> npx wrangler deploy
```

Страница встраивается в код Worker'а как текст (`[[rules]]` в `wrangler.toml`), отдельной загрузки статических файлов нет. Локально: `npm run dev` → http://localhost:8787.

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
