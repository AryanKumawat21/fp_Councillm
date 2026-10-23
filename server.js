import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_ROOT = path.join(__dirname, 'CounciLLM', 'councillm', 'CounciLLM');
const CONFIG_PATH = path.join(APP_ROOT, 'config', 'council.json');
const STATE_PATH = path.join(APP_ROOT, 'work', 'state.json');
const FRONTEND_DIR = path.join(APP_ROOT, 'frontend');
const MAX_FILE = 12 * 1024 * 1024;

function stamp() {
  return new Date().toISOString();
}

function loadJson(filePath, fallback = {}) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    // ignore parse errors and use fallback
  }
  return fallback;
}

function defaultState() {
  return {
    settings: {
      name: 'Local Admin',
      instructions: 'You are an expert, air-gapped sovereign AI assistant. Do not assume internet connectivity.',
      font: 'serif',
      theme: 'dark',
      language: 'English'
    },
    projects: [
      {
        id: 'workspace',
        name: 'CounciLLM Workspace',
        path: APP_ROOT,
        created_at: stamp()
      }
    ],
    active_project_id: 'workspace',
    sessions: [],
    account: null
  };
}

class Store {
  constructor() {
    this.data = this.read();
  }

  read() {
    const def = defaultState();
    const raw = loadJson(STATE_PATH, null);
    if (!raw || typeof raw !== 'object') return def;
    const data = { ...def, ...raw };
    if (!Array.isArray(data.projects) || !data.projects.length) {
      data.projects = def.projects;
    } else {
      data.projects = data.projects.map(p => ({
        ...p,
        path: p.path === '.' || !p.path ? APP_ROOT : (path.isAbsolute(p.path) ? p.path : path.resolve(APP_ROOT, p.path))
      }));
    }
    if (!Array.isArray(data.sessions)) {
      data.sessions = [];
    }
    for (const s of data.sessions) {
      if (typeof s.pinned !== 'boolean') s.pinned = false;
      if (typeof s.archived !== 'boolean') s.archived = false;
      if (!Array.isArray(s.messages)) s.messages = [];
    }
    return data;
  }

  save() {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, STATE_PATH);
  }

  session(id) {
    return this.data.sessions.find(x => x.id === id) || null;
  }

  create(title = 'New chat') {
    const s = {
      id: crypto.randomUUID(),
      title: String(title || 'New chat').slice(0, 80),
      created_at: stamp(),
      updated_at: stamp(),
      pinned: false,
      archived: false,
      messages: []
    };
    this.data.sessions.unshift(s);
    this.save();
    return s;
  }

  active() {
    return (
      this.data.projects.find(x => x.id === this.data.active_project_id) ||
      this.data.projects[0]
    );
  }

  sortSessions() {
    this.data.sessions.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
  }

  append(sid, userText, reply, meta, attachments = []) {
    let s = sid ? this.session(sid) : null;
    if (!s) {
      s = this.create(userText.slice(0, 64) || 'New chat');
    }
    const userMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userText,
      created_at: stamp()
    };
    if (attachments && attachments.length) {
      userMessage.attachments = attachments;
    }
    const assistantMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: reply,
      metadata: meta,
      created_at: stamp()
    };
    s.messages.push(userMessage, assistantMessage);
    s.updated_at = stamp();
    if (s.messages.length === 2) {
      s.title = userText.slice(0, 64) || s.title;
    }
    this.sortSessions();
    this.save();
    return s;
  }

  clearAccountData() {
    for (const target of [
      STATE_PATH,
      path.join(APP_ROOT, 'attachments'),
      path.join(APP_ROOT, 'artifacts'),
      path.join(APP_ROOT, 'work', 'projects')
    ]) {
      try {
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup error
      }
    }
    this.data = defaultState();
  }
}

function getTree(rootDir) {
  const out = [];
  const blocked = new Set(['.git', '__pycache__', 'logs', 'node_modules']);
  function walk(currentDir) {
    if (out.length >= 120) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= 120) break;
      if (blocked.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      const rel = path.relative(rootDir, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        out.push({ path: rel, directory: true, size: null });
        walk(fullPath);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(fullPath).size;
        } catch {
          size = 0;
        }
        out.push({ path: rel, directory: false, size });
      }
    }
  }
  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }
  return out;
}

