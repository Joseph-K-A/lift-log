'use strict';

const APP_VERSION = '2.0';
const DRAFT_KEY = 'liftlog-draft';
const DEFAULT_TITLES = ['Push', 'Pull', 'Legs'];
let workouts = [];          // all saved workouts, newest first
let draft = null;           // the workout being created/edited
let historyFilter = null;   // null = all, '' = untitled, otherwise a lower-cased title
const openSettings = new Set(); // exercise cards whose rep-range editor is expanded

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value' || k === 'hidden') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  }
  return el;
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtDate(iso, long) {
  const dt = parseISO(iso);
  if (long) return dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (iso === todayISO()) return 'Today';
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

const countSets = w => w.exercises.reduce((n, e) => n + e.sets.length, 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmtWeight = w => (w == null ? '—' : String(w));
const round2 = n => Math.round(n * 100) / 100;
const cleanText = s => (s || '').trim().replace(/\s+/g, ' ');
const titleKey = t => cleanText(t).toLowerCase();
const displayTitle = t => cleanText(t) || 'Untitled';

function sortWorkouts() {
  workouts.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// Bottom-sheet dialog. Each button: { label, value, style, run }.
// `run` is called synchronously inside the tap (needed for share / file picker).
function ask({ title, message, buttons }) {
  const dlg = $('#dlg');
  return new Promise(resolve => {
    const done = value => { dlg.onclose = null; if (dlg.open) dlg.close(); resolve(value); };
    dlg.replaceChildren(
      h('div', { class: 'sheet-body' }, title && h('h2', null, title), message && h('p', null, message)),
      h('div', { class: 'sheet-actions' }, buttons.map(b =>
        h('button', { class: 'btn ' + (b.style || ''), onclick: () => { if (b.run) b.run(); done(b.value ?? null); } }, b.label)))
    );
    dlg.onclose = () => { if (!dlg.open) done(null); }; // ignore a late close event from a previous sheet
    dlg.onclick = e => { if (e.target === dlg) done(null); }; // tap on backdrop
    dlg.showModal();
  });
}

// ---------- draft persistence (survives the app being closed mid-workout) ----------
function loadDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; } }
function saveDraft() { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* storage full/blocked */ } }
function clearDraft() { draft = null; openSettings.clear(); try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } }
function touch() { draft.dirty = true; saveDraft(); }

// A draft saved by version 1 has no title, notes or per-exercise settings.
function upgradeDraft(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.exercises)) return null;
  draft = d;
  d.date = typeof d.date === 'string' && d.date ? d.date : todayISO();
  d.title = typeof d.title === 'string' ? d.title : '';
  d.notes = typeof d.notes === 'string' ? d.notes : '';
  d.exercises = d.exercises.map(e => {
    const ex = { ...e, name: typeof e.name === 'string' ? e.name : '', sets: Array.isArray(e.sets) ? e.sets : [] };
    if (ex.repMin === undefined) {
      Object.assign(ex, { setupNote: '', repMin: String(DEFAULT_REP_MIN), repMax: String(DEFAULT_REP_MAX), step: String(DEFAULT_STEP) });
      if (!d.id) carryOver(ex);
    }
    return ex;
  });
  return d;
}

// ---------- history lookups ----------
// Titles to offer: Push, Pull, Legs, then custom titles used before (most recent first).
function titleChoices() {
  const seen = new Set(DEFAULT_TITLES.map(titleKey));
  const out = [...DEFAULT_TITLES];
  for (const w of workouts) {
    const k = titleKey(w.title);
    if (k && !seen.has(k)) { seen.add(k); out.push(cleanText(w.title)); }
  }
  return out;
}

// True if saved workout `w` happened before the one being edited.
function isBefore(w) {
  if (w.id === draft.id) return false;
  if (w.date !== draft.date) return w.date < draft.date;
  return (w.createdAt || 0) < (draft.createdAt || Infinity);
}

// Most recent earlier entry for an exercise name (optionally only ones with sets).
function lastExercise(name, withSets) {
  const key = titleKey(name);
  if (!key) return null;
  for (const w of workouts) {
    if (!isBefore(w)) continue;
    const e = w.exercises.find(x => titleKey(x.name) === key && (!withSets || x.sets.length));
    if (e) return { workout: w, ex: e };
  }
  return null;
}

