/* Сборка воркера в ОДИН файл: worker/bundle.js
 *
 * Зачем: в веб-редакторе Cloudflare проще вставить один файл, чем собирать
 * многофайловый проект. bundle.js — это telegram.js + worker.js, склеенные так,
 * что импорт между ними больше не нужен.
 *
 * Запуск:  node dev/build-worker.mjs
 * Повторять после КАЖДОЙ правки worker.js или telegram.js.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const telegram = readFileSync(join(root, 'worker', 'telegram.js'), 'utf8');
const worker = readFileSync(join(root, 'worker', 'worker.js'), 'utf8');

// 1. Из telegram.js убираем слова export — функции станут просто локальными.
const telegramInline = telegram
  .replace(/^export\s+(async\s+function|function|const|let|class)/gm, '$1')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

// 2. Из worker.js убираем импорт telegram.js — функции уже будут рядом.
const workerInline = worker.replace(
  /^import\s*\{[^}]*\}\s*from\s*['"]\.\/telegram\.js['"];?\s*$/gm,
  '// (импорт не нужен: код telegram.js вставлен выше)'
);

const out = `/* СОБРАННЫЙ ФАЙЛ — не редактировать вручную.
 * Собран из worker/telegram.js + worker/worker.js командой: node dev/build-worker.mjs
 * Правки вносить в исходные файлы и пересобирать, иначе они потеряются.
 */

// ==================== worker/telegram.js ====================
${telegramInline}

// ==================== worker/worker.js ====================
${workerInline}
`;

writeFileSync(join(root, 'worker', 'bundle.js'), out, 'utf8');

const lines = out.split('\n').length;
const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
console.log(`worker/bundle.js собран: ${lines} строк, ${kb} КБ`);

// Проверка, что в собранном файле не осталось экспортов/импортов между модулями
const leftovers = [];
if (/^import\s/m.test(out.replace(/^\/\*[\s\S]*?\*\//, ''))) leftovers.push('остался import');
if (/^export\s+(async\s+)?function/m.test(out)) leftovers.push('остался export function');
if (!/export\s+default\s*\{/.test(out)) leftovers.push('ПОТЕРЯН export default воркера');
if (leftovers.length) {
  console.error('ПРОБЛЕМА:', leftovers.join(', '));
  process.exit(1);
}
console.log('проверка сборки: импортов между модулями нет, export default на месте');