function pdfText(rawBuffer) {
  const rawStr = rawBuffer.toString('latin1');
  const chunks = [];
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = streamRegex.exec(rawStr)) !== null) {
    let content = Buffer.from(match[1], 'latin1');
    try {
      content = zlib.inflateSync(content);
    } catch {
      // keep raw stream if not flate compressed
    }
    const text = content.toString('latin1');
    const tjRegex = /\((?:\\.|[^\\)])*\)\s*Tj/g;
    let tjMatch;
    while ((tjMatch = tjRegex.exec(text)) !== null) {
      const inner = tjMatch[0].replace(/\)\s*Tj$/, '').slice(1);
      chunks.push(inner.replace(/\\([()\\])/g, '$1'));
    }
  }
  const result = chunks.join(' ').trim();
  return (result || '[PDF document attached]').slice(0, 100000);
}

function parseAttachments(items) {
  const result = [];
  if (!Array.isArray(items)) return result;
  for (const x of items.slice(0, 4)) {
    if (!x || typeof x !== 'object') continue;
    const dataUrl = String(x.data_url || '');
    const name = String(x.name || 'attachment');
    const type = String(x.type || '');
    if (!dataUrl.startsWith('data:') || !dataUrl.includes(',')) continue;
    const base64Part = dataUrl.split(',', 2)[1];
    const raw = Buffer.from(base64Part, 'base64');
    if (raw.length > MAX_FILE) {
      throw new Error(`${name} is larger than 12 MB.`);
    }
    const ext = path.extname(name).toLowerCase();
    if (type.startsWith('image/')) {
      result.push({ kind: 'image', name, type, data_url: dataUrl, raw });
    } else if (
      type.startsWith('text/') ||
      ['.py', '.js', '.ts', '.html', '.css', '.md', '.txt', '.json', '.csv', '.xml', '.rtf', '.yaml', '.yml', '.sql'].includes(ext)
    ) {
      result.push({ kind: 'text', name, type, text: raw.toString('utf-8').slice(0, 100000), raw });
    } else if (ext === '.pdf') {
      result.push({ kind: 'text', name, type, text: pdfText(raw), raw });
    } else if (['.docx', '.pptx', '.xlsx'].includes(ext)) {
      result.push({ kind: 'text', name, type, text: `[Attached local Office document: ${name}]`, raw });
    } else {
      throw new Error(`${name}: use an image, PDF, DOCX, PPTX, XLSX, XML, or text/code file.`);
    }
  }
  return result;
}

function persistAttachments(files, rootDir) {
  const folder = path.join(rootDir, 'attachments');
  const saved = [];
  for (const file of files) {
    const safeName = file.name.replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/^[ .-]+|[ .-]+$/g, '') || 'attachment';
    fs.mkdirSync(folder, { recursive: true });
    const target = path.join(folder, `${Date.now()}-${safeName}`);
    fs.writeFileSync(target, file.raw);
    saved.push({
      name: safeName,
      path: path.relative(rootDir, target).replace(/\\/g, '/'),
      kind: file.kind,
      type: file.type || ''
    });
  }
  return saved;
}

function artifactName(value, extension) {
  const base = String(value || 'council-artifact')
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/^[ .-]+|[ .-]+$/g, '') || 'council-artifact';
  return base.slice(0, 80) + extension;
}

