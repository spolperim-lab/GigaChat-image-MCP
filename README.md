# gigachat-image-mcp

MCP-сервер для Claude (Claude Code и Claude Desktop): генерирует картинки по текстовому описанию через **GigaChat API** (встроенная модель Kandinsky), сохраняет их в папку как JPG и возвращает путь к файлу. Дальше Claude может вставить картинку в презентацию, документ и т.д.

Работает из России: регистрация через Сбер ID, есть бесплатный режим для физлиц, VPN и иностранные карты не нужны.

## Инструменты

| Инструмент | Что делает | Стоит ли денег |
|---|---|---|
| `generate_image` | Рисует картинку по промпту и сохраняет JPG. Если генерация дольше `GIGACHAT_WAIT_MS`, возвращает `job_id`, а рисование продолжается в фоне | Да — тратит лимит GigaChat |
| `check_image` | Показывает статус задачи по `job_id` или список последних задач | Нет — к Сберу не обращается |

В описании `generate_image` прописано, что Claude обязан спрашивать разрешение перед каждым вызовом. Все вызовы пишутся в лог `gigachat-image.log`.

## Что понадобится

- [Node.js](https://nodejs.org/) 20 или новее
- Ключ авторизации GigaChat API
- Корневой сертификат НУЦ Минцифры (уже лежит в `certs/`)

## Установка

### 1. Скачать и установить зависимости

```bash
git clone https://github.com/spolperim-lab/GigaChat-image-MCP.git
cd GigaChat-image-MCP
npm install
```

### 2. Получить ключ GigaChat

1. Зайдите на [developers.sber.ru](https://developers.sber.ru) через Сбер ID.
2. Создайте проект **GigaChat API**.
3. «Настроить API» → «Получить ключ» → скопируйте **Authorization Key** (показывается один раз!).
4. Скопируйте `key.env.example` в `key.env` и вставьте ключ в строку `Authorization_Key`.

> ⚠️ `key.env` — это секрет. Не выкладывайте его в интернет и не пересылайте. Он уже добавлен в `.gitignore`.

### 3. Сертификат

Серверы Сбера используют сертификат российского удостоверяющего центра, которому Node.js по умолчанию не доверяет. Он лежит в `certs/russian_trusted_ca.pem` и подключается через переменную `NODE_EXTRA_CA_CERTS` (см. настройки ниже). Системные настройки Windows менять не нужно.

Промежуточный сертификат действует до **6 марта 2027**. Если после этой даты появятся ошибки `SELF_SIGNED_CERT_IN_CHAIN` или `UNABLE_TO_GET_ISSUER_CERT`, скачайте свежие `russian_trusted_root_ca.cer` и `russian_trusted_sub_ca.cer` с [Госуслуг](https://www.gosuslugi.ru/crt) и пересоберите `russian_trusted_ca.pem`.

### 4. Подключить к Claude

Во всех примерах замените `C:/path/to/gigachat-image-mcp` на реальный путь к папке (прямые слэши `/` работают и в Windows).

**Claude Code** — команда в терминале:

```bash
claude mcp add gigachat-image --scope user -e GIGACHAT_KEY_FILE=C:/path/to/gigachat-image-mcp/key.env -e IMAGE_OUTPUT_DIR=C:/path/to/images -e NODE_EXTRA_CA_CERTS=C:/path/to/gigachat-image-mcp/certs/russian_trusted_ca.pem -- node C:/path/to/gigachat-image-mcp/index.js
```

Чтобы Claude Code всегда спрашивал подтверждение перед генерацией, добавьте в `~/.claude/settings.json`:

```json
{
  "permissions": {
    "ask": ["mcp__gigachat-image__generate_image"]
  }
}
```

**Claude Desktop** — добавьте в `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "gigachat-image": {
      "command": "node",
      "args": ["C:/path/to/gigachat-image-mcp/index.js"],
      "env": {
        "GIGACHAT_KEY_FILE": "C:/path/to/gigachat-image-mcp/key.env",
        "IMAGE_OUTPUT_DIR": "C:/path/to/images",
        "NODE_EXTRA_CA_CERTS": "C:/path/to/gigachat-image-mcp/certs/russian_trusted_ca.pem"
      }
    }
  }
}
```

После правки полностью перезапустите Claude Desktop (через значок в трее → «Выйти»). Когда Desktop спросит разрешение на инструмент, не выбирайте «Всегда разрешать», если хотите подтверждать каждую генерацию.

## Настройки (переменные окружения)

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `GIGACHAT_AUTH_KEY` | — | Ключ авторизации напрямую (вместо файла) |
| `GIGACHAT_KEY_FILE` | — | Путь к `key.env` |
| `GIGACHAT_SCOPE` | `GIGACHAT_API_PERS` | Тип доступа (для физлиц — по умолчанию) |
| `GIGACHAT_API_BASE` | `https://gigachat.devices.sberbank.ru/api/v1` | Адрес API |
| `IMAGE_OUTPUT_DIR` | `./images` | Куда сохранять картинки |
| `GIGACHAT_LOG_FILE` | `gigachat-image.log` рядом с `index.js` | Лог вызовов |
| `GIGACHAT_WAIT_MS` | `40000` | Сколько ждать картинку до ответа «ещё рисуется» |
| `GIGACHAT_TIMEOUT_MS` | `180000` | Таймаут одного запроса к Сберу |
| `NODE_EXTRA_CA_CERTS` | — | Путь к `certs/russian_trusted_ca.pem` |

## Советы

- Промпт лучше писать подробно и по-русски: объект, стиль, освещение, ракурс, фон, палитра.
- Kandinsky плохо рисует текст на картинках — надписи лучше добавлять в самой презентации.
- Стиль можно задать параметром `style`, например: «Ты — художник-минималист, рисуешь плоские векторные иллюстрации».

## Лицензия

MIT
