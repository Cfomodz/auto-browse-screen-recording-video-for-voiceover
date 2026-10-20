/**
 * Local stand-in for a search engine, for end-to-end runs where the real one
 * can't be used (datacenter IPs get bot-check pages from Google and Bing).
 *
 * Mimics Google's layout and the DOM hooks the modules look for: a centered
 * `textarea[name="q"]` home page, results with `h3` titles, `tbm=nws` /
 * `udm=2` tab links, a `.lr_dct_ent` definition card for "define ..." queries,
 * and `div[data-news-doc-id]` news cards. Result links point at real sites so
 * click-throughs land on real pages.
 *
 * Usage: startMockSearchServer() → { url, close }, or run this file directly.
 */
import * as http from 'http';
import { AddressInfo } from 'net';

const LOGO_COLORS = ['#4285f4', '#ea4335', '#fbbc05', '#4285f4', '#34a853', '#ea4335'];

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Small deterministic PRNG so the same query always renders the same page. */
function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function logo(size: number): string {
  return [...'Seekly']
    .map((ch, i) => `<span style="color:${LOGO_COLORS[i]}">${ch}</span>`)
    .join('')
    .replace(/^/, `<span class="logo" style="font-size:${size}px">`)
    .concat('</span>');
}

const BASE_STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #202124; background: #fff; }
  a { color: #1a0dab; text-decoration: none; }
  .logo { font-weight: 500; letter-spacing: -2px; font-family: 'Product Sans', Arial, sans-serif; }
  textarea[name="q"] {
    font: 16px Arial, sans-serif; resize: none; overflow: hidden; outline: none;
    border: 1px solid #dfe1e5; border-radius: 24px; padding: 12px 20px 12px 48px; line-height: 24px;
    background: #fff url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'><circle cx='8' cy='8' r='6' stroke='%239aa0a6' stroke-width='2' fill='none'/><line x1='12.5' y1='12.5' x2='18' y2='18' stroke='%239aa0a6' stroke-width='2'/></svg>") no-repeat 16px center;
  }
  textarea[name="q"]:hover, textarea[name="q"]:focus { box-shadow: 0 1px 6px rgba(32,33,36,.28); border-color: transparent; }
`;

const SUBMIT_ON_ENTER = `
  <script>
    for (const box of document.querySelectorAll('textarea[name="q"]')) {
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); box.form.submit(); }
      });
    }
  </script>`;

function homePage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Seekly</title><style>${BASE_STYLE}
    .top { position: absolute; top: 18px; right: 24px; font-size: 13px; display: flex; gap: 16px; align-items: center; }
    .top a { color: #202124; }
    .signin { background: #0b57d0; color: #fff !important; border-radius: 20px; padding: 10px 22px; }
    .center { text-align: center; margin-top: 240px; }
    form { margin-top: 26px; }
    textarea[name="q"] { width: 584px; height: 50px; }
    .buttons { margin-top: 30px; }
    .buttons button { background: #f8f9fa; border: 1px solid #f8f9fa; border-radius: 4px; color: #3c4043; font-size: 14px; margin: 0 4px; padding: 0 16px; height: 36px; }
    footer { position: absolute; bottom: 0; width: 100%; background: #f2f2f2; padding: 14px 30px; font-size: 14px; color: #70757a; }
  </style></head><body>
    <div class="top"><a href="#">Mail</a><a href="#">Images</a><a class="signin" href="#">Sign in</a></div>
    <div class="center">
      ${logo(92)}
      <form action="/search" method="get"><textarea name="q" rows="1" aria-label="Search"></textarea></form>
      <div class="buttons"><button>Seekly Search</button><button>I'm Feeling Lucky</button></div>
    </div>
    <footer>About &nbsp; Advertising &nbsp; Business &nbsp; How Search works</footer>
    ${SUBMIT_ON_ENTER}
  </body></html>`;
}