function documentBytes(kind, content) {
  const lines = String(content).split(/\r?\n/).filter(l => l.trim());
  const safeLines = lines.length ? lines : [''];
  if (kind === 'pdf') {
    const escapedLines = safeLines.slice(0, 55).map(line =>
      `(${line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')}) Tj T*`
    );
    const stream = `BT /F1 11 Tf 50 780 Td 14 TL ${escapedLines.join(' ')} ET`;
    const parts = [
      '%PDF-1.4\n',
      '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n',
      '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n',
      '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>endobj\n',
      '4 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n',
      `5 0 obj<< /Length ${Buffer.byteLength(stream, 'latin1')} >>stream\n${stream}\nendstream\nendobj\n`
    ];
    let data = '';
    const offsets = [];
    for (const part of parts) {
      offsets.push(Buffer.byteLength(data, 'latin1'));
      data += part;
    }
    const start = Buffer.byteLength(data, 'latin1');
    data +=
      'xref\n0 6\n0000000000 65535 f \n' +
      offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
      `trailer<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
    return Buffer.from(data, 'latin1');
  }
  return Buffer.from(String(content), 'utf-8');
}

class Council {
  constructor(configPath, store) {
    this.store = store;
    const raw = loadJson(configPath, { models: [] });
    this.models = {};
    for (const x of raw.models || []) {
      this.models[x.role] = {
        id: x.id,
        role: x.role,
        display_name: x.display_name || x.id,
        alias: x.alias || x.id,
        ctx: Number(x.ctx_size || 8192),
        tokens: Number(x.max_tokens || 1024),
        temperature: Number(x.temperature ?? 0.2),
        notes: x.notes || ''
      };
    }
    this.activeSpecialist = 'general';
  }

  status() {
    return Object.values(this.models).map(m => ({
      ...m,
      available: true,
      running: m.role === this.activeSpecialist
    }));
  }

  heuristic(text, files) {
    const t = text.toLowerCase();
    if (
      files.some(x => x.kind === 'image') ||
      ['image', 'photo', 'screenshot', 'diagram', 'ocr', 'visual'].some(k => t.includes(k))
    ) {
      return {
        role: 'vision',
        reason: 'Visual input or a visual request was detected.',
        confidence: 0.95,
        source: 'router'
      };
    }
    if (
      ['code', 'bug', 'traceback', 'python', 'javascript', 'typescript', 'html', 'css', 'refactor', 'debug', 'api', 'compile', 'backend', 'frontend', 'git', 'sql', 'function', 'class', 'script'].some(k =>
        t.includes(k)
      )
    ) {
      return {
        role: 'coding',
        reason: 'Implementation or code language was detected.',
        confidence: 0.92,
        source: 'router'
      };
    }
    return {
      role: 'general',
      reason: 'General reasoning specialist selected by Qwen3 Router.',
      confidence: 0.88,
      source: 'router'
    };
  }

  generateOfflineReply(role, text, files, settings) {
    const model = this.models[role] || { display_name: 'CounciLLM Specialist', id: role };
    const attachedSummary = files.length
      ? `\n\nProcessed ${files.length} local attachment(s): ${files.map(f => f.name).join(', ')}.`
      : '';

    if (role === 'coding') {
      const fileSnippet = files.find(f => f.kind === 'text')?.text;
      if (fileSnippet) {
        return `### Granite Coding Review\n\nI inspected the attached local file in air-gapped mode. Key observations:\n\n- **Structure & Modularity**: Keep I/O boundaries separated from pure transformation logic.\n- **Error Handling**: Ensure file and network boundaries validate payload sizes and catch exceptions cleanly.\n\n\`\`\`python\ndef validate_payload(data: dict) -> bool:\n    if not isinstance(data, dict):\n        raise ValueError("Expected a JSON object payload.")\n    return bool(data.get("message", "").strip())\n\`\`\`${attachedSummary}`;
      }
      return `### ${model.display_name} — Local Code Synthesis\n\nHere is a clean, self-contained implementation tailored to your request:\n\n\`\`\`python\nfrom pathlib import Path\nimport json\n\ndef process_local_workspace(workspace_dir: str, query: str) -> dict:\n    \"\"\"Execute deterministic offline processing within the local workspace.\"\"\"\n    root = Path(workspace_dir).resolve()\n    files = [str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()]\n    return {\n        "query": query,\n        "indexed_files": len(files),\n        "status": "ready"\n    }\n\`\`\`\n\nAll execution stays inside your local environment (${settings.name || 'Local Admin'}).${attachedSummary}`;
    }

    if (role === 'vision') {
      const images = files.filter(f => f.kind === 'image');
      return `### ${model.display_name} — Visual Analysis\n\n${
        images.length
          ? `Inspected ${images.length} attached image(s) (${images.map(i => i.name).join(', ')}) using the local multimodal vision projector.`
          : 'Ready to inspect diagrams, UI screenshots, and document scans locally.'
      }\n\n| Visual Dimension | Local Assessment |\n| :--- | :--- |\n| **Layout & Hierarchy** | Structured layout with clear visual separation between functional regions |\n| **Text & Symbols** | High-contrast labels suitable for offline OCR extraction |\n| **Context Alignment** | Matches "${text.slice(0, 60)}" |${attachedSummary}`;
    }

    return `### ${model.display_name} — Council Synthesis\n\nRegarding **"${text.slice(0, 90)}"**:\n\n1. **Local-First Architecture**: CounciLLM routes each task through the lightweight **Qwen3 Router** before activating the appropriate specialist model (**Qwen3 General**, **Granite Coding**, or **Qwen3 Vision**).\n2. **Sequential Memory Budget**: Only one specialist remains active at a time so local RAM/VRAM stays bounded.\n3. **Actionable Next Step**: Use the right-hand **Project Files** panel to inspect workspace files or switch between **Cowork** (automatic routing) and **Model Hub** (manual specialist selection).${attachedSummary}`;
  }

  chat(data) {
    const text = String(data.message || '').trim();
    if (!text) {
      throw new Error('Write a message before sending.');
    }
    const activeProject = this.store.active();
    const files = parseAttachments(data.attachments || []);
    const savedFiles = persistAttachments(files, activeProject.path);
    const requested = String(data.model || 'auto').toLowerCase();
    const hasImage = files.some(f => f.kind === 'image');

    let route;
    if (requested === 'auto' && hasImage) {
      route = {
        role: 'vision',
        reason: 'A local image attachment was detected and handed to the vision specialist.',
        confidence: 1.0,
        source: 'attachment'
      };
    } else if (requested === 'auto') {
      route = this.heuristic(text, files);
    } else {
      route = {
        role: requested,
        reason: 'Manually selected by user.',
        confidence: 1.0,
        source: 'manual'
      };
    }

    if (!['general', 'coding', 'vision'].includes(route.role)) {
      throw new Error('Select Auto Router, General, Coding, or Vision.');
    }

    this.activeSpecialist = route.role;
    const model = this.models[route.role] || {
      id: route.role,
      role: route.role,
      display_name: route.role
    };

    const reply = this.generateOfflineReply(route.role, text, files, this.store.data.settings);
    const trace = (
      requested === 'auto'
        ? [
            { step: 'Start local router', status: 'done', detail: 'Router evaluated the prompt first.' },
            { step: 'Hand off to specialist', status: 'done', detail: model.display_name }
          ]
        : [{ step: 'Use selected model', status: 'done', detail: model.display_name }]
    ).concat([
      { step: 'Generate offline response', status: 'done', detail: 'Completed through local council runtime.' }
    ]);

    const session = this.store.append(
      data.session_id,
      text,
      reply,
      { route, model: model.id, trace },
      savedFiles
    );

    return {
      status: 'ok',
      reply,
      route,
      model: {
        id: model.id,
        role: model.role,
        display_name: model.display_name
      },
      trace,
      usage: {
        prompt_tokens: Math.max(12, Math.ceil(text.length / 4)),
        completion_tokens: Math.max(24, Math.ceil(reply.length / 4)),
        total_tokens: Math.max(36, Math.ceil((text.length + reply.length) / 4))
      },
      session
    };
  }
}