// Copy the setup note and rep range/step from the last time, unless the user changed them.
function carryOver(ex) {
  const last = lastExercise(ex.name);
  if (ex.autoNote !== false) {
    ex.setupNote = last ? last.ex.setupNote || '' : '';
    ex.autoNote = true;
  }
  if (!ex.cfgEdited) {
    ex.repMin = String(last ? last.ex.repMin : DEFAULT_REP_MIN);
    ex.repMax = String(last ? last.ex.repMax : DEFAULT_REP_MAX);
    ex.step = String(last ? last.ex.step : DEFAULT_STEP);
  }
}

function cfg(ex) {
  let min = parseInt(ex.repMin, 10);
  let max = parseInt(ex.repMax, 10);
  let step = parseFloat(ex.step);
  if (!(min > 0)) min = DEFAULT_REP_MIN;
  if (!(max > 0)) max = DEFAULT_REP_MAX;
  if (min > max) [min, max] = [max, min];
  if (!(step > 0)) step = DEFAULT_STEP;
  return { min, max, step };
}

// Double progression: if every set reached the top of the rep range last time,
// add one weight step and go back to the bottom of the range; otherwise keep
// the weight and add a rep to each set that fell short.
function suggestion(ex) {
  const last = lastExercise(ex.name, true);
  if (!last) return null;
  const { min, max, step } = cfg(ex);
  const sets = last.ex.sets;
  const allTop = sets.every(s => s.reps >= max);
  const target = sets.map(s => {
    if (s.weight == null) return { reps: allTop || s.reps < max ? s.reps + 1 : s.reps, weight: null }; // bodyweight: reps only
    if (allTop) return { reps: min, weight: round2(s.weight + step) };
    return { reps: s.reps < max ? s.reps + 1 : s.reps, weight: s.weight };
  });
  const raised = allTop && sets.some(s => s.weight != null);
  return {
    target,
    text: `Last: ${fmtSets(sets)}. Today: aim for ${fmtSets(target)}${raised ? ` (+${round2(step)})` : ''}`,
  };
}

function fmtSets(sets) {
  const w0 = sets[0].weight;
  if (sets.every(s => s.weight === w0)) {
    const reps = sets.map(s => s.reps).join(', ');
    return w0 == null ? reps : `${w0} × ${reps}`;
  }
  return sets.map(s => (s.weight == null ? String(s.reps) : `${s.weight} × ${s.reps}`)).join(', ');
}

// ---------- routing ----------
// #/ = history, #/w/<id> = details, #/edit = new workout, #/edit/<id> = edit
function go(hash) { location.replace(hash); }

function route() {
  const [name, id] = location.hash.replace(/^#\/?/, '').split('/');
  document.body.classList.remove('typing');
  if (name === 'w' && id) return showDetail(id);
  if (name === 'edit') return showEditor(id || null);
  showHistory();
}

function show(viewId) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== viewId;
  window.scrollTo(0, 0);
}

// ---------- screen 1: history ----------
function showHistory() {
  show('view-history');
  const btn = $('#btn-start');
  btn.textContent = draft && draft.dirty ? (draft.id ? 'Continue editing' : 'Continue workout') : 'Start workout';

  const list = $('#history-list');
  list.replaceChildren();
  if (!workouts.length) {
    list.append(h('div', { class: 'empty' },
      h('p', { class: 'empty-title' }, 'No workouts yet'),
      h('p', null, 'Tap “Start workout” to log your first one.')));
    return;
  }

  // Filter chips for the titles that appear in history.
  const titles = [];
  const seen = new Set();
  let hasUntitled = false;
  for (const w of workouts) {
    const k = titleKey(w.title);
    if (!k) hasUntitled = true;
    else if (!seen.has(k)) { seen.add(k); titles.push({ key: k, label: cleanText(w.title) }); }
  }
  const order = k => { const i = DEFAULT_TITLES.findIndex(t => titleKey(t) === k); return i === -1 ? 99 : i; };
  titles.sort((a, b) => order(a.key) - order(b.key));
  if (hasUntitled) titles.push({ key: '', label: 'Untitled' });
  if (historyFilter !== null && !titles.some(t => t.key === historyFilter)) historyFilter = null;

  if (titles.length > 1 || (titles.length === 1 && titles[0].key)) {
    const chip = (label, key) => h('button', {
      class: 'chip' + (historyFilter === key ? ' active' : ''), type: 'button', 'aria-pressed': String(historyFilter === key),
      onclick: () => { historyFilter = key; showHistory(); },
    }, label);
    list.append(h('div', { class: 'chip-row filters', role: 'group', 'aria-label': 'Filter by title' },
      chip('All', null), titles.map(t => chip(t.label, t.key))));
  }

  const shown = historyFilter === null ? workouts : workouts.filter(w => titleKey(w.title) === historyFilter);
  let lastMonth = '';
  for (const w of shown) {
    const month = parseISO(w.date).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if (month !== lastMonth) { list.append(h('h2', { class: 'month' }, month)); lastMonth = month; }
    list.append(h('button', { class: 'card', onclick: () => go('#/w/' + w.id) },
      h('div', { class: 'card-main' },
        h('div', { class: 'card-title' + (titleKey(w.title) ? '' : ' untitled') }, displayTitle(w.title)),
        h('div', { class: 'card-sub' }, `${fmtDate(w.date)} · ${w.exercises.map(e => e.name).join(', ') || 'No exercises'}`)),
      h('div', { class: 'card-meta' }, plural(countSets(w), 'set')),
      chevron()));
  }
}

