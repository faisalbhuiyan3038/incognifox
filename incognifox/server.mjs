#!/usr/bin/env node
// MCP server that drives a real Firefox over the DevTools debugger server.
// Marionette and WebDriver BiDi stay off, so navigator.webdriver remains false.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { RDP, gripToText } from './rdp.mjs';

const DEFAULT_BINARY = {
  win32: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  darwin: '/Applications/Firefox.app/Contents/MacOS/firefox',
}[process.platform] || 'firefox';

const CONFIG = {
  binary: process.env.INCOGNIFOX_BINARY || DEFAULT_BINARY,
  profile: process.env.INCOGNIFOX_PROFILE || path.join(os.homedir(), '.incognifox', 'profile'),
  headless: process.env.INCOGNIFOX_HEADLESS === '1',
};
const SHOT_DIR = path.join(os.tmpdir(), 'incognifox');
const PREFS = {
  'devtools.debugger.remote-enabled': true,
  'devtools.chrome.enabled': true,
  'devtools.debugger.prompt-connection': false,
  'devtools.debugger.force-local': true,
  // Keeps panels and popups rendering while the window sits behind other windows.
  'widget.windows.window_occlusion_tracking.enabled': false,
  'toolkit.legacyUserProfileCustomizations.stylesheets': true,
  'browser.shell.checkDefaultBrowser': false,
  'browser.aboutwelcome.enabled': false,
  'browser.preonboarding.enabled': false,
  'termsofuse.bypassNotification': true,
  'termsofuse.acceptedVersion': 999,
  'termsofuse.acceptedDate': '1700000000000',
  'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
  'browser.startup.homepage_override.mstone': 'ignore',
  'startup.homepage_welcome_url': '',
  'app.update.enabled': false,
};
const LOG_LIMIT = 300;
const ERROR_KEY = '__incognifoxError';
const VALUE_KEY = '__incognifoxValue';
const BACKGROUND_URL = /_generated_background|background/i;
const J = JSON.stringify;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cap(text, max = 6000) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated ${value.length - max} chars; raise max_chars or narrow the query]`;
}

function wrapCode(code) {
  const source = code.trim().replace(/;+\s*$/, '');
  const isBody = /\b(return|throw)\b/.test(source) || /^(const|let|var|if|for|while|try|class|function)\b/.test(source)
    || /;\s*\S/.test(source) || source.includes('\n');
  const body = isBody ? source : `return (${source}\n)`;
  return `(async()=>{let __v;try{__v=await (async()=>{${body}\n})()}catch(__e){return JSON.stringify({${ERROR_KEY}:String(__e&&__e.message||__e)})}
try{return JSON.stringify({${VALUE_KEY}:__v===undefined?null:__v})}catch{return JSON.stringify({${VALUE_KEY}:String(__v)})}})()`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

class Browser {
  constructor() {
    this.rdp = null;
    this.child = null;
    this.starting = null;
    this.tempAddons = new Map();
    this.refs = new Map();
    this.resetSession();
  }

  resetSession() {
    this.watchers = new Map();
    this.actorToTab = new Map();
    this.logs = new Map();
    this.requests = new Map();
    this.extWatchers = new Map();
  }

  get running() { return !!this.rdp?.alive; }

  ensure() {
    if (this.running) return Promise.resolve();
    this.starting ||= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async start() {
    fs.mkdirSync(CONFIG.profile, { recursive: true });
    fs.mkdirSync(path.join(CONFIG.profile, 'chrome'), { recursive: true });
    fs.writeFileSync(path.join(CONFIG.profile, 'user.js'),
      Object.entries(PREFS).map(([k, v]) => `user_pref(${J(k)}, ${J(v)});`).join('\n'));
    this.resetSession();
    this.port = await freePort();
    const args = ['--wait-for-browser', '-no-remote', '-new-instance', '-profile', CONFIG.profile, '--start-debugger-server', String(this.port)];
    if (CONFIG.headless) args.push('--headless');
    args.push('about:blank');
    this.child = spawn(CONFIG.binary, args, { stdio: 'ignore' });
    this.child.once('error', () => {});
    this.rdp = new RDP((packet) => this.handleEvent(packet));
    await this.rdp.connect(this.port);
    this.root = await this.rdp.send('root', 'getRoot');
    const { processDescriptor } = await this.rdp.send('root', 'getProcess', { id: 0 });
    const target = await this.rdp.send(processDescriptor.actor, 'getTarget');
    this.chromeActor = (target.process || target.frame || target).consoleActor;
    for (let i = 0; i < 100; i++) {
      const ready = await this.chrome(`return typeof gBrowser!=='undefined'&&!!gBrowser.selectedBrowser&&!!gBrowser.selectedBrowser.browserId`).catch(() => false);
      if (ready) break;
      await sleep(200);
    }
    for (const addonPath of this.tempAddons.values()) {
      await this.rdp.send(this.root.addonsActor, 'installTemporaryAddon', { addonPath, openDevTools: false }).catch(() => {});
    }
    await this.syncWatchers();
  }

  async quit({ clearCache = false } = {}) {
    if (!this.running) return;
    const child = this.child;
    const exited = new Promise((resolve) => child?.once('exit', resolve));
    await this.rdp.evaluate(this.chromeActor,
      `${clearCache ? 'Services.appinfo.invalidateCachesOnRestart();' : ''}setTimeout(()=>Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit),50);1`).catch(() => {});
    await Promise.race([exited, sleep(10000)]);
    this.rdp.close();
    this.rdp = null;
  }

  handleEvent(packet) {
    const tabId = this.actorToTab.get(packet.from);
    if (packet.type === 'target-available-form') {
      const ext = this.extWatchers.get(packet.from);
      if (ext) ext.targets.set(packet.target.actor, packet.target);
      else if (tabId !== undefined) this.actorToTab.set(packet.target.actor, tabId);
      return;
    }
    if (packet.type === 'target-destroyed-form') {
      this.extWatchers.get(packet.from)?.targets.delete(packet.target?.actor);
      return;
    }
    if (tabId === undefined) return;
    if (packet.type === 'resources-available-array') {
      for (const [kind, items] of packet.array || []) for (const item of items) this.recordResource(tabId, kind, item);
    } else if (packet.type === 'resources-updated-array') {
      for (const [kind, items] of packet.array || []) {
        if (kind !== 'network-event') continue;
        for (const item of items) {
          const entry = this.requests.get(tabId)?.find((r) => r.id === item.resourceId);
          const status = item.resourceUpdates?.status ?? item.resourceUpdates?.responseStatus;
          if (entry && status) entry.status = status;
        }
      }
    }
  }

  recordResource(tabId, kind, item) {
    const push = (map, entry) => {
      if (!map.has(tabId)) map.set(tabId, []);
      const list = map.get(tabId);
      list.push(entry);
      if (list.length > LOG_LIMIT) list.shift();
    };
    if (kind === 'console-message') {
      const message = item.message || item;
      push(this.logs, { level: message.level || 'log', text: (message.arguments || []).map(gripToText).join(' '), source: `${message.filename || ''}:${message.lineNumber || 0}` });
    } else if (kind === 'error-message') {
      const error = item.pageError || item;
      push(this.logs, { level: error.warning ? 'warn' : 'error', text: gripToText(error.errorMessage), source: `${error.sourceName || ''}:${error.lineNumber || 0}` });
    } else if (kind === 'network-event') {
      push(this.requests, { id: item.resourceId, method: item.method, url: item.url, status: item.status || '...' });
    }
  }

  async syncWatchers() {
    const { tabs } = await this.rdp.send('root', 'listTabs');
    for (const tab of tabs) {
      if (this.watchers.has(tab.browserId)) continue;
      this.watchers.set(tab.browserId, true);
      try {
        const watcher = await this.rdp.send(tab.actor, 'getWatcher', { isServerTargetSwitchingEnabled: true, isPopupDebuggingEnabled: false });
        this.actorToTab.set(watcher.actor, tab.browserId);
        await this.rdp.send(watcher.actor, 'watchTargets', { targetType: 'frame' });
        await this.rdp.send(watcher.actor, 'watchResources', { resourceTypes: ['console-message', 'error-message', 'network-event'] });
      } catch { this.watchers.delete(tab.browserId); }
    }
    return tabs;
  }

  async run(actor, code, timeoutMs) {
    const text = await this.rdp.evaluate(actor, wrapCode(code), timeoutMs);
    if (typeof text !== 'string') throw new Error('Evaluation returned no result');
    const outcome = JSON.parse(text);
    if (ERROR_KEY in outcome) throw new Error(outcome[ERROR_KEY]);
    return outcome[VALUE_KEY];
  }

  chrome(code, timeoutMs) { return this.run(this.chromeActor, code, timeoutMs); }

  async tabConsole() {
    const id = await this.chrome(`return gBrowser.selectedBrowser.browserId`);
    const { tabs } = await this.rdp.send('root', 'listTabs');
    const tab = tabs.find((t) => t.browserId === id);
    if (!tab) throw new Error('Selected tab not found');
    const target = await this.rdp.send(tab.actor, 'getTarget');
    return (target.frame || target).consoleActor;
  }

  async page(code, timeoutMs) {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await this.run(await this.tabConsole(), code, timeoutMs);
      } catch (error) {
        lastError = error;
        if (!/noSuchActor|destroyed|unrecognized|no such actor|closed/i.test(error.message)) throw error;
        await sleep(400);
      }
    }
    throw lastError;
  }

  scoped(scope, code, timeoutMs) { return scope === 'browser' ? this.chrome(code, timeoutMs) : this.page(code, timeoutMs); }

  async currentTab() {
    return this.chrome(`const b=gBrowser.selectedBrowser;return {id:b.browserId,url:b.currentURI.spec,title:b.contentTitle||gBrowser.selectedTab.label,loading:!!b.webProgress?.isLoadingDocument}`);
  }

  async waitLoaded(timeoutMs = 20000) {
    await sleep(250);
    const deadline = Date.now() + timeoutMs;
    let tab = await this.currentTab();
    while (tab.loading && Date.now() < deadline) {
      await sleep(200);
      tab = await this.currentTab();
    }
    return tab;
  }

  async point(args) {
    const scope = args.scope || 'page';
    if (args.x !== undefined && args.y !== undefined) {
      if (scope === 'browser') return { x: args.x, y: args.y };
      return this.chrome(`const b=gBrowser.selectedBrowser,r=b.getBoundingClientRect();return {x:r.left+${args.x},y:r.top+${args.y}}`);
    }
    const selector = this.resolveSelector(args);
    const rect = await this.scoped(scope, `const e=document.querySelector(${J(selector)});if(!e)throw new Error('No element matches '+${J(selector)});