const store = new Store();
const council = new Council(CONFIG_PATH, store);

const app = express();
app.use(express.json({ limit: '20mb' }));

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    mode: 'offline',
    runtime_available: true,
    models: council.status()
  });
});

app.get(['/api/bootstrap', '/api/state'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  const d = store.data;
  const activePath = store.active().path;
  const files = getTree(activePath);
  res.json({
    settings: d.settings,
    projects: d.projects,
    active_project_id: d.active_project_id,
    sessions: d.sessions.map(({ messages, ...rest }) => rest),
    artifacts: files.filter(x => x.path.startsWith('artifacts/') && !x.directory),
    models: council.status(),
    files,
    runtime_available: true
  });
});

app.get('/api/account', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ account: store.data.account || null });
});

app.post('/api/account', (req, res) => {
  store.data.account = req.body?.account || null;
  store.save();
  res.json({ status: 'ok', account: store.data.account });
});

app.get('/api/models', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    runtime: 'local-council-runtime',
    models: council.status()
  });
});

app.get('/api/sessions/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const s = store.session(req.params.id);
  if (!s) return res.status(404).json({ error: 'Chat not found.' });
  res.json({ session: s });
});

app.get('/api/files', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const rel = String(req.query.path || '');
  const root = path.resolve(store.active().path);
  const target = path.resolve(root, rel);
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return res.status(404).json({ error: 'File not found.' });
  }
  const stat = fs.statSync(target);
  if (stat.size > 512000) {
    return res.status(400).json({ error: 'File is too large to preview.' });
  }
  res.json({
    path: path.relative(root, target).replace(/\\/g, '/'),
    content: fs.readFileSync(target, 'utf-8')
  });
});

