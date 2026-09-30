/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — HTTP-слой: общие middleware и обработка ошибок
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');

const { ApiError } = require('./util');
const { LIMITS, T } = require('./config');

/** Оборачивает async-обработчик, чтобы отказ прилетел в errorMiddleware. */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Разбор JSON-тела с ограничением размера.
 * Ошибки приходят нашим ApiError, а не стандартными кодами body-parser,
 * чтобы фронт всегда получал одинаковый { error, code }.
 */
function jsonBody(limitBytes = LIMITS.bodyBytes) {
  const parser = express.json({ limit: limitBytes, strict: false });
  return (req, res, next) => {
    parser(req, res, (err) => {
      if (err) {
        if (err.type === 'entity.too.large') {
          return next(new ApiError(413, 'Слишком большой запрос', 'too_large'));
        }
        if (err.type === 'entity.parse.failed') {
          return next(new ApiError(400, 'Некорректный JSON', 'bad_json'));
        }
        return next(err);
      }
      // без тела (GET, DELETE) express оставляет req.body пустым объектом,
      // но если запрос не проходил через парсер — приводим к объекту руками
      if (!req.body || typeof req.body !== 'object') req.body = {};
      next();
    });
  };
}

/** Простейший rate limit в памяти: окно в миллисекундах + максимум запросов. */
function rateLimit({ windowMs = 60_000, max = 120, key = (req) => req.user?.id || req.ip, message = 'Слишком много запросов, подожди' } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const k = String(key(req));
    const now = Date.now();
    const rec = hits.get(k);
    if (!rec || now > rec.reset) {
      hits.set(k, { count: 1, reset: now + windowMs });
    } else if (++rec.count > max) {
      const wait = Math.ceil((rec.reset - now) / 1000);
      res.set('Retry-After', String(wait));
      return next(new ApiError(429, message, 'rate_limited'));
    }
    // чистим протухшие записи, чтобы карта не росла бесконечно
    if (hits.size > 5000) {
      for (const [kk, rr] of hits) if (now > rr.reset) hits.delete(kk);
    }
    next();
  };
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: T.ERR_NOT_FOUND, path: req.path });
}

// eslint-disable-next-line no-unused-vars
function errorMiddleware(err, req, res, _next) {
  if (err instanceof ApiError) {
    // DOTACUSTOMS_DEBUG=1 кладёт в ответ стек — помогает найти место 400
    const body = { error: err.message, code: err.code, details: err.details };
    if (process.env.DOTACUSTOMS_DEBUG === '1') body.debug = err.stack;
    return res.status(err.status).json(body);
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Некорректный JSON', code: 'bad_json' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Слишком большой запрос', code: 'too_large' });
  }
  console.error('[dotacustoms] необработанная ошибка:', err);
  res.status(500).json({ error: T.ERR_SERVER, code: 'server_error' });
}

/** Согласованный CORS: приложение и локальный сервер хаба. */
function cors(req, res, next) {
  res.set('Access-Control-Allow-Origin', req.get('origin') || '*');
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.set('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

module.exports = { wrap, jsonBody, rateLimit, cors, notFoundHandler, errorMiddleware, LIMITS };
