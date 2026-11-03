#!/usr/bin/env node
// MCP-сервер: рисует картинку через GigaChat (встроенный Kandinsky),
// скачивает JPG в папку и возвращает путь к файлу.
//
// Как работает генерация:
//   generate_image запускает задачу и ждёт результат не дольше GIGACHAT_WAIT_MS (по умолчанию 40 с).
//   Успела — возвращает картинку сразу. Не успела — возвращает job_id и будущий путь к файлу,
//   а генерация продолжается в фоне. Статус проверяется бесплатным инструментом check_image.
//   Каждый вызов (старт, успех, ошибка, ответ модели) пишется в лог-файл.
//
// Переменные окружения:
//   GIGACHAT_AUTH_KEY   — ключ авторизации (Base64 client_id:client_secret)
//   GIGACHAT_KEY_FILE   — либо путь к файлу со строкой "Authorization_Key = ..."
//   GIGACHAT_SCOPE      — по умолчанию GIGACHAT_API_PERS
//   GIGACHAT_API_BASE   — по умолчанию https://gigachat.devices.sberbank.ru/api/v1
//   IMAGE_OUTPUT_DIR    — папка для картинок (по умолчанию ./images)
//   GIGACHAT_LOG_FILE   — лог вызовов (по умолчанию gigachat-image.log рядом с index.js)
//   GIGACHAT_WAIT_MS    — сколько ждать результат перед ответом «ещё идёт» (по умолчанию 40000)
//   GIGACHAT_TIMEOUT_MS — таймаут одного HTTP-запроса к Сберу (по умолчанию 180000)
//   NODE_EXTRA_CA_CERTS — путь к сертификату НУЦ Минцифры (нужен для TLS)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const API_BASE = (process.env.GIGACHAT_API_BASE || "https://gigachat.devices.sberbank.ru/api/v1").replace(/\/$/, "");
const SCOPE = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS";
const OUTPUT_DIR = path.resolve(process.env.IMAGE_OUTPUT_DIR || "images");
const LOG_FILE = path.resolve(process.env.GIGACHAT_LOG_FILE || path.join(SCRIPT_DIR, "gigachat-image.log"));
const TIMEOUT_MS = Number(process.env.GIGACHAT_TIMEOUT_MS) || 180_000;
const WAIT_MS = Number(process.env.GIGACHAT_WAIT_MS) || 40_000;

const DEFAULT_STYLE =
  "Ты — профессиональный иллюстратор. На любой запрос пользователя сразу создавай изображение " +
  "с помощью функции text2image, без уточняющих вопросов и без текста на картинке, если о нём не просят.";

// ---------- лог ----------

function log(entry) {
  try {
    appendFileSync(LOG_FILE, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {
    // лог не должен ломать генерацию
  }
}

// ---------- авторизация и API ----------

function readAuthKey() {
  if (process.env.GIGACHAT_AUTH_KEY) return process.env.GIGACHAT_AUTH_KEY.trim();
  const file = process.env.GIGACHAT_KEY_FILE;
  if (!file) throw new Error("Не задан GIGACHAT_AUTH_KEY или GIGACHAT_KEY_FILE");
  const match = readFileSync(file, "utf8").match(/^\s*Authorization_Key\s*=\s*(\S+)/m);
  if (!match) throw new Error(`В файле ${file} не найдена строка "Authorization_Key = ..."`);
  return match[1];
}

let token = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (token && Date.now() < tokenExpiresAt - 60_000) return token;
  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      RqUID: randomUUID(),
      Authorization: `Basic ${readAuthKey()}`,
    },
    body: `scope=${encodeURIComponent(SCOPE)}`,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Ошибка получения токена: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  token = data.access_token;
  tokenExpiresAt = data.expires_at;
  return token;
}