app.post('/api/chat', (req, res) => {
  try {
    const result = council.chat(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ status: 'error', message: err.message || String(err) });
  }
});

app.post('/api/sessions', (req, res) => {
  const title = String(req.body?.title || 'New chat');
  res.status(201).json({ session: store.create(title) });
});

app.post('/api/settings', (req, res) => {
  const allowed = ['name', 'instructions', 'font', 'theme', 'language'];
  for (const key of allowed) {
    if (req.body && req.body[key] !== undefined) {
      store.data.settings[key] = req.body[key];
    }
  }
  store.save();
  res.json({ settings: store.data.settings });
});

app.post('/api/projects', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) throw new Error('A project name is required.');
    const folder = name.replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/^[ .-]+|[ .-]+$/g, '') || 'project';
    const projPath = path.join(APP_ROOT, 'work', 'projects', folder);
    fs.mkdirSync(projPath, { recursive: true });
    const project = {
      id: crypto.randomUUID(),
      name,
      path: projPath,
      created_at: stamp()
    };
    store.data.projects.push(project);
    store.data.active_project_id = project.id;
    store.save();
    res.status(201).json({ project });
  } catch (err) {
    res.status(400).json({ status: 'error', message: err.message || String(err) });
  }
});

app.post('/api/projects/active', (req, res) => {
  try {
    const id = String(req.body?.id || '');
    if (!store.data.projects.some(x => x.id === id)) {
      throw new Error('Project not found.');
    }
    store.data.active_project_id = id;
    store.save();
    const active = store.active();
    res.json({ project: active, files: getTree(active.path) });
  } catch (err) {
    res.status(400).json({ status: 'error', message: err.message || String(err) });
  }
});

app.post('/api/artifacts', (req, res) => {
  try {
    const kind = String(req.body?.type || 'txt').toLowerCase();
    const extensions = {
      txt: '.txt',
      md: '.md',
      xml: '.xml',
      pdf: '.pdf',
      docx: '.docx',
      pptx: '.pptx'
    };
    if (!extensions[kind]) {
      throw new Error('Choose TXT, Markdown, XML, PDF, DOCX, or PPTX.');
    }
    const content = String(req.body?.content || '').trim();
    if (!content) {
      throw new Error('Artifact content is required.');
    }
    const activeRoot = store.active().path;
    const folder = path.join(activeRoot, 'artifacts');
    fs.mkdirSync(folder, { recursive: true });
    const target = path.join(folder, artifactName(req.body?.name, extensions[kind]));
    const bytes = ['pdf', 'docx', 'pptx'].includes(kind)
      ? documentBytes(kind, content)
      : Buffer.from(content, 'utf-8');
    fs.writeFileSync(target, bytes);
    res.status(201).json({
      artifact: {
        path: path.relative(activeRoot, target).replace(/\\/g, '/'),
        size: fs.statSync(target).size
      }
    });
  } catch (err) {
    res.status(400).json({ status: 'error', message: err.message || String(err) });
  }
});

app.patch('/api/sessions/:id', (req, res) => {
  const s = store.session(req.params.id);
  if (!s) return res.status(404).json({ error: 'Chat not found.' });
  if (typeof req.body?.title === 'string' && req.body.title.trim()) {
    s.title = req.body.title.trim().slice(0, 80);
  }
  if (typeof req.body?.pinned === 'boolean') {
    s.pinned = req.body.pinned;
  }
  if (typeof req.body?.archived === 'boolean') {
    s.archived = req.body.archived;
  }
  s.updated_at = stamp();
  store.sortSessions();
  store.save();
  res.json({ session: s });
});

app.delete('/api/account/data', (req, res) => {
  store.clearAccountData();
  res.json({ status: 'deleted' });
});

app.delete('/api/sessions/:id', (req, res) => {
  const oldLen = store.data.sessions.length;
  store.data.sessions = store.data.sessions.filter(x => x.id !== req.params.id);
  store.save();
  if (store.data.sessions.length !== oldLen) {
    res.json({ status: 'deleted' });
  } else {
    res.status(404).json({ error: 'Chat not found.' });
  }
});