function chevron() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '18'); s.setAttribute('height', '18');
  s.setAttribute('class', 'chev'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>';
  return s;
}

// ---------- screen 2: details ----------
function showDetail(id) {
  const w = workouts.find(x => x.id === id);
  if (!w) return go('#/');
  show('view-detail');

  $('#detail-body').replaceChildren(
    h('h1', { class: 'detail-date' + (titleKey(w.title) ? '' : ' untitled') }, displayTitle(w.title)),
    h('p', { class: 'detail-sum' }, `${fmtDate(w.date, true)} · ${plural(w.exercises.length, 'exercise')} · ${plural(countSets(w), 'set')}`),
    ...w.exercises.map(ex => h('div', { class: 'ex' },
      h('h3', null, ex.name),
      ex.setupNote && h('p', { class: 'setup-note' }, h('span', { class: 'setup-label' }, 'Setup: '), ex.setupNote),
      ex.sets.length
        ? h('table', { class: 'sets' },
            h('thead', null, h('tr', null, h('th', null, 'Set'), h('th', null, 'Reps'), h('th', null, 'Weight'))),
            h('tbody', null, ex.sets.map((s, i) =>
              h('tr', null, h('td', null, i + 1), h('td', null, s.reps), h('td', null, fmtWeight(s.weight))))))
        : h('p', { class: 'card-sub' }, 'No sets'))),
    w.notes && h('div', { class: 'ex' }, h('h3', null, 'Notes'), h('p', { class: 'notes-text' }, w.notes))
  );

  $('#btn-edit').onclick = () => go('#/edit/' + id);
  $('#btn-delete').onclick = async () => {
    const choice = await ask({
      title: 'Delete this workout?',
      message: `${displayTitle(w.title)} on ${fmtDate(w.date, true)} will be permanently removed. This can’t be undone.`,
      buttons: [
        { label: 'Delete workout', value: 'delete', style: 'danger-solid' },
        { label: 'Cancel' },
      ],
    });
    if (choice !== 'delete') return;
    await DB.del(id);
    workouts = workouts.filter(x => x.id !== id);
    if (draft && draft.id === id) clearDraft();
    go('#/');
    toast('Workout deleted');
  };
}

// ---------- screen 3: editor ----------
const newSet = prev => ({ reps: prev ? prev.reps : '', weight: prev ? prev.weight : '' });
const newExercise = () => ({
  name: '', sets: [newSet()], setupNote: '',
  repMin: String(DEFAULT_REP_MIN), repMax: String(DEFAULT_REP_MAX), step: String(DEFAULT_STEP),
});
const draftHasData = () => draft.exercises.some(e => e.name.trim() || e.sets.some(s => s.reps || s.weight));

function showEditor(id) {
  if (!(draft && draft.id === id)) {
    openSettings.clear();
    if (id) {
      const w = workouts.find(x => x.id === id);
      if (!w) return go('#/');
      draft = {
        id, date: w.date, createdAt: w.createdAt, dirty: false,
        title: w.title, notes: w.notes,
        exercises: w.exercises.map(e => ({
          name: e.name,
          sets: e.sets.map(s => ({ reps: String(s.reps), weight: s.weight == null ? '' : String(s.weight) })),
          setupNote: e.setupNote, autoNote: false,
          repMin: String(e.repMin), repMax: String(e.repMax), step: String(e.step), cfgEdited: true,
        })),
      };
    } else {
      draft = { id: null, date: todayISO(), title: '', notes: '', dirty: false, exercises: [newExercise()] };
    }
  }
  show('view-edit');
  $('#edit-title').textContent = draft.id ? 'Edit workout' : 'New workout';
  $('#edit-date').value = draft.date;
  $('#w-title').value = draft.title;
  $('#w-notes').value = draft.notes;
  renderTitleChips();
  renderExercises();
}

