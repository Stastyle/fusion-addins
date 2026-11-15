#!/usr/bin/env node
// Builds the add-in catalog (dist/) from every GitHub repository that carries the
// catalog topic (default: "fusion-addin"). No dependencies: Node 20+ only.
//
// Environment:
//   GITHUB_TOKEN      token for the GitHub API (Actions passes one automatically)
//   OWNER             GitHub user whose repositories are listed (default: site.config.json)
//   TOPIC             repository topic that puts a repo on the page (default: site.config.json)
//   INCLUDE_PRIVATE   "1" to also list private repos (needs a personal token with repo read access)
//   SCAN_UNTAGGED     "1" to report repos that contain a Fusion manifest but lack the topic
//   REPOS             comma-separated repo names: build only these, ignore the topic (local testing)
//   OUT               output folder (default: dist)

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(ROOT, 'site.config.json'), 'utf8'));
// Per-repo tweaks kept in this repo, so the add-in repos don't need any extra file.
const overrides = JSON.parse(await readFile(path.join(ROOT, 'overrides.json'), 'utf8').catch(() => '{}'));

const OWNER = process.env.OWNER || config.owner;
const TOPIC = process.env.TOPIC || config.topic;
const TOKEN = process.env.GITHUB_TOKEN || '';
const INCLUDE_PRIVATE = process.env.INCLUDE_PRIVATE === '1';
const SCAN_UNTAGGED = process.env.SCAN_UNTAGGED === '1';
const ONLY = (process.env.REPOS || '').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = path.resolve(ROOT, process.env.OUT || 'dist');

// ---------------------------------------------------------------- GitHub access

const API = 'https://api.github.com';
const headers = (accept = 'application/vnd.github+json') => ({
  Accept: accept,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'fusion-addin-catalog',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
});