e.scrollIntoView?.({block:'center',inline:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}`);
    if (!rect.w || !rect.h) throw new Error(`Element is not visible: ${selector}`);
    if (scope === 'browser') return rect;
    return this.chrome(`const b=gBrowser.selectedBrowser,r=b.getBoundingClientRect(),z=b.fullZoom||1;return {x:r.left+${rect.x}*z,y:r.top+${rect.y}*z}`);
  }

  resolveSelector({ ref, selector }) {
    if (selector) return selector;
    const found = this.refs.get(ref);
    if (!found) throw new Error(`Unknown ref ${ref}; take a new snapshot`);
    return found;
  }

  async mouse(x, y, { button = 0, count = 1 } = {}) {
    const buttons = button === 2 ? 2 : 1;
    await this.chrome(`window.focus();const o={isAsyncEnabled:true},x=${x},y=${y};
window.synthesizeMouseEvent('mousemove',x,y,{button:0,buttons:0},o);
for(let i=1;i<=${count};i++){window.synthesizeMouseEvent('mousedown',x,y,{button:${button},buttons:${buttons},clickCount:i},o);
window.synthesizeMouseEvent('mouseup',x,y,{button:${button},buttons:0,clickCount:i},o);}
return true`);
  }

  async keys(sequence, modifiers = []) {
    await this.chrome(`const tip=Cc['@mozilla.org/text-input-processor;1'].createInstance(Ci.nsITextInputProcessor);
if(!tip.beginInputTransactionForTests(window))throw new Error('Keyboard unavailable');
const named={Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Home:36,End:35,PageUp:33,PageDown:34};
const ev=k=>new KeyboardEvent('',named[k]?{key:k,code:k,keyCode:named[k]}:{key:k});
const mods=${J(modifiers)}.map(m=>new KeyboardEvent('',{key:m,code:m+'Left'}));
for(const m of mods)tip.keydown(m);
for(const k of ${J(sequence)}){const e=ev(k);tip.keydown(e);tip.keyup(e);}
for(const m of mods.reverse())tip.keyup(m);
return true`);
  }

  async extTarget(id, page = 'background') {
    const { addons } = await this.rdp.send('root', 'listAddons', { iconDataURL: false });
    const addon = addons.find((a) => a.id === id);
    if (!addon) throw new Error(`Extension not installed: ${id}`);
    let entry = this.extEntry(id);
    if (entry && entry.addonActor !== addon.actor) {
      this.extWatchers.delete(entry.actor);
      entry = null;
    }
    if (!entry) {
      const watcher = await this.rdp.send(addon.actor, 'getWatcher', {});
      entry = { id, actor: watcher.actor, addonActor: addon.actor, targets: new Map() };
      this.extWatchers.set(watcher.actor, entry);
      this.rdp.post(watcher.actor, 'unwatchTargets', { targetType: 'frame' });
      await this.rdp.send(watcher.actor, 'watchTargets', { targetType: 'frame' });
    }
    const match = (t) => {
      const url = t.url || '';
      if (!url.startsWith('moz-extension://')) return false;
      return page === 'background' ? BACKGROUND_URL.test(url) : url.includes(page);
    };
    for (let i = 0; i < 30; i++) {
      const target = [...entry.targets.values()].reverse().find(match);
      if (target) return target;
      if (i === 12) {
        // A reload can replace contexts without notifying an existing watch, so ask again.
        entry.targets.clear();
        this.rdp.post(entry.actor, 'unwatchTargets', { targetType: 'frame' });
        await this.rdp.send(entry.actor, 'watchTargets', { targetType: 'frame' }).catch(() => {});
      }
      await sleep(200);
    }
    const urls = [...entry.targets.values()].map((t) => t.url).filter(Boolean);
    throw new Error(`No "${page}" context for ${id}. Open contexts: ${urls.join(', ') || 'none'}`);
  }

  extEntry(id) { return [...this.extWatchers.values()].find((w) => w.id === id); }

  forgetExtContexts(id) { this.extEntry(id)?.targets.clear(); }
}

const browser = new Browser();

const SNAPSHOT = (scope, selector, limit, query = '', contentFirst = false) => `const root=${selector ? `document.querySelector(${J(selector)})` : 'document.documentElement'};
if(!root)throw new Error('No element matches selector');
const q='a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[onclick],[contenteditable=true]${scope === 'browser' ? ',toolbarbutton,menuitem,tab,menulist,checkbox,moz-button' : ''}';
const path=e=>{if(e.id&&document.querySelectorAll('#'+CSS.escape(e.id)).length===1)return '#'+CSS.escape(e.id);const p=[];
while(e&&e.nodeType===1&&e!==document.documentElement){let s=e.localName.replace(/:/g,'\\\\:');const sib=e.parentElement?[...e.parentElement.children].filter(x=>x.localName===e.localName):[];
if(sib.length>1)s+=':nth-of-type('+(sib.indexOf(e)+1)+')';p.unshift(s);if(e.parentElement?.id){p.unshift('#'+CSS.escape(e.parentElement.id));break}e=e.parentElement}return p.join(' > ')};
const all=[...root.querySelectorAll(q)].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0});
let rows=all.map(e=>({e,role:e.getAttribute('role')||e.localName+(e.localName==='input'&&e.type?':'+e.type:''),name:(e.getAttribute('aria-label')||e.getAttribute('label')||e.innerText||e.placeholder||e.value||e.title||e.getAttribute('tooltiptext')||'').trim().replace(/\\s+/g,' ')}));
const needle=${J(String(query).toLowerCase())};
if(needle)rows=rows.filter(r=>(r.role+' '+r.name).toLowerCase().includes(needle));
if(${contentFirst}){const rank=e=>e.closest('main,article,[role=main]')?0:e.closest('nav,header,footer,aside,[role=navigation],[role=banner],[role=contentinfo]')?2:1;
rows=rows.map((r,i)=>[rank(r.e),i,r]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]).map(x=>x[2])}
const items=rows.slice(0,${limit}).map(r=>({sel:path(r.e),role:r.role,name:r.name.slice(0,60)}));
return {title:document.title,url:location.href,total:rows.length,items}`;

function registerRefs(snap) {
  browser.refs.clear();
  const lines = snap.items.map((item, i) => {
    browser.refs.set(`e${i + 1}`, item.sel);
    return `e${i + 1} ${item.role} ${J(item.name)}`;
  });
  if (snap.total > snap.items.length) lines.push(`[${snap.total - snap.items.length} more; narrow with query or selector]`);
  return lines.join('\n');
}

function compactLines(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function searchText(text, query, { regex = false, context = 2 } = {}) {
  let matches;
  if (regex) {
    let pattern;
    try { pattern = new RegExp(query, 'i'); } catch (error) { throw new Error(`Invalid regex: ${error.message}`); }
    matches = (line) => pattern.test(line);
  } else {
    const needle = query.toLowerCase();
    matches = (line) => line.toLowerCase().includes(needle);
  }
  const lines = compactLines(text);
  const hits = lines.flatMap((line, i) => (matches(line) ? [i] : []));
  const header = `${hits.length} matches in ${lines.length} lines`;
  const blocks = [];
  let end = -1;
  for (const hit of hits) {
    const from = Math.max(0, hit - context);
    const to = Math.min(lines.length - 1, hit + context);
    if (from <= end + 1 && blocks.length) blocks[blocks.length - 1].push(...lines.slice(end + 1, to + 1));
    else blocks.push(lines.slice(from, to + 1));
    end = Math.max(end, to);
  }
  return [header, ...blocks.map((block) => block.join('\n'))].join('\n--\n');
}

// The page an action produced: title, a text excerpt and the elements to act on next.
async function pageView({ query, page_chars = 1500 }) {
  await browser.waitLoaded();
  const snap = await browser.page(SNAPSHOT('page', null, 30, query || '', true));
  const parts = [`${snap.title} | ${snap.url}`];
  if (page_chars > 0) {
    const text = await browser.page(query ? `document.body?.innerText||''`
      : `const m=document.querySelector('main,article,[role=main]');return ((m&&m.innerText.trim().length>200?m:document.body)?.innerText)||''`);
    parts.push(cap(query ? searchText(text, query) : compactLines(text).join('\n'), page_chars));
  }
  parts.push(registerRefs(snap) || 'No interactive elements');
  return parts.join('\n\n');
}

const PAGE_PROPS = {
  with_page: { type: 'boolean', description: 'Also return the resulting page: title, text excerpt and element refs' },
  query: { type: 'string', description: 'With with_page: keep only matching text and elements' },
  page_chars: { type: 'number', description: 'With with_page: excerpt size, default 1500, 0 for none' },
};

const withPage = (run) => async (args) => {
  const output = await run(args);
  return args.with_page ? `${output}\n\n${await pageView(args)}` : output;
};

function listing(rows, limit, format, empty) {
  if (!rows.length) return empty;
  const shown = rows.slice(-limit);
  const summary = shown.length < rows.length ? [`Showing ${shown.length} of ${rows.length}`] : [];
  return cap([...summary, ...shown.map(format)].join('\n'));
}

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const SCOPE = { type: 'string', enum: ['page', 'browser'], description: 'page (default) or browser UI' };

const TOOLS = {
  browser_status: {
    description: 'Firefox version, profile, chrome folder, tabs and automation flag.',
    run: async () => {
      const info = await browser.chrome(`return {version:Services.appinfo.version,profile:Services.dirsvc.get('ProfD',Ci.nsIFile).path,chromeDir:Services.dirsvc.get('UChrm',Ci.nsIFile).path,binary:Services.dirsvc.get('XREExeF',Ci.nsIFile).path,tabs:gBrowser.tabs.map(t=>({id:t.linkedBrowser.browserId,url:t.linkedBrowser.currentURI.spec,selected:t.selected}))}`);
      info.webdriver = await browser.page(`navigator.webdriver`).catch(() => 'unavailable');
      return J(info);
    },
  },
  browser_restart: {
    description: 'Restart Firefox and clear the startup cache. Use after changing fx-autoconfig scripts or startup files.',
    run: async () => {
      await browser.quit({ clearCache: true });
      await browser.ensure();
      return 'Restarted';
    },
  },
  tabs: {
    description: 'List, open, select or close tabs.',
    props: { action: { type: 'string', enum: ['list', 'open', 'select', 'close'] }, id: num('Tab id for select or close'), url: str('URL for open') },
    required: ['action'],
    run: async ({ action, id, url }) => {
      const P = 'triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()';
      const find = `const t=gBrowser.tabs.find(t=>t.linkedBrowser.browserId===${J(id)});if(!t)throw new Error('No tab with that id');`;
      if (action === 'open') {
        await browser.chrome(`gBrowser.selectedTab=gBrowser.addTab('about:blank',{${P}});return true`);
        await browser.syncWatchers();
        if (url) await browser.chrome(`gBrowser.selectedBrowser.fixupAndLoadURIString(${J(url)},{${P}});return true`);
        return J(await browser.waitLoaded());
      }
      if (action === 'select') await browser.chrome(`${find}gBrowser.selectedTab=t;return true`);
      if (action === 'close') await browser.chrome(`${find}gBrowser.removeTab(t);return true`);
      await browser.syncWatchers();
      return J(await browser.chrome(`return gBrowser.tabs.map(t=>({id:t.linkedBrowser.browserId,url:t.linkedBrowser.currentURI.spec,title:t.label,selected:t.selected}))`));
    },
  },
  navigate: {
    description: 'Load a URL in the selected tab. Accepts http(s), about:, chrome:// and moz-extension:// URLs. action can be back, forward or reload instead.',
    props: { url: str('URL to load'), action: { type: 'string', enum: ['back', 'forward', 'reload'] }, timeout_ms: num('Load wait, default 20000'), ...PAGE_PROPS },
    run: async (args) => {
      const { url, action, timeout_ms } = args;
      await browser.syncWatchers();
      if (action) await browser.chrome(`gBrowser.${{ back: 'goBack', forward: 'goForward', reload: 'reload' }[action]}();return true`);
      else if (url) await browser.chrome(`gBrowser.selectedBrowser.fixupAndLoadURIString(${J(url)},{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});return true`);
      else throw new Error('Provide url or action');
      const tab = await browser.waitLoaded(timeout_ms);
      return args.with_page ? pageView(args) : J(tab);
    },
  },
  snapshot: {
    description: 'Compact list of visible interactive elements with refs for click and type. Prefer over screenshots.',
    props: { scope: SCOPE, selector: str('Limit to this subtree'), query: str('Keep elements whose role or name contains this'), max_items: num('Default 60') },
    run: async ({ scope = 'page', selector, query, max_items = 60 }) => {
      const snap = await browser.scoped(scope, SNAPSHOT(scope, selector, max_items, query || ''));
      return `${snap.title} | ${snap.url}\n${registerRefs(snap)}`;
    },
  },
  page_text: {
    description: 'Visible text of the page or one element. Use query to return only matching lines.',
    props: { selector: str('CSS selector'), query: str('Text to find, case-insensitive'), regex: bool('Treat query as a regular expression'), context: num('Lines around each match, default 2'), max_chars: num('Default 4000') },
    run: async ({ selector, query, regex, context, max_chars = 4000 }) => {
      const text = await browser.page(`const e=${selector ? `document.querySelector(${J(selector)})` : 'document.body'};if(!e)throw new Error('No element matches selector');return e.innerText`);
      return cap(query ? searchText(text, query, { regex, context }) : text, max_chars);
    },
  },
  click: {
    description: 'Trusted mouse click on a ref, selector or x,y point.',
    props: { ref: str('Ref from snapshot'), selector: str('CSS selector'), x: num('X in the scope viewport'), y: num('Y in the scope viewport'), scope: SCOPE, button: { type: 'string', enum: ['left', 'right'] }, double: bool('Double click'), ...PAGE_PROPS },
    run: withPage(async (args) => {
      const { x, y } = await browser.point(args);
      await browser.mouse(x, y, { button: args.button === 'right' ? 2 : 0, count: args.double ? 2 : 1 });
      await sleep(150);
      return 'Clicked';
    }),
  },
  type: {
    description: 'Trusted keyboard input. Clicks the ref or selector first when given.',
    props: { text: str('Text to type'), ref: str('Ref from snapshot'), selector: str('CSS selector'), scope: SCOPE, clear: bool('Replace existing value'), submit: bool('Press Enter afterwards'), ...PAGE_PROPS },
    required: ['text'],
    run: withPage(async (args) => {
      if (args.ref || args.selector) {
        const { x, y } = await browser.point(args);
        await browser.mouse(x, y);
        await sleep(120);
        if (args.clear) await browser.scoped(args.scope, `document.activeElement?.select?.();return true`);
      }
      await browser.keys([...args.text]);
      if (args.submit) await browser.keys(['Enter']);
      return 'Typed';
    }),
  },
  press_key: {
    description: 'Press a key such as Enter, Escape, Tab, ArrowDown or a letter, with optional modifiers.',
    props: { key: str('Key name'), modifiers: { type: 'array', items: { type: 'string', enum: ['Control', 'Shift', 'Alt', 'Meta'] } }, ...PAGE_PROPS },
    required: ['key'],
    run: withPage(async ({ key, modifiers = [] }) => { await browser.keys([key], modifiers); return 'Pressed'; }),
  },
  wait_for: {
    description: 'Wait until a selector or text appears on the page.',
    props: { selector: str('CSS selector'), text: str('Visible text'), timeout_ms: num('Default 10000') },
    run: async ({ selector, text, timeout_ms = 10000 }) => {
      const check = selector ? `!!document.querySelector(${J(selector)})` : `(document.body?.innerText||'').includes(${J(text)})`;
      const deadline = Date.now() + timeout_ms;
      while (Date.now() < deadline) {
        if (await browser.page(check).catch(() => false)) return 'Found';
        await sleep(250);
      }
      throw new Error(`Not found after ${timeout_ms} ms`);
    },
  },
  eval_page: {
    description: 'Run JS in the selected tab. Use an expression, or statements with return. Promises are awaited.',
    props: { code: str('JavaScript'), max_chars: num('Default 6000') },
    required: ['code'],
    run: async ({ code, max_chars }) => cap(J(await browser.page(code)), max_chars),
  },
  eval_chrome: {
    description: 'Run privileged JS in the browser window (Services, gBrowser, document is browser.xhtml).',
    props: { code: str('JavaScript'), max_chars: num('Default 6000') },
    required: ['code'],
    run: async ({ code, max_chars }) => cap(J(await browser.chrome(code)), max_chars),
  },
  screenshot: {
    description: 'Save a PNG and return its path. Set inline only when you cannot read image files.',
    props: { target: { type: 'string', enum: ['page', 'browser', 'popup'], description: 'Default page' }, path: str('Output file'), inline: bool('Also return the image') },
    run: async ({ target = 'page', path: output, inline }) => {
      const source = { page: 'gBrowser.selectedBrowser', browser: 'null', popup: `document.querySelector('.webextension-popup-browser')` }[target];
      const data = await browser.chrome(`const el=${source};if(${J(target)}==='popup'&&!el)throw new Error('No open extension popup');