function header(query: string, tab: 'all' | 'images' | 'news'): string {
  const q = encodeURIComponent(query);
  const tabLink = (name: string, href: string, active: boolean) =>
    `<a href="${href}" class="${active ? 'active' : ''}">${name}</a>`;
  return `
    <div class="header">
      <a href="/">${logo(30)}</a>
      <form action="/search" method="get"><textarea name="q" rows="1" aria-label="Search">${escapeHtml(query)}</textarea></form>
    </div>
    <div class="tabs">
      ${tabLink('All', `/search?q=${q}`, tab === 'all')}
      ${tabLink('Images', `/search?q=${q}&udm=2`, tab === 'images')}
      ${tabLink('News', `/search?q=${q}&tbm=nws`, tab === 'news')}
      ${tabLink('Videos', `/search?q=${q}&udm=7`, false)}
      ${tabLink('Shopping', `/search?q=${q}&udm=28`, false)}
      ${tabLink('Maps', '#', false)}
    </div>`;
}

const RESULTS_STYLE = `
  .header { display: flex; align-items: center; gap: 40px; padding: 20px 0 0 30px; }
  .header textarea[name="q"] { width: 690px; height: 46px; }
  .tabs { display: flex; gap: 26px; padding: 18px 0 0 180px; border-bottom: 1px solid #ebebeb; font-size: 14px; }
  .tabs a { color: #5f6368; padding-bottom: 12px; }
  .tabs a.active { color: #1a73e8; border-bottom: 3px solid #1a73e8; }
  .main { display: flex; gap: 70px; padding: 20px 0 80px 180px; }
  .results { width: 652px; }
  .stats { color: #70757a; font-size: 14px; margin-bottom: 18px; }
  .result { margin-bottom: 30px; }
  .site { display: flex; align-items: center; gap: 12px; font-size: 14px; color: #202124; }
  .site .favicon { width: 28px; height: 28px; border-radius: 50%; background: #f1f3f4; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #5f6368; }
  .site .url { color: #4d5156; font-size: 12px; }
  h3 { font-size: 20px; font-weight: 400; margin: 6px 0 4px; line-height: 1.3; }
  a:hover h3 { text-decoration: underline; }
  .snippet { font-size: 14px; line-height: 1.58; color: #4d5156; }
  .panel { width: 372px; border: 1px solid #dadce0; border-radius: 8px; padding: 16px; align-self: flex-start; }
  .panel h2 { font-weight: 400; font-size: 28px; margin: 0 0 4px; }
  .panel .kind { color: #70757a; font-size: 14px; margin-bottom: 12px; }
  .panel .hero { height: 180px; border-radius: 8px; margin-bottom: 12px; }
  .lr_dct_ent { border: 1px solid #dadce0; border-radius: 8px; padding: 20px 24px; margin-bottom: 30px; }
  .lr_dct_ent .word { font-size: 32px; margin-bottom: 2px; }
  .lr_dct_ent .phon { color: #70757a; font-size: 15px; margin-bottom: 14px; }
  .lr_dct_ent .pos { font-style: italic; color: #70757a; margin: 10px 0 6px; }
  .lr_dct_ent ol { margin: 0; padding-left: 22px; line-height: 1.6; }
`;

const SITES = [
  { name: 'Wikipedia', host: 'en.wikipedia.org', url: (q: string) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}` },
  { name: 'Merriam-Webster', host: 'www.merriam-webster.com', url: (q: string) => `https://www.merriam-webster.com/dictionary/${encodeURIComponent(q.split(' ').pop() ?? q)}` },
  { name: 'Britannica', host: 'www.britannica.com', url: (q: string) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}` },
  { name: 'Medium', host: 'medium.com', url: (q: string) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}` },
  { name: 'Reddit', host: 'www.reddit.com', url: (q: string) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}` },
  { name: 'Stack Exchange', host: 'stackexchange.com', url: (q: string) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}` },
];