async function api(pathname, init = {}) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${await getToken()}`, ...init.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GigaChat API ${pathname}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

// ---------- файлы ----------

const reservedPaths = new Set(); // пути задач, которые ещё рисуются

function reserveFilePath(dir, filename) {
  const safe = (filename || `gigachat-${new Date().toISOString().replace(/[:.]/g, "-")}`)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\.(jpe?g|png)$/i, "");
  let candidate = path.join(dir, `${safe}.jpg`);
  for (let i = 2; existsSync(candidate) || reservedPaths.has(candidate); i++) {
    candidate = path.join(dir, `${safe}-${i}.jpg`);
  }
  reservedPaths.add(candidate);
  return candidate;
}

// ---------- генерация ----------

async function generateImage({ prompt, style, model }, filePath) {
  const completion = await (
    await api("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        model: model || "GigaChat",
        messages: [
          { role: "system", content: style || DEFAULT_STYLE },
          { role: "user", content: `Нарисуй: ${prompt}` },
        ],
        function_call: "auto",
        stream: false,
      }),
    })
  ).json();

  const content = completion.choices?.[0]?.message?.content ?? "";
  const fileId = content.match(/<img[^>]*\ssrc="([^"]+)"/)?.[1];
  if (!fileId) throw new Error(`GigaChat не создал изображение. Ответ модели: ${content}`);

  const image = Buffer.from(
    await (await api(`/files/${fileId}/content`, { headers: { Accept: "application/jpg" } })).arrayBuffer(),
  );
  writeFileSync(filePath, image);

  return { image, modelText: content.replace(/<img[^>]*\/?>/g, "").trim() };
}

// ---------- задачи ----------

const jobs = new Map(); // job_id -> задача (живут, пока работает сервер)

const seconds = (job) => Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000);

function startJob(args) {
  const id = randomUUID().slice(0, 8);
  const dir = path.resolve(args.output_dir || OUTPUT_DIR);
  mkdirSync(dir, { recursive: true });
  const filePath = reserveFilePath(dir, args.filename);

  const job = { id, status: "running", filePath, prompt: args.prompt, startedAt: Date.now() };
  jobs.set(id, job);
  log({ event: "start", job: id, model: args.model || "GigaChat", file: filePath, prompt: args.prompt });

  job.promise = generateImage(args, filePath)
    .then(
      ({ image, modelText }) => {
        Object.assign(job, { status: "done", image, modelText, finishedAt: Date.now() });
        log({ event: "done", job: id, seconds: seconds(job), file: filePath, modelText });
      },
      (err) => {
        Object.assign(job, { status: "error", error: String(err?.message || err), finishedAt: Date.now() });
        log({ event: "error", job: id, seconds: seconds(job), error: job.error });
      },
    )
    .finally(() => reservedPaths.delete(filePath));

  return job;
}

function jobResult(job, { withImage = true } = {}) {
  if (job.status === "done") {
    const content = [
      {
        type: "text",
        text:
          `Картинка сохранена: ${job.filePath} (задача ${job.id}, ${seconds(job)} с)` +
          (job.modelText ? `\nКомментарий модели: ${job.modelText}` : ""),
      },
    ];
    if (withImage) content.push({ type: "image", data: job.image.toString("base64"), mimeType: "image/jpeg" });
    return { content };
  }
  if (job.status === "error") {
    return {
      isError: true,
      content: [{ type: "text", text: `Ошибка генерации (задача ${job.id}, ${seconds(job)} с): ${job.error}` }],
    };
  }
  return {
    content: [
      {
        type: "text",
        text:
          `Генерация ещё идёт (${seconds(job)} с). Задача: ${job.id}.\n` +
          `Файл будет сохранён как: ${job.filePath}\n` +
          `Проверить статус — инструмент check_image с job_id="${job.id}". ` +
          `Он бесплатный; повторно вызывать generate_image не нужно, иначе лимит спишется второй раз.`,
      },
    ],
  };
}

// ---------- MCP ----------

const server = new McpServer({ name: "gigachat-image", version: "1.1.0" });

server.registerTool(
  "generate_image",
  {
    title: "Сгенерировать картинку (GigaChat / Kandinsky)",
    description:
      "Рисует изображение по текстовому описанию через GigaChat (модель Kandinsky), сохраняет JPG на диск " +
      "и возвращает абсолютный путь к файлу. Промпт лучше писать на русском, подробно: объект, стиль, свет, ракурс, фон. " +
      `Если картинка не готова за ${Math.round(WAIT_MS / 1000)} с, инструмент вернёт job_id и путь будущего файла, ` +
      "а генерация продолжится в фоне — тогда проверяй её через check_image, а не повторным вызовом. " +
      "ВАЖНО: каждый вызов — платный запрос к внешнему API Сбера, расходует лимит пользователя. " +
      "Перед вызовом обязательно спроси разрешение пользователя, показав промпт (или список промптов, если картинок несколько), " +
      "и вызывай инструмент только после явного согласия.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      prompt: z.string().min(1).describe("Что нарисовать"),
      filename: z.string().optional().describe("Имя файла без расширения (по умолчанию — дата и время)"),
      style: z.string().optional().describe("Системный промпт для стиля, например «Ты — художник-минималист, рисуешь плоские векторные иллюстрации»"),
      model: z.string().optional().describe("Модель GigaChat: GigaChat (по умолчанию), GigaChat-Pro, GigaChat-Max"),
      output_dir: z.string().optional().describe("Папка для сохранения (по умолчанию IMAGE_OUTPUT_DIR)"),
    },
  },
  async (args) => {
    try {
      const job = startJob(args);
      await Promise.race([job.promise, new Promise((resolve) => setTimeout(resolve, WAIT_MS))]);
      return jobResult(job);
    } catch (err) {
      log({ event: "error", error: String(err?.message || err), prompt: args.prompt });
      return { isError: true, content: [{ type: "text", text: String(err?.message || err) }] };
    }
  },
);

server.registerTool(
  "check_image",
  {
    title: "Статус генерации картинки",
    description:
      "Бесплатно (без запроса к Сберу) показывает статус задачи generate_image: идёт, готово (с картинкой) или ошибка с причиной. " +
      "Без job_id — список последних задач. Разрешение пользователя не нужно.",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      job_id: z.string().optional().describe("Номер задачи из ответа generate_image"),
    },
  },
  async ({ job_id }) => {
    if (job_id) {
      const job = jobs.get(job_id.trim());
      if (!job) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Задача ${job_id} не найдена — вероятно, сервер перезапускался. История всех вызовов — в логе: ${LOG_FILE}`,
            },
          ],
        };
      }
      return jobResult(job);
    }
    const recent = [...jobs.values()].slice(-10).reverse();
    const lines = recent.map(
      (j) =>
        `${j.id} — ${j.status === "done" ? "готово" : j.status === "error" ? "ошибка" : "идёт"} (${seconds(j)} с): ` +
        (j.status === "error" ? j.error : j.filePath),
    );
    return {
      content: [
        {
          type: "text",
          text: (lines.length ? lines.join("\n") : "С момента запуска сервера задач не было.") + `\nЛог: ${LOG_FILE}`,
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