const bc=el?el.browsingContext:window.browsingContext;const w=Math.ceil(el?el.clientWidth:window.innerWidth),h=Math.ceil(el?el.clientHeight:window.innerHeight);
if(!w||!h)throw new Error('Nothing to capture: the target has no size');
const bmp=await bc.currentWindowGlobal.drawSnapshot(new DOMRect(0,0,w,h),1,'white');const c=document.createElementNS('http://www.w3.org/1999/xhtml','canvas');c.width=bmp.width;c.height=bmp.height;c.getContext('2d').drawImage(bmp,0,0);return c.toDataURL('image/png')`, 45000);
      const base64 = data.split(',')[1];
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const file = output || path.join(SHOT_DIR, `shot-${Date.now()}.png`);
      fs.writeFileSync(file, Buffer.from(base64, 'base64'));
      return inline ? { content: [{ type: 'text', text: file }, { type: 'image', data: base64, mimeType: 'image/png' }] } : file;
    },
  },
  console_logs: {
    description: 'Console messages and page errors for the selected tab, newest last.',
    props: { level: { type: 'string', enum: ['error', 'warn', 'info', 'log', 'debug'] }, filter: str('Substring'), limit: num('Default 30'), clear: bool('Clear after reading') },
    run: async ({ level, filter, limit = 30, clear }) => {
      const { id } = await browser.currentTab();
      const rows = (browser.logs.get(id) || []).filter((m) => (!level || m.level === level) && (!filter || m.text.includes(filter)));
      if (clear) browser.logs.delete(id);
      return listing(rows, limit, (m) => `[${m.level}] ${m.text} (${m.source})`, 'No messages');
    },
  },
  network_log: {
    description: 'Requests made by the selected tab, newest last.',
    props: { filter: str('URL substring'), limit: num('Default 30'), clear: bool('Clear after reading') },
    run: async ({ filter, limit = 30, clear }) => {
      const { id } = await browser.currentTab();
      const rows = (browser.requests.get(id) || []).filter((r) => !filter || r.url.includes(filter));
      if (clear) browser.requests.delete(id);
      return listing(rows, limit, (r) => `${r.status} ${r.method} ${r.url.slice(0, 160)}`, 'No requests');
    },
  },
  ext_list: {
    description: 'Installed extensions with ids and moz-extension hosts.',
    run: async () => {
      const { addons } = await browser.rdp.send('root', 'listAddons', { iconDataURL: false });
      const rows = addons.filter((a) => !a.isSystem && !a.hidden);
      const hosts = await browser.chrome(`return Object.fromEntries(${J(rows.map((a) => a.id))}.map(i=>[i,WebExtensionPolicy.getByID(i)?.mozExtensionHostname||null]))`);
      return J(rows.map((a) => ({ id: a.id, name: a.name, temporary: a.temporarilyInstalled, host: hosts[a.id] })));
    },
  },
  ext_install: {
    description: 'Install an unpacked folder or .xpi as a temporary extension. It is reinstalled after browser_restart.',
    props: { path: str('Absolute path') },
    required: ['path'],
    run: async ({ path: addonPath }) => {
      const { addon } = await browser.rdp.send(browser.root.addonsActor, 'installTemporaryAddon', { addonPath, openDevTools: false });
      browser.tempAddons.set(addon.id, addonPath);
      browser.forgetExtContexts(addon.id);
      await sleep(600);
      return J({ id: addon.id, host: await browser.chrome(`return WebExtensionPolicy.getByID(${J(addon.id)})?.mozExtensionHostname`) });
    },
  },
  ext_reload: {
    description: 'Reload an extension from disk after editing it.',
    props: { id: str('Extension id') },
    required: ['id'],
    run: async ({ id }) => {
      const { addons } = await browser.rdp.send('root', 'listAddons', { iconDataURL: false });
      const addon = addons.find((a) => a.id === id);
      if (!addon) throw new Error(`Extension not installed: ${id}`);
      browser.forgetExtContexts(id);
      await browser.rdp.send(addon.actor, 'reload');
      await sleep(800);
      return 'Reloaded';
    },
  },
  ext_uninstall: {
    description: 'Uninstall an extension.',
    props: { id: str('Extension id') },
    required: ['id'],
    run: async ({ id }) => {
      await browser.chrome(`const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');const a=await AddonManager.getAddonByID(${J(id)});if(!a)throw new Error('Not installed');await a.uninstall();return true`);
      browser.tempAddons.delete(id);
      browser.forgetExtContexts(id);
      return 'Uninstalled';
    },
  },
  ext_open_popup: {
    description: 'Open an extension toolbar popup. Read it with ext_eval page="popup" and capture it with screenshot target="popup".',
    props: { id: str('Extension id') },
    required: ['id'],
    run: async ({ id }) => {
      await browser.chrome(`const {ExtensionParent}=ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
const ext=WebExtensionPolicy.getByID(${J(id)})?.extension;if(!ext)throw new Error('Extension not running');
const action=ExtensionParent.apiManager.global.browserActionFor(ext);if(!action)throw new Error('Extension has no toolbar action');
window.focus();await action.triggerAction(window);return true`);
      await browser.extTarget(id, 'popup').catch(() => {});
      for (let i = 0; i < 20; i++) {
        const targets = [...(browser.extEntry(id)?.targets.values() || [])];
        const popup = targets.reverse().find((t) => (t.url || '').startsWith('moz-extension://') && !BACKGROUND_URL.test(t.url));
        const ready = popup && await browser.run(popup.consoleActor, `document.readyState==='complete'&&!!document.body`).catch(() => false);
        if (ready) return 'Popup open';
        await sleep(150);
      }
      return 'Popup requested, but no popup document appeared';
    },
  },
  ext_eval: {
    description: 'Run JS inside an extension context with browser.* APIs. page is background (default), popup, or part of a page URL such as options.html.',
    props: { id: str('Extension id'), code: str('JavaScript'), page: str('Context'), max_chars: num('Default 6000') },
    required: ['id', 'code'],
    run: async ({ id, code, page = 'background', max_chars }) => {
      let target;
      if (page === 'popup') {
        await browser.extTarget(id, 'background').catch(() => {});
        target = [...(browser.extEntry(id)?.targets.values() || [])].reverse().find((t) => (t.url || '').startsWith('moz-extension://') && !BACKGROUND_URL.test(t.url));
        if (!target) throw new Error('No popup open; call ext_open_popup first');
      } else {
        target = await browser.extTarget(id, page);
      }
      return cap(J(await browser.run(target.consoleActor, code)), max_chars);
    },
  },
  chrome_css: {
    description: 'Apply browser UI CSS live. Pass css to preview it, reload_disk to re-read chrome/userChrome.css, or clear to remove what this tool applied.',
    props: { css: str('CSS text'), reload_disk: bool('Reload userChrome.css from the profile'), clear: bool('Remove applied sheets') },
    run: async ({ css, reload_disk, clear }) => browser.chrome(`const s=Cc['@mozilla.org/content/style-sheet-service;1'].getService(Ci.nsIStyleSheetService);
const store=(globalThis.__incognifoxSheets ||= {});
const drop=k=>{if(store[k]){s.unregisterSheet(store[k],s.USER_SHEET);delete store[k]}};
if(${!!clear}){drop('live');drop('disk');return 'Cleared'}
if(${J(css ?? null)}!==null){drop('live');store.live=Services.io.newURI('data:text/css;charset=utf-8,'+encodeURIComponent(${J(css ?? '')}));s.loadAndRegisterSheet(store.live,s.USER_SHEET)}
if(${!!reload_disk}){drop('disk');const f=Services.dirsvc.get('UChrm',Ci.nsIFile);f.append('userChrome.css');if(!f.exists())throw new Error('Missing '+f.path);store.disk=Services.io.newURI(Services.io.newFileURI(f).spec+'?v='+Date.now());s.loadAndRegisterSheet(store.disk,s.USER_SHEET)}
return 'Applied'`),
  },
};