function renderTitleChips() {
  const key = titleKey(draft.title);
  $('#title-chips').replaceChildren(...titleChoices().map(t => h('button', {
    class: 'chip' + (titleKey(t) === key ? ' active' : ''), type: 'button', 'aria-pressed': String(titleKey(t) === key),
    onmousedown: e => e.preventDefault(),
    onclick: () => {
      draft.title = titleKey(t) === key ? '' : t; // tap again to clear
      $('#w-title').value = draft.title;
      touch();
      renderTitleChips();
      renderPrefill();
    },
  }, t)));
}

// Offer to start from the most recent workout with the same title.
function renderPrefill() {
  const box = $('#prefill');
  box.replaceChildren();
  box.hidden = true;
  const key = titleKey(draft.title);
  if (draft.id || !key || draftHasData()) return;
  const prev = workouts.find(w => titleKey(w.title) === key && w.exercises.length);
  if (!prev) return;
  box.append(
    h('div', { class: 'prefill-text' },
      h('div', { class: 'prefill-head' }, `Last ${displayTitle(prev.title)} · ${fmtDate(prev.date)}`),
      h('div', { class: 'card-sub' }, prev.exercises.map(e => e.name).join(', '))),
    h('button', { class: 'btn primary', type: 'button', onclick: () => prefillFrom(prev) }, 'Use these exercises'));
  box.hidden = false;
}

function prefillFrom(prev) {
  draft.exercises = prev.exercises.map(e => {
    const ex = { name: e.name, sets: (e.sets.length ? e.sets : [null]).map(() => newSet()) };
    carryOver(ex);
    return ex;
  });
  touch();
  renderExercises();
  toast(`${plural(draft.exercises.length, 'exercise')} added`);
}