const TITLE_PATTERNS = [
  (q: string) => `${q} - Wikipedia`,
  (q: string) => `What Is ${q}? A Complete Guide`,
  (q: string) => `${q}: Definition, Examples, and Why It Matters`,
  (q: string) => `Understanding ${q} in Plain English`,
  (q: string) => `The Truth About ${q} (2026 Update)`,
  (q: string) => `${q} Explained — Everything You Need to Know`,
  (q: string) => `10 Things People Get Wrong About ${q}`,
  (q: string) => `How ${q} Actually Works`,
  (q: string) => `${q}: Common Questions Answered`,
  (q: string) => `A Beginner's Guide to ${q}`,
];

const SNIPPET_WORDS =
  'researchers found that the model often relies on surface patterns rather than reasoning about the situation which explains why answers can sound helpful while missing an obvious constraint in the question users report'.split(' ');

function snippet(query: string, rand: () => number): string {
  const words = Array.from({ length: 34 }, () => SNIPPET_WORDS[Math.floor(rand() * SNIPPET_WORDS.length)]);
  words.splice(Math.floor(rand() * 10), 0, `<b>${escapeHtml(query)}</b>`);
  const text = words.join(' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} ...`;
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

function resultsPage(query: string): string {
  const rand = seededRandom(query);
  const display = titleCase(query.replace(/^define\s+/i, ''));
  const isDefine = /^define\s+/i.test(query);
  const term = query.replace(/^define\s+/i, '');

  const definitionCard = isDefine
    ? `<div class="lr_dct_ent" data-attrid="wa:/description">
         <div class="word">${escapeHtml(term)}</div>
         <div class="phon">/ ${escapeHtml(term.toLowerCase())} /</div>
         <div class="pos">noun</div>
         <ol>
           <li><span data-dobid="dfn">a confident response by an AI model that is not justified by its training data or the prompt.</span></li>
           <li><span>an experience involving the apparent perception of something not present.</span></li>
         </ol>
       </div>`
    : '';

  const results = TITLE_PATTERNS.map((pattern, i) => {
    const site = SITES[i % SITES.length];
    return `<div class="result">
      <div class="site"><div class="favicon">${site.name[0]}</div><div><div>${site.name}</div><div class="url">https://${site.host} › ${escapeHtml(term.replace(/\s+/g, '-').toLowerCase())}</div></div></div>
      <a href="${site.url(term)}"><h3>${escapeHtml(pattern(display))}</h3></a>
      <div class="snippet">${snippet(term, rand)}</div>
    </div>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(query)} - Seekly Search</title>
    <style>${BASE_STYLE}${RESULTS_STYLE}</style></head><body>
    ${header(query, 'all')}
    <div class="main">
      <div class="results">
        <div class="stats">About ${(Math.floor(rand() * 900) + 100).toLocaleString('en-US')},000,000 results (0.${Math.floor(rand() * 90) + 10} seconds)</div>
        ${definitionCard}${results}
      </div>
      <div class="panel">
        <div class="hero" style="background: linear-gradient(135deg, hsl(${Math.floor(rand() * 360)},55%,60%), hsl(${Math.floor(rand() * 360)},55%,45%))"></div>
        <h2>${escapeHtml(display)}</h2>
        <div class="kind">Topic</div>
        <div class="snippet">${snippet(term, rand)}</div>
      </div>
    </div>
    ${SUBMIT_ON_ENTER}
  </body></html>`;
}

function newsPage(query: string): string {
  const rand = seededRandom(`news:${query}`);
  const outlets = ['The Verge', 'Reuters', 'Wired', 'Ars Technica', 'BBC News', 'TechCrunch', 'The Guardian', 'MIT Technology Review'];
  const cards = Array.from({ length: 10 }, (_, i) => {
    const outlet = outlets[i % outlets.length];
    const hue = Math.floor(rand() * 360);
    return `<div class="news" data-news-doc-id="${i}">
      <a href="https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query)}">
        <div class="body">
          <div class="outlet">${outlet}</div>
          <div class="headline" role="heading">${escapeHtml(TITLE_PATTERNS[(i + 3) % TITLE_PATTERNS.length](titleCase(query)))}</div>
          <div class="snippet">${snippet(query, rand)}</div>
          <div class="when">${1 + Math.floor(rand() * 23)} hours ago</div>
        </div>
        <div class="thumb" style="background: linear-gradient(135deg, hsl(${hue},60%,62%), hsl(${(hue + 40) % 360},60%,40%))"></div>
      </a>
    </div>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(query)} - Seekly News</title>
    <style>${BASE_STYLE}${RESULTS_STYLE}
      .news { width: 652px; border-bottom: 1px solid #ebebeb; padding: 18px 0; }
      .news a { display: flex; gap: 20px; color: inherit; }
      .news .body { flex: 1; }
      .news .outlet { font-size: 12px; color: #202124; margin-bottom: 8px; }
      .news .headline { color: #1a0dab; font-size: 18px; line-height: 1.33; margin-bottom: 8px; }
      .news .when { color: #70757a; font-size: 12px; margin-top: 8px; }
      .news .thumb { width: 112px; height: 112px; border-radius: 8px; flex: none; }
    </style></head><body>
    ${header(query, 'news')}
    <div class="main"><div class="results">${cards}</div></div>
    ${SUBMIT_ON_ENTER}
  </body></html>`;
}

function imagesPage(query: string): string {
  const rand = seededRandom(`img:${query}`);
  const tiles = Array.from({ length: 48 }, (_, i) => {
    const hue = Math.floor(rand() * 360);
    const w = 220 + Math.floor(rand() * 160);
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='200'>` +
      `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${hue},65%,65%)'/>` +
      `<stop offset='1' stop-color='hsl(${(hue + 50) % 360},60%,38%)'/></linearGradient></defs>` +
      `<rect width='100%' height='100%' fill='url(%23g)'/>` +
      `<circle cx='${30 + Math.floor(rand() * (w - 60))}' cy='${40 + Math.floor(rand() * 120)}' r='${20 + Math.floor(rand() * 40)}' fill='rgba(255,255,255,0.35)'/></svg>`;
    const src = `data:image/svg+xml;utf8,${svg.replace(/#/g, '%23')}`;
    return `<div class="tile"><img data-src="${i}" src="${src}" width="${w}" height="200" alt="">
      <div class="cap">${escapeHtml(titleCase(query))} ${i + 1}</div><div class="src">${SITES[i % SITES.length].host}</div></div>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(query)} - Seekly Images</title>
    <style>${BASE_STYLE}${RESULTS_STYLE}
      .grid { display: flex; flex-wrap: wrap; gap: 14px; padding: 20px 24px 80px; }
      .tile { flex: auto; }
      .tile img { display: block; height: 200px; width: 100%; object-fit: cover; border-radius: 8px; }
      .tile .cap { font-size: 12px; margin-top: 6px; color: #202124; }
      .tile .src { font-size: 11px; color: #70757a; }
    </style></head><body>
    ${header(query, 'images')}
    <div class="grid">${tiles}</div>
    ${SUBMIT_ON_ENTER}
  </body></html>`;
}

export async function startMockSearchServer(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const query = url.searchParams.get('q') ?? '';
    let html: string;
    if (url.pathname === '/search' && query) {
      if (url.searchParams.get('tbm') === 'nws') html = newsPage(query);
      else if (url.searchParams.get('udm') === '2') html = imagesPage(query);
      else html = resultsPage(query);
    } else if (url.pathname === '/' || url.pathname === '/search') {
      html = homePage();
    } else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: actualPort } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actualPort}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

if (require.main === module) {
  startMockSearchServer(Number(process.env.PORT ?? 8765)).then(({ url }) => {
    console.log(`Mock search engine listening at ${url}`);
  });
}