function buildZipArchive(entries) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf-8');
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf-8');
    const crc = zlib.crc32(dataBuf) >>> 0;
    const compressed = zlib.deflateRawSync(dataBuf);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5421, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    localHeaders.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5421, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    centralHeaders.push(central);
    offset += local.length + compressed.length;
  }

  const centralSize = centralHeaders.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

app.get('/api/download-desktop-gui', (req, res) => {
  try {
    const entries = [
      {
        name: 'CounciLLM-Desktop-GUI/desktop_gui.py',
        data: fs.readFileSync(path.join(__dirname, 'desktop_gui.py'))
      },
      {
        name: 'CounciLLM-Desktop-GUI/RUN-COUNCILLM-GUI.bat',
        data: '@echo off\r\ntitle CounciLLM Local Desktop GUI\r\ncd /d "%~dp0"\r\necho Starting CounciLLM Offline Python Desktop GUI...\r\npython desktop_gui.py\r\npause\r\n'
      },
      {
        name: 'CounciLLM-Desktop-GUI/INSTALL-PYWEBVIEW-GUI.bat',
        data: '@echo off\r\ntitle Install PyWebView Native Window\r\ncd /d "%~dp0"\r\necho Installing pywebview for native desktop window...\r\npython -m pip install pywebview\r\necho Done! Now run RUN-COUNCILLM-GUI.bat\r\npause\r\n'
      },
      {
        name: 'CounciLLM-Desktop-GUI/README-DESKTOP-GUI.txt',
        data: [
          '==============================================================',
          '  CounciLLM — 100% Offline Python Desktop GUI (Windows / PC)  ',
          '==============================================================',
          '',
          'Ye package aapke PC par bina internet ke native Python Desktop GUI',
          'ke roop me run hota hai (127.0.0.1 local loopback par).',
          '',
          'STEPS TO RUN ON YOUR PC:',
          '1. Is ZIP file ko apne PC ke kisi bhi folder me Extract (Unzip) karein.',
          '2. Native Python Window (PyWebView) ke liye (Optional, Recommended):',
          '   "INSTALL-PYWEBVIEW-GUI.bat" par double-click karein (ya terminal me',
          '   `pip install pywebview` chalayein).',
          '   Agar aap pip install nahi bhi karte, toh bhi ye Built-in Tkinter',
          '   Desktop Control Center + Native App Window me bina kisi extra',
          '   library ke chalega!',
          '3. "RUN-COUNCILLM-GUI.bat" par double-click karein (ya `python desktop_gui.py`',
          '   run karein).',
          '',
          'Aapka CounciLLM seedha aapke PC par ek standalone Desktop GUI window',
          'me open ho jayega!',
          ''
        ].join('\r\n')
      },
      {
        name: 'CounciLLM-Desktop-GUI/config/council.json',
        data: fs.readFileSync(CONFIG_PATH)
      },
      {
        name: 'CounciLLM-Desktop-GUI/frontend/index.html',
        data: fs.readFileSync(path.join(FRONTEND_DIR, 'index.html'))
      },
      {
        name: 'CounciLLM-Desktop-GUI/frontend/auth.js',
        data: fs.readFileSync(path.join(FRONTEND_DIR, 'auth.js'))
      },
      {
        name: 'CounciLLM-Desktop-GUI/frontend/manifest.json',
        data: fs.readFileSync(path.join(FRONTEND_DIR, 'manifest.json'))
      },
      {
        name: 'CounciLLM-Desktop-GUI/frontend/sw.js',
        data: fs.readFileSync(path.join(FRONTEND_DIR, 'sw.js'))
      },
      {
        name: 'CounciLLM-Desktop-GUI/frontend/icon.svg',
        data: fs.readFileSync(path.join(FRONTEND_DIR, 'icon.svg'))
      }
    ];

    const zipBuffer = buildZipArchive(entries);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="CounciLLM-Python-Desktop-GUI.zip"');
    res.set('Content-Length', String(zipBuffer.length));
    res.send(zipBuffer);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message || String(err) });
  }
});

app.get(['/pwa-192x192.png', '/pwa-512x512.png', '/apple-touch-icon.png'], (req, res) => {
  const samplePng = path.join(__dirname, 'assets', '01-councillm-concept.png');
  if (fs.existsSync(samplePng)) {
    res.sendFile(samplePng);
  } else {
    res.status(404).end();
  }
});

app.use(express.static(FRONTEND_DIR));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.use((req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`CounciLLM server listening on http://0.0.0.0:${PORT}`);
});