// Exercise names used before, most-used first.
function pastNames() {
  const counts = new Map();
  for (const w of workouts) for (const e of w.exercises) {
    const key = e.name.toLowerCase();
    const cur = counts.get(key);
    counts.set(key, { name: cur ? cur.name : e.name, n: (cur ? cur.n : 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).map(x => x.name);
}

function renderExercises(focusSel) {
  const names = pastNames();
  $('#ex-list').replaceChildren(...draft.exercises.map((ex, ei) => exerciseCard(ex, ei, names)));
  renderPrefill();
  if (focusSel) {
    const el = $(focusSel);
    if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
  }
}

function exerciseCard(ex, ei, names) {
  const suggest = h('div', { class: 'chip-row', hidden: true });
  const hint = h('button', { class: 'hint', type: 'button', hidden: true });
  const cfgLabel = h('span');
  const setupInput = h('input', {
    class: 'input setup', type: 'text', value: ex.setupNote || '',
    placeholder: 'Setup note (e.g. bench 30°, seat 4)', autocomplete: 'off', enterkeyhint: 'done',
    maxlength: '200', 'aria-label': 'Setup note',
    oninput: e => { ex.setupNote = e.target.value; ex.autoNote = false; touch(); },
  });

  // Update the parts of this card that depend on the exercise's history.
  const refresh = () => {
    const s = suggestion(ex);
    hint.hidden = !s;
    if (s) {
      hint.textContent = s.text;
      hint.onclick = async () => {
        if (ex.sets.some(x => x.reps || x.weight)) {
          const c = await ask({
            title: 'Replace your sets?',
            message: 'The sets you’ve entered for this exercise will be replaced with today’s target.',
            buttons: [{ label: 'Replace', value: 'yes', style: 'primary' }, { label: 'Cancel' }],
          });
          if (c !== 'yes') return;
        }
        ex.sets = s.target.map(t => ({ reps: String(t.reps), weight: t.weight == null ? '' : String(t.weight) }));
        touch();
        renderExercises();
      };
    }
    if (setupInput.value !== (ex.setupNote || '')) setupInput.value = ex.setupNote || '';
    const c = cfg(ex);
    cfgLabel.textContent = `Reps ${c.min}–${c.max} · weight step ${round2(c.step)}`;
  };

  const updateSuggest = input => {
    const q = input.value.trim().toLowerCase();
    const used = new Set(draft.exercises.filter(e => e !== ex).map(e => e.name.trim().toLowerCase()));
    const matches = names
      .filter(n => { const l = n.toLowerCase(); return l !== q && !used.has(l) && l.includes(q); })
      .sort((a, b) => b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q))
      .slice(0, 8);
    suggest.replaceChildren(...matches.map(n => h('button', {
      class: 'chip', type: 'button',
      onmousedown: e => e.preventDefault(), // keep focus in the input
      onclick: () => {
        ex.name = n;
        carryOver(ex);
        touch();
        renderExercises(`[data-reps="${ei}-0"]`);
      },
    }, n)));
    suggest.hidden = matches.length === 0;
  };

  const nameInput = h('input', {
    class: 'input', type: 'text', placeholder: 'Exercise name', value: ex.name,
    autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', enterkeyhint: 'next',
    'data-name': ei, 'aria-label': `Exercise ${ei + 1} name`,
    oninput: e => { ex.name = e.target.value; carryOver(ex); touch(); updateSuggest(e.target); refresh(); },
    onfocus: e => updateSuggest(e.target),
    onblur: () => setTimeout(() => { suggest.hidden = true; }, 200),
  });

  const removeExercise = async () => {
    const hasData = ex.name.trim() || ex.sets.some(s => s.reps || s.weight);
    if (hasData) {
      const c = await ask({
        title: `Remove ${ex.name.trim() || 'this exercise'}?`,
        buttons: [{ label: 'Remove', value: 'yes', style: 'danger-solid' }, { label: 'Cancel' }],
      });
      if (c !== 'yes') return;
    }
    draft.exercises.splice(ei, 1);
    openSettings.clear();
    touch();
    renderExercises();
  };

  const rows = ex.sets.map((s, si) => h('div', { class: 'set-row' },
    h('span', { class: 'set-num' }, si + 1),
    h('input', {
      class: 'input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', placeholder: 'Reps',
      value: s.reps, 'data-reps': `${ei}-${si}`, 'aria-label': `Set ${si + 1} reps`, enterkeyhint: 'next',
      oninput: e => {
        const v = e.target.value.replace(/\D/g, '').slice(0, 4);
        if (v !== e.target.value) e.target.value = v;
        s.reps = v; touch();
      },
    }),
    h('input', {
      class: 'input', type: 'text', inputmode: 'decimal', placeholder: 'Weight',
      value: s.weight, 'aria-label': `Set ${si + 1} weight`, enterkeyhint: 'done',
      oninput: e => {
        const v = cleanDecimal(e.target.value);
        if (v !== e.target.value) e.target.value = v;
        s.weight = v; touch();
      },
    }),
    h('button', {
      class: 'icon-btn remove', type: 'button', 'aria-label': `Remove set ${si + 1}`,
      onclick: () => { ex.sets.splice(si, 1); touch(); renderExercises(); },
    }, '×')
  ));

  // Rep range and weight step for this exercise (remembered for next time).
  const settingInput = (field, label, decimal) => h('label', { class: 'cfg-field' },
    h('span', null, label),
    h('input', {
      class: 'input', type: 'text', inputmode: decimal ? 'decimal' : 'numeric', pattern: decimal ? null : '[0-9]*',
      value: ex[field],
      oninput: e => {
        const v = decimal ? cleanDecimal(e.target.value) : e.target.value.replace(/\D/g, '').slice(0, 3);
        if (v !== e.target.value) e.target.value = v;
        ex[field] = v; ex.cfgEdited = true; touch(); refresh();
      },
    }));
  const cfgOpen = openSettings.has(ei);
  const cfgBox = h('div', { class: 'cfg-box', hidden: !cfgOpen },
    settingInput('repMin', 'Min reps'), settingInput('repMax', 'Max reps'), settingInput('step', 'Weight step', true));
  const cfgToggle = h('button', {
    class: 'cfg-toggle', type: 'button', 'aria-expanded': String(cfgOpen),
    onclick: () => {
      const open = cfgBox.hidden;
      cfgBox.hidden = !open;
      cfgToggle.setAttribute('aria-expanded', String(open));
      if (open) openSettings.add(ei); else openSettings.delete(ei);
    },
  }, cfgLabel, h('span', { class: 'cfg-edit' }, 'Edit'));

  refresh();
  return h('div', { class: 'ex-edit' },
    h('div', { class: 'ex-head' }, nameInput,
      h('button', { class: 'icon-btn remove', type: 'button', 'aria-label': 'Remove exercise', onclick: removeExercise }, '×')),
    suggest,
    hint,
    setupInput,
    ex.sets.length > 0 && h('div', { class: 'set-head' }, h('span', null, 'Set'), h('span', null, 'Reps'), h('span', null, 'Weight'), h('span')),
    rows,
    h('button', {
      class: 'btn add-set', type: 'button',
      onclick: () => {
        ex.sets.push(newSet(ex.sets[ex.sets.length - 1]));
        touch();
        renderExercises(`[data-reps="${ei}-${ex.sets.length - 1}"]`);
      },
    }, '+ Add set'),
    cfgToggle,
    cfgBox
  );
}

// Digits and at most one decimal point; accepts a comma from European keypads.
function cleanDecimal(value) {
  let v = value.replace(',', '.').replace(/[^\d.]/g, '');
  const dot = v.indexOf('.');
  if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '');
  return v.slice(0, 7);
}

async function saveWorkout() {
  if (!draft) return; // already saved by an earlier tap
  const exercises = draft.exercises
    .map(e => {
      const c = cfg(e);
      return {
        name: cleanText(e.name),
        sets: e.sets.filter(s => s.reps !== '').map(s => {
          const wt = parseFloat(s.weight);
          return { reps: parseInt(s.reps, 10), weight: Number.isFinite(wt) ? wt : null };
        }),
        setupNote: cleanText(e.setupNote).slice(0, 200),
        repMin: c.min,
        repMax: c.max,
        step: c.step,
      };
    })
    .filter(e => e.name || e.sets.length);

  const unnamed = exercises.findIndex(e => !e.name);
  if (unnamed !== -1) {
    await ask({ title: 'Name every exercise', message: 'One of your exercises has sets but no name.', buttons: [{ label: 'OK', style: 'primary' }] });
    return;
  }
  if (!exercises.length) {
    await ask({ title: 'Nothing to save yet', message: 'Add at least one exercise with a name.', buttons: [{ label: 'OK', style: 'primary' }] });
    return;
  }

  const now = Date.now();
  const w = {
    id: draft.id || uid(),
    date: draft.date || todayISO(),
    title: cleanText(draft.title).slice(0, 40),
    notes: (draft.notes || '').trim().slice(0, 5000),
    exercises,
    createdAt: draft.createdAt || now,
    updatedAt: now,
  };
  draft.id = w.id; // a quick second tap updates the same workout instead of adding a copy
  draft.createdAt = w.createdAt;
  await DB.put(w);
  workouts = workouts.filter(x => x.id !== w.id);
  workouts.push(w);
  sortWorkouts();
  clearDraft();
  go('#/w/' + w.id);
  toast('Workout saved');
}

async function cancelEdit() {
  if (draft && draft.dirty) {
    const c = await ask({
      title: 'Discard changes?',
      message: draft.id ? 'Your edits to this workout won’t be saved.' : 'This workout won’t be saved.',
      buttons: [{ label: 'Discard', value: 'discard', style: 'danger-solid' }, { label: 'Keep editing' }],
    });
    if (c !== 'discard' || $('#view-edit').hidden) return;
  }
  const id = draft && draft.id;
  clearDraft();
  go(id ? '#/w/' + id : '#/');
}

// ---------- backup: export / import ----------
function exportData() {
  const data = { app: 'lift-log', version: 2, exportedAt: new Date().toISOString(), workouts };
  const json = JSON.stringify(data, null, 2);
  const name = `lift-log-backup-${todayISO()}.json`;

  const download = () => {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  // On iPhone the share sheet is the reliable way to "Save to Files".
  let file;
  try { file = new File([json], name, { type: 'application/json' }); } catch { /* old browser */ }
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: 'Lift Log backup' })
      .catch(err => { if (err.name !== 'AbortError') download(); });
  } else {
    download();
  }
}