async function api(p) {
  const res = await fetch(API + p, { headers: headers() });
  if (res.status === 404 || res.status === 409) return null; // missing, or empty repo
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function apiAll(p) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = p.includes('?') ? '&' : '?';
    const batch = await api(`${p}${sep}per_page=100&page=${page}`);
    if (!batch?.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

// File contents through the API, so private repositories work too.
async function fileBytes(repo, ref, file) {
  const res = await fetch(
    `${API}/repos/${OWNER}/${repo}/contents/${encPath(file)}?ref=${encodeURIComponent(ref)}`,
    { headers: headers('application/vnd.github.raw+json') },
  );
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function fileText(repo, ref, file) {
  const buf = await fileBytes(repo, ref, file);
  return buf ? buf.toString('utf8').replace(/^﻿/, '') : null;
}

// ---------------------------------------------------------------- repository analysis

const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp)$/i;

function findManifest(paths) {
  return paths
    .filter((p) => p.toLowerCase().endsWith('.manifest') && !/(^|\/)app\.manifest$/i.test(p))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

async function readManifest(repo, ref, candidates) {
  for (const file of candidates) {
    const text = await fileText(repo, ref, file);
    if (!text) continue;
    try {
      const m = JSON.parse(text);
      if (/fusion/i.test(m.autodeskProduct || '') && ['addin', 'script'].includes(m.type)) return { file, data: m };
    } catch {
      /* not JSON: not a Fusion manifest */
    }
  }
  return null;
}

function cleanTitle(t) {
  return t
    .replace(/[*_`]/g, '')
    .replace(/\s*[—–-]\s*(autodesk\s+)?fusion(\s*360)?(\s+add-?in)?\s*$/i, '')
    .replace(/\s+for\s+(autodesk\s+)?fusion(\s*360)?\s*$/i, '')
    .trim();
}

function readmeInfo(md) {
  const h1 = md.match(/^#\s+(.+)$/m);
  const images = [];
  const re = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<img[^>]*?\ssrc=["']([^"']+)["']/gi;
  for (let m; (m = re.exec(md)); ) images.push(m[1] || m[2]);
  const shot = images.find((src) => !/icon|badge|shields\.io|logo|avatar/i.test(src));
  return { title: h1 ? cleanTitle(h1[1]) : null, screenshot: shot || null };
}

function pickIcon(paths, manifestDir) {
  const root = paths.find((p) => /^(docs\/|assets\/|\.github\/)?icon\.(png|svg|jpe?g)$/i.test(p));
  if (root) return root;
  const res = paths.filter(
    (p) => p.startsWith(manifestDir ? `${manifestDir}/resources/` : 'resources/') &&
      /\.png$/i.test(p) && !/disabled/i.test(p),
  );
  for (const name of ['64x64.png', '32x32@2x.png', '32x32.png']) {
    const hit = res.find((p) => p.endsWith(`/${name}`));
    if (hit) return hit;
  }
  return res[0] || null;
}

function prettyName(s) {
  return s.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function saveAsset(repoName, ref, file) {
  const bytes = await fileBytes(repoName, ref, file);
  if (!bytes) return null;
  const rel = `assets/${repoName}/${file.split('/').map((s) => s.replace(/[^\w.@-]/g, '_')).join('__')}`;
  await mkdir(path.dirname(path.join(OUT, rel)), { recursive: true });
  await writeFile(path.join(OUT, rel), bytes);
  return rel;
}

async function resolveImage(repo, ref, src, paths) {
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) {
    const m = src.match(/^https:\/\/(?:github\.com\/[^/]+\/[^/]+\/(?:raw|blob)\/[^/]+|raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+)\/(.+)$/);
    if (m && paths.includes(decodeURIComponent(m[1]))) return saveAsset(repo.name, ref, decodeURIComponent(m[1]));
    return src; // an external image: link to it directly
  }
  const file = path.posix.normalize(src.replace(/^\.?\//, '').split(/[?#]/)[0]);
  return paths.includes(file) ? saveAsset(repo.name, ref, file) : null;
}

async function describe(repo) {
  const ref = repo.default_branch;
  const tree = await api(`/repos/${OWNER}/${repo.name}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (!tree) return null;
  const paths = tree.tree.filter((n) => n.type === 'blob').map((n) => n.path);

  const manifest = await readManifest(repo.name, ref, findManifest(paths));
  const manifestDir = manifest ? path.posix.dirname(manifest.file) : '';
  const folder = manifest ? (manifestDir === '.' ? repo.name : path.posix.basename(manifestDir)) : null;

  const overrideFile = paths.find((p) => p.toLowerCase() === 'fusion-addin.json');
  let override = {};
  if (overrideFile) {
    try {
      override = JSON.parse(await fileText(repo.name, ref, overrideFile));
    } catch (e) {
      console.warn(`! ${repo.name}: fusion-addin.json is not valid JSON (${e.message})`);
    }
  }
  override = { ...override, ...(overrides[repo.name] || {}) };
  if (override.hidden) return null;

  const readmeFile = paths.find((p) => /^readme(\.md|\.markdown)?$/i.test(p));
  const readme = readmeFile ? readmeInfo(await fileText(repo.name, ref, readmeFile)) : {};

  const full = await api(`/repos/${OWNER}/${repo.name}`);
  const release = await api(`/repos/${OWNER}/${repo.name}/releases/latest`);
  const zipAsset = release?.assets?.find((a) => /\.zip$/i.test(a.name));

  const iconPath = override.icon || pickIcon(paths, manifestDir === '.' ? '' : manifestDir);
  const icon = iconPath ? await resolveImage(repo, ref, iconPath, paths) : null;
  const screenshot = await resolveImage(repo, ref, override.screenshot || readme.screenshot, paths);

  const desc = manifest?.data?.description;
  const manifestDesc = typeof desc === 'string' ? desc : desc?.[''] || (desc && Object.values(desc)[0]);

  const os = String(manifest?.data?.supportedOS || '')
    .split('|')
    .map((s) => ({ windows: 'Windows', mac: 'macOS' })[s.trim().toLowerCase()])
    .filter(Boolean);

  return {
    repo: repo.name,
    url: repo.html_url,
    name: override.name || readme.title || (folder && prettyName(folder)) || prettyName(repo.name),
    description: override.description || manifestDesc || repo.description || '',
    version: override.version || release?.tag_name || manifest?.data?.version || null,
    released: Boolean(release),
    releasedAt: release?.published_at || null,
    download: zipAsset?.browser_download_url ||
      (release
        ? `${repo.html_url}/archive/refs/tags/${encodeURIComponent(release.tag_name)}.zip`
        : `${repo.html_url}/archive/refs/heads/${encodeURIComponent(ref)}.zip`),
    folder,
    type: manifest?.data?.type || 'addin',
    os,
    icon,
    screenshot,
    license: repo.license && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : null,
    forkOf: full?.parent ? { name: full.parent.full_name, url: full.parent.html_url } : null,
    stars: repo.stargazers_count,
    updated: repo.pushed_at,
    private: repo.private,
    order: Number.isFinite(override.order) ? override.order : null,
  };
}

// ---------------------------------------------------------------- page

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const GITHUB_SVG =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';
const DOWNLOAD_SVG =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .14.11.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.69V1.75a.75.75 0 0 1 1.5 0v5.94l1.97-1.97a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 6.78a.75.75 0 1 1 1.06-1.06Z"/></svg>';

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function card(a) {
  const meta = [
    a.version && `<span class="chip">v${esc(String(a.version).replace(/^v/i, ''))}</span>`,
    a.releasedAt
      ? `<span>Released ${esc(fmtDate(a.releasedAt))}</span>`
      : `<span>Updated ${esc(fmtDate(a.updated))}</span>`,
    a.os.length && `<span>${esc(a.os.join(' · '))}</span>`,
    a.license && `<span>${esc(a.license)}</span>`,
    a.stars > 0 && `<span>★ ${a.stars}</span>`,
  ].filter(Boolean).join('');

  const iconHtml = a.icon
    ? `<img class="icon" src="${esc(a.icon)}" alt="" width="44" height="44" loading="lazy">`
    : `<span class="icon icon--text" aria-hidden="true">${esc(initials(a.name))}</span>`;

  const media = a.screenshot
    ? `<div class="media"><img src="${esc(a.screenshot)}" alt="${esc(a.name)} screenshot" loading="lazy"></div>`
    : `<div class="media media--empty" aria-hidden="true">${a.icon ? `<img src="${esc(a.icon)}" alt="">` : `<span>${esc(initials(a.name))}</span>`}</div>`;

  const folder = a.folder ? `<code>${esc(a.folder)}</code>` : 'the add-in';
  const kind = a.type === 'script' ? 'Scripts' : 'Add-Ins';

  return `
      <article class="card" data-search="${esc(`${a.name} ${a.description} ${a.repo}`.toLowerCase())}">
        ${media}
        <div class="body">
          <header class="head">
            ${iconHtml}
            <div>
              <h2><a href="${esc(a.url)}">${esc(a.name)}</a></h2>
              <p class="repo">${esc(a.repo)}${a.forkOf ? ` · fork of <a href="${esc(a.forkOf.url)}">${esc(a.forkOf.name)}</a>` : ''}</p>
            </div>
          </header>
          <p class="desc">${esc(a.description)}</p>
          <p class="meta">${meta}</p>
          <div class="actions">
            <a class="btn btn--primary" href="${esc(a.download)}">${DOWNLOAD_SVG}Download</a>
            <a class="btn" href="${esc(a.url)}">${GITHUB_SVG}Source</a>
          </div>
          <details class="install">
            <summary>How to install</summary>
            <ol>
              <li>Download and unzip.</li>
              <li>In Fusion press <kbd>Shift</kbd>+<kbd>S</kbd> and open the <b>${kind}</b> tab.</li>
              <li>Click the green <b>+</b> and pick the ${folder} folder.</li>
              <li>Select it, click <b>Run</b>${a.type === 'script' ? '' : ', and tick <b>Run on Startup</b>'}.</li>
            </ol>
          </details>
        </div>
      </article>`;
}

function page(addins, builtAt) {
  const cards = addins.map(card).join('\n');
  const favicon =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#15181e"/><path d="M8 23V9h12M8 16h9" stroke="#f2a33a" stroke-width="3.2" fill="none" stroke-linecap="round"/><circle cx="23" cy="22" r="3" fill="#f2a33a"/></svg>',
    );
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(config.title)}</title>
<meta name="description" content="${esc(config.intro)}">
<meta property="og:title" content="${esc(config.title)}">
<meta property="og:description" content="${esc(config.intro)}">
<link rel="icon" href="${favicon}">
<style>
  :root {
    --bg: #0f1115; --panel: #161a21; --panel-2: #1c212a; --line: #262c37; --grid: rgba(255,255,255,.035);
    --text: #e8ebf0; --muted: #98a1b0; --faint: #6b7483; --accent: #f2a33a; --accent-ink: #1a1206; --tile: #eef0f3;
    --radius: 14px; --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f5f1; --panel: #ffffff; --panel-2: #f0eee8; --line: #e1ded6; --grid: rgba(20,30,50,.05);
      --text: #1b1f27; --muted: #5b6372; --faint: #8a909b; --accent: #d9861a; --accent-ink: #ffffff; --tile: #ffffff;
      color-scheme: light;
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
    background-size: 28px 28px; background-attachment: fixed;
  }
  a { color: inherit; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 0 20px; }
  .top { padding: 64px 0 28px; }
  .eyebrow { font: 600 12px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--accent); margin: 0 0 18px; }
  h1 { font-size: clamp(30px, 5vw, 48px); line-height: 1.08; letter-spacing: -.02em; margin: 0 0 14px; max-width: 18ch; }
  .intro { color: var(--muted); max-width: 62ch; margin: 0; font-size: 17px; }
  .bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; margin: 34px 0 22px; padding-top: 18px; border-top: 1px solid var(--line); }
  .count { font: 13px var(--mono); color: var(--faint); }
  .search { position: relative; flex: 0 1 300px; }
  .search input {
    width: 100%; padding: 10px 14px 10px 36px; border-radius: 10px; border: 1px solid var(--line);
    background: var(--panel); color: var(--text); font: inherit; font-size: 15px;
  }
  .search input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
  .search svg { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--faint); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; padding-bottom: 40px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; display: flex; flex-direction: column; transition: border-color .15s, transform .15s; }
  .card[hidden] { display: none; }
  .card:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
  .media { aspect-ratio: 16 / 10; background: var(--panel-2); border-bottom: 1px solid var(--line); overflow: hidden; }
  .media img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .media--empty { display: grid; place-items: center; background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 14px 14px; }
  .media--empty img { width: 92px; height: 92px; object-fit: contain; padding: 16px; border-radius: 22px; background: var(--tile); box-shadow: 0 8px 30px rgba(0,0,0,.25); }
  .media--empty span { font: 700 40px var(--mono); color: var(--faint); }
  .body { padding: 18px 20px 20px; display: flex; flex-direction: column; gap: 12px; flex: 1; }
  .head { display: flex; gap: 12px; align-items: center; }
  .icon { width: 44px; height: 44px; border-radius: 10px; flex: none; object-fit: contain; background: var(--tile); border: 1px solid var(--line); padding: 6px; }
  .icon--text { background: var(--panel-2); }
  .icon--text { display: grid; place-items: center; font: 700 15px var(--mono); color: var(--accent); }
  h2 { font-size: 19px; line-height: 1.25; margin: 0; letter-spacing: -.01em; }
  h2 a { text-decoration: none; }
  h2 a:hover { text-decoration: underline; text-underline-offset: 3px; }
  .repo { margin: 2px 0 0; font: 12.5px var(--mono); color: var(--faint); }
  .repo a { color: var(--muted); }
  .desc { margin: 0; color: var(--muted); font-size: 15px; }
  .meta { margin: auto 0 0; display: flex; flex-wrap: wrap; gap: 6px 14px; font: 12.5px var(--mono); color: var(--faint); align-items: center; }
  .chip { color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); border-radius: 999px; padding: 1px 8px; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; }
  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 9px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel-2); text-decoration: none; font-weight: 600; font-size: 14.5px; }
  .btn:hover { border-color: var(--faint); }
  .btn--primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
  .btn--primary:hover { filter: brightness(1.06); border-color: transparent; }
  .btn:focus-visible, summary:focus-visible, h2 a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .install { border-top: 1px dashed var(--line); padding-top: 10px; font-size: 14px; color: var(--muted); }
  .install summary { cursor: pointer; font-weight: 600; color: var(--text); width: fit-content; }
  .install ol { margin: 10px 0 0; padding-left: 20px; display: grid; gap: 4px; }
  .install code { font: 13px var(--mono); background: var(--panel-2); border: 1px solid var(--line); padding: 1px 6px; border-radius: 6px; }
  kbd { font: 12px var(--mono); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; padding: 0 5px; background: var(--panel-2); }
  .empty { display: none; color: var(--muted); padding: 30px 0 60px; }
  .empty.show { display: block; }
  footer { border-top: 1px solid var(--line); padding: 22px 0 40px; color: var(--faint); font-size: 13px; display: flex; flex-wrap: wrap; gap: 8px 24px; justify-content: space-between; }
  footer a { color: var(--muted); }
  @media (max-width: 560px) {
    .top { padding-top: 40px; }
    .grid { grid-template-columns: 1fr; }
    .search { flex-basis: 100%; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
  <main class="wrap">
    <section class="top">
      <p class="eyebrow">${esc(config.eyebrow)}</p>
      <h1>${esc(config.headline)}</h1>
      <p class="intro">${esc(config.intro)}</p>
    </section>
    <div class="bar">
      <span class="count" id="count">${addins.length} add-in${addins.length === 1 ? '' : 's'}</span>
      <label class="search">
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M10.68 11.74a6 6 0 1 1 1.06-1.06l3.04 3.04a.75.75 0 1 1-1.06 1.06ZM11.5 7a4.5 4.5 0 1 0-9 0 4.5 4.5 0 0 0 9 0Z"/></svg>
        <input id="q" type="search" placeholder="Search add-ins" aria-label="Search add-ins" autocomplete="off">
      </label>
    </div>
    <section class="grid" id="grid">${cards}
    </section>
    <p class="empty" id="empty">No add-in matches that search.</p>
    <footer>
      <span>Built ${esc(fmtDate(builtAt))} from <a href="https://github.com/${esc(OWNER)}?tab=repositories&amp;q=topic%3A${esc(TOPIC)}">repositories tagged <code>${esc(TOPIC)}</code></a>.</span>
      <span>By <a href="https://github.com/${esc(OWNER)}">${esc(config.author)}</a> · Not affiliated with Autodesk.</span>
    </footer>
  </main>
  <script>
    (() => {
      const q = document.getElementById('q');
      const cards = [...document.querySelectorAll('.card')];
      const count = document.getElementById('count');
      const empty = document.getElementById('empty');
      const total = cards.length;
      q.addEventListener('input', () => {
        const terms = q.value.toLowerCase().trim().split(/\\s+/).filter(Boolean);
        let shown = 0;
        for (const c of cards) {
          const hit = terms.every((t) => c.dataset.search.includes(t));
          c.hidden = !hit;
          if (hit) shown++;
        }
        count.textContent = terms.length ? shown + ' of ' + total + ' add-ins' : total + (total === 1 ? ' add-in' : ' add-ins');
        empty.classList.toggle('show', shown === 0);
      });
    })();
  </script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- main

async function listRepos() {
  if (ONLY.length) return Promise.all(ONLY.map((r) => api(`/repos/${OWNER}/${r}`))).then((x) => x.filter(Boolean));
  const repos = await apiAll(`/users/${OWNER}/repos?type=owner&sort=pushed`);
  if (INCLUDE_PRIVATE) {
    const mine = await apiAll('/user/repos?affiliation=owner&visibility=private');
    for (const r of mine) if (r.owner.login.toLowerCase() === OWNER.toLowerCase()) repos.push(r);
  }
  return repos;
}

const repos = await listRepos();
const tagged = ONLY.length ? repos : repos.filter((r) => r.topics?.includes(TOPIC) && !r.archived);
console.log(`${OWNER}: ${repos.length} repos, ${tagged.length} on the page`);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const addins = [];
for (const repo of tagged) {
  const info = await describe(repo);
  if (!info) {
    console.warn(`! ${repo.name}: skipped (empty repo or hidden)`);
    continue;
  }
  if (!info.folder) console.warn(`! ${repo.name}: no Fusion .manifest found; listed anyway`);
  console.log(`+ ${repo.name} -> "${info.name}" ${info.version ? `v${String(info.version).replace(/^v/i, '')}` : ''}`);
  addins.push(info);
}

// Pinned cards first, then my own add-ins before forks, newest release (or push) first.
const newest = (a) => a.releasedAt || a.updated;
addins.sort(
  (a, b) =>
    (a.order ?? 1e9) - (b.order ?? 1e9) ||
    Number(Boolean(a.forkOf)) - Number(Boolean(b.forkOf)) ||
    newest(b).localeCompare(newest(a)),
);

let untagged = [];
if (SCAN_UNTAGGED && !ONLY.length) {
  for (const repo of repos) {
    if (repo.archived || repo.topics?.includes(TOPIC)) continue;
    const tree = await api(`/repos/${OWNER}/${repo.name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`);
    const paths = tree?.tree?.filter((n) => n.type === 'blob').map((n) => n.path) || [];
    if (await readManifest(repo.name, repo.default_branch, findManifest(paths))) untagged.push(repo.name);
  }
  for (const name of untagged) console.warn(`? ${name} contains a Fusion manifest but has no "${TOPIC}" topic`);
}

const builtAt = new Date().toISOString();
await writeFile(path.join(OUT, 'index.html'), page(addins, builtAt));
await writeFile(path.join(OUT, 'addins.json'), JSON.stringify({ owner: OWNER, topic: TOPIC, builtAt, addins }, null, 2));
await writeFile(path.join(OUT, '.nojekyll'), '');

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = addins.map((a) => `| [${a.name}](${a.url}) | ${a.version ?? ''} | ${a.folder ?? '—'} | ${a.screenshot ? 'yes' : 'no'} |`);
  let md = `### ${addins.length} add-ins on the page\n\n| Add-in | Version | Folder | Picture |\n|---|---|---|---|\n${rows.join('\n')}\n`;
  if (untagged.length) md += `\n**Not tagged \`${TOPIC}\` yet:** ${untagged.join(', ')}\n`;
  await writeFile(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' });
}

console.log(`Wrote ${path.relative(ROOT, OUT)}/index.html`);
