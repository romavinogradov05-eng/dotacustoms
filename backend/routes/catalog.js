/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — справочник: герои, предметы, нейтралки, способности
   ──────────────────────────────────────────────────────────────────────
   Датасет (data/dota.json) загружается один раз и отдаётся клиенту
   целиком — приложение работает офлайн и не ходит в интернет.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { assetsDir } = require('../config');
const { wrap } = require('../http');
const { oneOf } = require('../util');

/** Загружает data/dota.json, при отсутствии — пустой каркас. */
function loadDataset() {
  const file = path.join(assetsDir(), 'dota.json');
  if (!fs.existsSync(file)) {
    console.warn('[dotacustoms] не найден data/dota.json — выполни `npm run data:build`');
    return {
      meta: { patch: null, cdn: 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react' },
      patches: [], heroes: [], items: [], neutrals: [], abilities: [],
      custom_items: [], custom_groups: [], custom_source: null,
    };
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function catalogRoutes(ctx) {
  const { dataset } = ctx;
  const router = express.Router();

  // ── весь справочник разом ────────────────────────────────────────────
  router.get('/dataset', wrap((_req, res) => {
    res.set('Cache-Control', 'public, max-age=600');
    res.json(dataset);
  }));

  // ── патчи ────────────────────────────────────────────────────────────
  router.get('/patches', wrap((_req, res) => {
    const n = Math.min(30, dataset.patches.length);
    res.json({ items: dataset.patches.slice(-n).reverse() });
  }));

  // ── герои ────────────────────────────────────────────────────────────
  router.get('/heroes', wrap((req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    let list = dataset.heroes;
    if (q) {
      list = list.filter(h =>
        h.key.includes(q) || h.name.toLowerCase().includes(q) || h.name_en.toLowerCase().includes(q));
    }
    if (req.query.attr) list = list.filter(h => h.attr === String(req.query.attr));
    res.json({ items: list });
  }));

  router.get('/heroes/:id', wrap((req, res) => {
    const h = dataset.heroes.find(x => String(x.id) === String(req.params.id) || x.key === req.params.id);
    if (!h) return res.status(404).json({ error: 'Герой не найден' });
    const abilities = dataset.abilities.filter(a => a.hero === h.key);
    res.json({ hero: h, abilities });
  }));

  // ── предметы ─────────────────────────────────────────────────────────
  router.get('/items', wrap((req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    let list = dataset.items;
    if (q) {
      list = list.filter(i =>
        i.key.includes(q) || i.name.toLowerCase().includes(q) || i.name_en.toLowerCase().includes(q));
    }
    if (req.query.cost_min) list = list.filter(i => i.cost >= Number(req.query.cost_min));
    if (req.query.cost_max) list = list.filter(i => i.cost <= Number(req.query.cost_max));
    if (req.query.category) list = list.filter(i => i.category === String(req.query.category));
    if (oneOf(req.query.custom, ['0', '1'], { required: false }) !== '0') {
      // по умолчанию отдаём и обычные предметы, и кастомные CHC
      list = list.concat(dataset.custom_items || []);
    }
    res.json({ items: list });
  }));

  // ── кастомные предметы Custom Hero Chaos ─────────────────────────────
  // У них нет id в справочнике Valve, но синтетические id у них есть,
  // поэтому в билд-редакторе они работают наравне с обычными.
  router.get('/custom-items', wrap((req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    let list = dataset.custom_items || [];
    if (q) {
      list = list.filter(c =>
        c.key.includes(q) || c.name.toLowerCase().includes(q) || c.name_en.toLowerCase().includes(q)
        || (c.summary || '').toLowerCase().includes(q));
    }
    if (req.query.group) list = list.filter(c => c.group === String(req.query.group));
    res.json({
      items: list,
      groups: dataset.custom_groups || [],
      modes: dataset.custom_modes || null,
      patch: (dataset.meta && dataset.meta.custom_patch) || null,
      source: dataset.custom_source || null,
    });
  }));

  // ── нейтралки ────────────────────────────────────────────────────────
  router.get('/neutrals', wrap((req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    let list = dataset.neutrals;
    if (q) {
      list = list.filter(n =>
        n.key.includes(q) || n.name.toLowerCase().includes(q) || n.name_en.toLowerCase().includes(q));
    }
    if (req.query.tier) list = list.filter(n => n.tier === Number(req.query.tier));
    res.json({ items: list });
  }));

  // ── способности и таланты ────────────────────────────────────────────
  router.get('/abilities', wrap((req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    let list = dataset.abilities;
    if (q) {
      list = list.filter(a => a.key.includes(q) || a.name.toLowerCase().includes(q) || a.name_en.toLowerCase().includes(q));
    }
    if (req.query.hero) list = list.filter(a => a.hero === String(req.query.hero));
    if (req.query.talents === '1') list = list.filter(a => a.is_talent);
    if (req.query.talents === '0') list = list.filter(a => !a.is_talent);
    res.json({ items: list.slice(0, 4000) });
  }));

  // ── точечный поиск по id (для догрузки карточек) ─────────────────────
  router.post('/resolve', wrap((req, res) => {
    const pick = (arr, ids) => ids
      .map(id => arr.find(x => x.id === Number(id)))
      .filter(Boolean);
    const out = {};
    if (Array.isArray(req.body.heroes)) out.heroes = pick(dataset.heroes, req.body.heroes);
    if (Array.isArray(req.body.items)) out.items = pick(dataset.items, req.body.items);
    if (Array.isArray(req.body.neutrals)) out.neutrals = pick(dataset.neutrals, req.body.neutrals);
    if (Array.isArray(req.body.abilities)) out.abilities = pick(dataset.abilities, req.body.abilities);
    res.json(out);
  }));

  return router;
}

module.exports = catalogRoutes;
module.exports.loadDataset = loadDataset;