// Accepts backups from version 1 (no titles/notes/settings) and version 2.
function normalizeWorkout(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return null;
  if (!Array.isArray(raw.exercises)) return null;
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const posInt = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : undefined; };
  const exercises = raw.exercises
    .filter(e => e && typeof e.name === 'string' && e.name.trim())
    .map(e => ({
      name: e.name.trim().slice(0, 100),
      sets: (Array.isArray(e.sets) ? e.sets : [])
        .map(s => ({ reps: parseInt(s && s.reps, 10), weight: s && s.weight != null && s.weight !== '' ? Number(s.weight) : null }))
        .filter(s => Number.isFinite(s.reps) && s.reps >= 0)
        .map(s => ({ reps: s.reps, weight: Number.isFinite(s.weight) ? s.weight : null })),
      setupNote: cleanText(text(e.setupNote, 200)),
      repMin: posInt(e.repMin),
      repMax: posInt(e.repMax),
      step: Number(e.step) > 0 ? Number(e.step) : undefined,
    }));
  return withDefaults({
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    date: raw.date,
    title: cleanText(text(raw.title, 40)),
    notes: text(raw.notes, 5000).trim(),
    exercises,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  });
}

async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data && data.workouts;
    if (!Array.isArray(list)) throw new Error('not a backup');
    const clean = list.map(normalizeWorkout).filter(Boolean);
    if (!clean.length) throw new Error('empty');

    const existing = new Set(workouts.map(w => w.id));
    const added = clean.filter(w => !existing.has(w.id)).length;
    await DB.putMany(clean);
    workouts = await DB.all();
    sortWorkouts();
    route();
    await ask({
      title: 'Import complete',
      message: `${plural(clean.length, 'workout')} restored (${added} new, ${clean.length - added} updated). Nothing was deleted.`,
      buttons: [{ label: 'OK', style: 'primary' }],
    });
  } catch {
    await ask({
      title: 'Couldn’t import that file',
      message: 'Choose a backup file that was made with Export in this app.',
      buttons: [{ label: 'OK', style: 'primary' }],
    });
  }
}