const toolList = Object.entries(TOOLS).map(([name, tool]) => ({
  name,
  description: tool.description,
  inputSchema: { type: 'object', properties: tool.props || {}, ...(tool.required ? { required: tool.required } : {}) },
}));

function reply(id, result) { process.stdout.write(`${J({ jsonrpc: '2.0', id, result })}\n`); }
function replyError(id, code, message) { process.stdout.write(`${J({ jsonrpc: '2.0', id, error: { code, message } })}\n`); }

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    reply(id, { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'incognifox', version: '1.0.0' } });
  } else if (method === 'ping') {
    reply(id, {});
  } else if (method === 'tools/list') {
    reply(id, { tools: toolList });
  } else if (method === 'tools/call') {
    const tool = TOOLS[params?.name];
    if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`);
    try {
      await browser.ensure();
      const output = await tool.run(params.arguments || {});
      reply(id, typeof output === 'object' && output?.content ? output : { content: [{ type: 'text', text: String(output) }] });
    } catch (error) {
      reply(id, { isError: true, content: [{ type: 'text', text: String(error.message || error) }] });
    }
  } else if (id !== undefined) {
    replyError(id, -32601, `Method not found: ${method}`);
  }
  return undefined;
}

let queue = Promise.resolve();
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  queue = queue.then(() => handle(message)).catch(() => {});
});
input.on('close', () => {
  queue.then(() => browser.quit()).catch(() => {}).finally(() => process.exit(0));
});