function openMenu() {
  ask({
    title: 'Backup',
    message: `${plural(workouts.length, 'workout')} stored on this device only. Export a backup file to keep a copy, e.g. in iCloud Drive. (Lift Log ${APP_VERSION})`,
    buttons: [
      { label: 'Export backup', style: 'primary', run: exportData },
      { label: 'Import backup', run: () => $('#import-file').click() },
      { label: 'Close' },
    ],
  });
}

// ---------- start ----------
async function init() {
  const saved = loadDraft();
  try {
    workouts = await DB.all();
  } catch (err) {
    workouts = [];
    console.error(err);
    toast('Storage unavailable — data won’t be saved');
  }
  sortWorkouts();
  draft = null;
  upgradeDraft(saved);

  $('#btn-start').onclick = () => go(draft && draft.dirty && draft.id ? '#/edit/' + draft.id : '#/edit');
  $('#btn-back').onclick = () => go('#/');
  $('#btn-menu').onclick = openMenu;
  $('#btn-cancel').onclick = cancelEdit;
  $('#btn-save').onclick = saveWorkout;
  $('#btn-add-ex').onclick = () => {
    draft.exercises.push(newExercise());
    touch();
    renderExercises(`[data-name="${draft.exercises.length - 1}"]`);
  };
  const dateInput = $('#edit-date');
  dateInput.oninput = () => {
    if (dateInput.value && dateInput.value !== draft.date) { draft.date = dateInput.value; touch(); renderExercises(); }
  };
  dateInput.onchange = () => { if (!dateInput.value) dateInput.value = draft.date; else dateInput.oninput(); };
  $('#w-title').oninput = e => { draft.title = e.target.value; touch(); renderTitleChips(); renderPrefill(); };
  $('#w-notes').oninput = e => { draft.notes = e.target.value; touch(); };
  $('#import-file').onchange = e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFile(f);
  };

  // Hide the bottom bar while typing so it doesn't sit on top of the keyboard.
  document.addEventListener('focusin', e => {
    if (e.target.matches('input, textarea')) document.body.classList.add('typing');
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => { if (!document.activeElement || !document.activeElement.matches('input, textarea')) document.body.classList.remove('typing'); }, 50);
  });

  window.addEventListener('hashchange', route);
  route();

  if ('serviceWorker' in navigator) {
    // When a new version takes over, reload to use it, unless a workout is being edited
    // (then it applies on the next launch).
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && $('#view-edit').hidden) location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(console.error);
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

init();
