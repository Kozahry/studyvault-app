import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { parseAssessabilityDoc, mergeAssessabilityResults } from './assessability.js';

const API = "https://api.anthropic.com/v1/messages";
const DEFAULT_EXTRACT = "claude-sonnet-4-20250514";
const DEFAULT_CLASSIFY = "claude-opus-4-20250514";
const DEFAULT_SOLVE = "claude-haiku-4-5-20251001";

const MODEL_OPTIONS = [
  { id: "claude-opus-4-20250514", label: "Opus 4", tier: "expensive" },
  { id: "claude-sonnet-4-20250514", label: "Sonnet 4", tier: "mid" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", tier: "cheap" },
];

function getModelSetting(key, fallback) {
  try { return localStorage.getItem(`sv:model:${key}`) || fallback; } catch { return fallback; }
}
function setModelSetting(key, val) {
  try { localStorage.setItem(`sv:model:${key}`, val); } catch {}
}

// API key: reads from env var (Vite) or localStorage
function getApiKey() {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ANTHROPIC_API_KEY) return import.meta.env.VITE_ANTHROPIC_API_KEY;
  try { return localStorage.getItem("sv:api_key") || ""; } catch { return ""; }
}
function apiHeaders() {
  const key = getApiKey();
  const h = { "Content-Type": "application/json" };
  if (key) { h["x-api-key"] = key; h["anthropic-version"] = "2023-06-01"; h["anthropic-dangerous-direct-browser-access"] = "true"; }
  return h;
}
const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";
const JSPDF_CDN = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const KATEX_JS = "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js";
const KATEX_CSS = "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css";
const uid = () => Math.random().toString(36).slice(2, 10);
const baseQNum = qn => String(qn).replace(/[a-z]+$/i, "");
function base64ToBytes(b64) { const bin = atob(b64), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return bytes; }
async function callClaude(model, messages, maxTokens = 4096) {
  const resp = await fetch(API, { method: "POST", headers: apiHeaders(), body: JSON.stringify({ model, max_tokens: maxTokens, messages }) });
  const data = await resp.json();
  if (data.type === "error") throw new Error(data.error?.message || "API error");
  return data.content?.map(c => c.text || "").join("") || "";
}
function parseJsonResponse(text) { return JSON.parse((text || "[]").replace(/```json|```/g, "").trim()); }
const SEMESTERS = ["Semester 1","Semester 2","Summer Semester"];
const CHART_COLORS = ["#e8c170","#34d399","#60a5fa","#f87171","#a78bfa","#fb923c","#2dd4bf","#f472b6","#a3e635","#38bdf8","#c084fc","#fbbf24"];

// ─── Persistent Storage Helpers (localStorage) ────────────────────
async function storageSet(key, value) {
  try { localStorage.setItem(`sv:${key}`, JSON.stringify(value)); } catch(e) { console.warn("Storage set error:", key, e); }
}
async function storageGet(key) {
  try { const r = localStorage.getItem(`sv:${key}`); return r ? JSON.parse(r) : null; } catch(e) { return null; }
}
async function storageDel(key) {
  try { localStorage.removeItem(`sv:${key}`); } catch(e) { /* ignore */ }
}
async function storageListKeys(prefix) {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`sv:${prefix}`)) keys.push(k.slice(3));
    }
    return keys;
  } catch(e) { return []; }
}

// Serialize subjects for storage (strip large transient data)
function serializeSubjects(subjects) {
  const out = {};
  for (const [name, data] of Object.entries(subjects)) {
    out[name] = {
      courseCode: data.courseCode || "",
      assessability: data.assessability || null,
      questions: data.questions,
      papers: data.papers.map(p => ({
        id: p.id, name: p.name, stdName: p.stdName, courseCode: p.courseCode,
        yearLevel: p.yearLevel, semester: p.semester, year: p.year, pageCount: p.pageCount,
        // pageImages and blobUrl are transient — rebuilt on load
      })),
    };
  }
  return out;
}

// Rebuild transient paper data (blobUrl, pageImages) from stored PDF base64
async function rebuildPaperData(paper, pdfData) {
  let pageImages = [];
  let blobUrl = "";
  if (pdfData) {
    try {
      const bytes = base64ToBytes(pdfData.base64);
      const blob = new Blob([bytes], { type: pdfData.mediaType || "application/pdf" });
      blobUrl = URL.createObjectURL(blob);
      if (pdfData.mediaType?.startsWith("image/")) {
        pageImages = [{ dataUrl: `data:${pdfData.mediaType};base64,${pdfData.base64}`, width: 800, height: 1100 }];
      } else if (window.pdfjsLib) {
        try { pageImages = await renderPdfPages(pdfData.base64, 1.5); } catch(e) { console.warn("Re-render failed for", paper.name, e); }
      }
    } catch(e) { console.warn("Rebuild failed for", paper.name, e); }
  }
  return { ...paper, blobUrl, pageImages: pageImages.length ? pageImages : paper.pageImages || [] };
}

function detectYearSemCode(f) {
  // Matches patterns like 20221 (2022 Sem1), 20252 (2025 Sem2), 2024s (2024 Summer)
  const m = f.match(/(20\d{2})([12s])(?=[^0-9]|$)/i);
  if (!m) return null;
  const year = m[1];
  const code = m[2].toLowerCase();
  const semester = code === "1" ? "Semester 1" : code === "2" ? "Semester 2" : "Summer";
  return { year, semester };
}
function detectSemester(f) {
  const coded = detectYearSemCode(f);
  if (coded) return coded.semester;
  f = f.toLowerCase();
  if (/summer|sum\s*sem/i.test(f)) return "Summer";
  if (/sem(ester)?\s*1|s1[^0-9]|first\s*sem/i.test(f)) return "Semester 1";
  if (/sem(ester)?\s*2|s2[^0-9]|second\s*sem/i.test(f)) return "Semester 2";
  if (/mid[-\s]?term/i.test(f)) return "Midterm";
  if (/final/i.test(f)) return "Final";
  if (/spring/i.test(f)) return "Spring";
  if (/fall|autumn/i.test(f)) return "Fall";
  if (/winter/i.test(f)) return "Winter";
  if (/suppl/i.test(f)) return "Supplementary";
  return "";
}
function detectYear(f) {
  const coded = detectYearSemCode(f);
  if (coded) return coded.year;
  const m = f.match(/(20\d{2})/);
  return m ? m[1] : "";
}
function detectCourseCode(f) { const m = f.match(/([A-Z]{2,6}\s?\d{3,5})/i); return m ? m[1].toUpperCase().replace(/\s/g,"") : ""; }
function detectYearLevel(code) { if (!code) return ""; const m = code.match(/[A-Z]+(\d)/i); return m ? m[1] : ""; }
function shortSem(sem) {
  if (!sem) return "";
  if (/^Semester\s*1$/i.test(sem)) return "Semester 1";
  if (/^Semester\s*2$/i.test(sem)) return "Semester 2";
  if (/^Summer$/i.test(sem)) return "Summer Semester";
  return sem;
}
function buildStdName(code, level, sem, year, orig) {
  const parts = [];
  if (year) parts.push(year);
  if (sem) parts.push(shortSem(sem));
  if (parts.length) return parts.join(" ");
  return orig.replace(/\.[^.]+$/, "");
}
function getTagColor(tag) {
  let h = 0; for (let i = 0; i < tag.length; i++) h = tag.charCodeAt(i) + ((h << 5) - h);
  const hue = Math.abs(h) % 360;
  return { bg: `hsl(${hue},25%,14%)`, text: `hsl(${hue},65%,72%)`, border: `hsl(${hue},40%,30%)` };
}
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error(src)); document.head.appendChild(s);
  });
}
function loadCSS(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; document.head.appendChild(l);
}
async function renderPdfPages(b64, scale = 1.5) {
  if (!window.pdfjsLib) throw new Error("PDF.js not loaded");
  const bytes = base64ToBytes(b64);
  const loadingTask = window.pdfjsLib.getDocument({ data: bytes.buffer });
  const pdf = await loadingTask.promise;
  const pages = [];
  const numPages = pdf.numPages;
  // Use lower scale for large documents to prevent memory issues
  const effectiveScale = numPages > 20 ? 1.0 : numPages > 10 ? 1.2 : scale;
  for (let i = 1; i <= numPages; i++) {
    try {
      const pg = await pdf.getPage(i);
      const vp = pg.getViewport({ scale: effectiveScale });
      const c = document.createElement("canvas");
      c.width = vp.width; c.height = vp.height;
      const ctx = c.getContext("2d");
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      pages.push({ dataUrl: c.toDataURL("image/jpeg", 0.85), width: vp.width, height: vp.height });
      // Free canvas memory
      c.width = 0; c.height = 0;
    } catch(pageErr) {
      console.warn(`Failed to render page ${i}:`, pageErr);
    }
  }
  return pages;
}
function cropRegion(pageUrl, ys, ye) {
  return new Promise(res => {
    const img = new Image(); img.onload = () => {
      const y0 = Math.max(0, (ys/100)*img.height - 20), y1 = Math.min(img.height, (ye/100)*img.height + 20), h = y1 - y0;
      const c = document.createElement("canvas"); c.width = img.width; c.height = h;
      const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0,0,c.width,c.height);
      ctx.drawImage(img, 0, y0, img.width, h, 0, 0, img.width, h);
      res({ dataUrl: c.toDataURL("image/jpeg", 0.92), width: img.width, height: h });
    }; img.src = pageUrl;
  });
}
async function generatePdf(questions, pMap) {
  const { jsPDF } = window.jspdf, doc = new jsPDF({ unit: "pt", format: "a4" });
  const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight(), m = 36;
  let y = m, first = true;
  for (const q of questions) {
    const paper = pMap[q.paperId]; if (!paper?.pageImages?.length) continue;
    const pi = Math.max(0, (q.page_number||1)-1); if (pi >= paper.pageImages.length) continue;
    try {
      const cr = await cropRegion(paper.pageImages[pi].dataUrl, q.vertical_start??0, q.vertical_end??100);
      const iw = pw - m*2, ih = iw / (cr.width/cr.height);
      if (!first && y + ih + 24 > ph - m) { doc.addPage(); y = m; }
      doc.setFontSize(7); doc.setTextColor(160); doc.text(`Q${q.question_number} | ${q.paperName} | ${q.tags?.join(", ")||""}`, m, y+8); y += 14;
      doc.addImage(cr.dataUrl, "JPEG", m, y, iw, ih); y += ih + 10;
      doc.setDrawColor(230); doc.line(m, y, pw-m, y); y += 12; first = false;
    } catch(e) { console.error(e); }
  }
  return doc.output("bloburl");
}
// Pass 1: Extract raw questions + paper metadata from PDF using Sonnet (cheap, vision-capable)
async function extractRawQuestions(b64, mediaType) {
  const isImg = mediaType.startsWith("image/");
  const text = await callClaude(getModelSetting("extract", DEFAULT_EXTRACT), [{ role: "user", content: [
    { type: isImg ? "image" : "document", source: { type: "base64", media_type: mediaType, data: b64 } },
    { type: "text", text: `You are an expert exam paper analyzer. Extract paper metadata and EVERY question.
Respond ONLY with a JSON object (no markdown, no backticks):
{
  "paper": {
    "semester": "Semester 1"|"Semester 2"|"Summer"|"Midterm"|"Final"|"" (detect from header/title),
    "year": "2024" (detect year from header/title),
    "course_code": "MATH2001" or "" (detect from header/title)
  },
  "questions": [
    {
      "question_number": "1" or "1a" etc,
      "question_text": "full question text with ALL mathematical expressions written in LaTeX notation using $...$ for inline math and $$...$$ for display math. For example: Find $\\\\int_0^1 x^2 \\\\, dx$ or $$\\\\frac{d}{dx}\\\\left(x^2 + 3x\\\\right)$$. Preserve ALL original formatting, sub-parts, and given information. Use LaTeX for ALL math: fractions, integrals, summations, matrices, Greek letters, superscripts, subscripts, etc.",
      "marks": number or null,
      "page_number": 1-indexed page number,
      "vertical_start": percentage 0-100 from top where question starts,
      "vertical_end": percentage 0-100 from top where question ends
    }
  ]
}
CRITICAL: Write ALL math using LaTeX inside $...$ delimiters. Every fraction, integral, derivative, equation, variable, exponent, matrix, etc. must be LaTeX. Non-math text stays as plain text. Be precise with page positions. Detect semester/year/course code from the exam paper header. Respond ONLY with JSON object.` }
  ]}]);
  const parsed = parseJsonResponse(text);
  // Handle both new format {paper, questions} and legacy array format
  if (Array.isArray(parsed)) return { paper: {}, questions: parsed };
  return { paper: parsed.paper || {}, questions: parsed.questions || [] };
}

// Pass 2: Classify questions with Opus (expensive, highest quality tags/topics)
// Processes in chunks to avoid output token truncation on large exams
async function classifyQuestions(rawQuestions) {
  const CHUNK_SIZE = 15;
  const allClassifications = [];
  for (let start = 0; start < rawQuestions.length; start += CHUNK_SIZE) {
    const chunk = rawQuestions.slice(start, start + CHUNK_SIZE);
    const questionsText = chunk.map((q, ci) => `[${start + ci}] Q${q.question_number}: ${q.question_text}`).join("\n\n");
    const text = await callClaude(getModelSetting("classify", DEFAULT_CLASSIFY), [{ role: "user",
      content: `You are an expert academic classifier. For each question below, provide tags, parent topics, difficulty, and primary topic.

Questions:
${questionsText}

Respond ONLY with a JSON array (no markdown, no backticks). One element per question, in the SAME order:
{
  "index": ${start},
  "tags": ["specific_tag1","specific_tag2","specific_tag3"] 2-6 specific topic tags,
  "parent_topics": {"specific_tag1":"ParentTopic","specific_tag2":"ParentTopic"} map each tag to an overarching parent topic category (e.g. "definite integrals"->"Integration", "eigenvalues"->"Linear Algebra", "Bayes theorem"->"Probability"),
  "difficulty": "easy"|"medium"|"hard",
  "topic": "primary broad topic"
}
Group related tags under consistent parent names. Be specific with tags but consistent across questions. Respond ONLY with JSON array.`
    }], 4096);
    allClassifications.push(...parseJsonResponse(text));
  }
  return allClassifications;
}

// Combined two-pass extraction: Sonnet extracts, Opus classifies
async function extractQuestions(b64, mediaType, onProgress) {
  if (onProgress) onProgress("Extracting text...");
  const { paper: paperMeta, questions: raw } = await extractRawQuestions(b64, mediaType);
  if (!raw.length) return { paperMeta, questions: [] };
  if (onProgress) onProgress("Classifying & tagging...");
  const classifications = await classifyQuestions(raw);
  const clsMap = {};
  classifications.forEach(c => { if (c.index != null) clsMap[c.index] = c; });
  const questions = raw.map((q, i) => {
    const cls = clsMap[i] || {};
    return { ...q, tags: cls.tags || [], parent_topics: cls.parent_topics || {}, difficulty: cls.difficulty || "medium", topic: cls.topic || "" };
  });
  return { paperMeta, questions };
}

async function solveQuestion(text, tags) {
  return callClaude(getModelSetting("solve", DEFAULT_SOLVE), [{ role: "user",
    content: `Expert tutor. Solve step-by-step. Use LaTeX notation for ALL math: $...$ for inline, $$...$$ for display equations.\n\nQuestion: ${text}\nTopics: ${tags.join(", ")}\n\nProvide: 1) Step-by-step solution with LaTeX math 2) Final answer marked with $$...$$ 3) Key concepts 4) Common mistakes. Write every equation, fraction, integral, derivative, variable in LaTeX.`
  }]);
}

// ─── Weight calculation ────────────────────────────────────────────
function calcWeights(papers, mode, params) {
  if (!papers.length) return {};
  const years = papers.map(p => parseInt(p.year) || 2020).sort((a,b) => a-b);
  const minY = years[0], maxY = years[years.length-1], span = maxY - minY || 1;
  const w = {};
  papers.forEach(p => {
    const yr = parseInt(p.year) || 2020;
    const age = maxY - yr;
    if (mode === "linear") { w[p.id] = Math.max(params.minWeight || 0.2, 1 - (age / span) * (1 - (params.minWeight || 0.2))); }
    else if (mode === "exponential") { w[p.id] = Math.pow(params.decay || 0.8, age); }
    else if (mode === "custom") { w[p.id] = params.custom?.[p.id] ?? 1; }
    else { w[p.id] = 1; }
  });
  return w;
}

// ─── Study planner calc ────────────────────────────────────────────
function calcStudyPlan(questions, papers, weights, hierarchy) {
  const parentTopics = Object.keys(hierarchy);
  if (!parentTopics.length) return [];
  const totalExams = papers.length || 1;
  const diffScore = { easy: 1, medium: 2, hard: 3 };
  const entries = parentTopics.map(pt => {
    const childTags = hierarchy[pt] || [];
    const matching = questions.filter(q => q.tags?.some(t => childTags.includes(t)));
    if (!matching.length) return null;
    const examIds = new Set(matching.map(q => q.paperId));
    let wFreq = 0; examIds.forEach(eid => { wFreq += (weights[eid] || 1) * matching.filter(q => q.paperId === eid).length; });
    const avgMarks = matching.reduce((s, q) => s + (q.marks || 5), 0) / matching.length;
    const appearPct = (examIds.size / totalExams) * 100;
    const avgDiff = matching.reduce((s, q) => s + (diffScore[q.difficulty] || 2), 0) / matching.length;
    const reward = (wFreq * avgMarks * (appearPct / 100)) / Math.max(avgDiff, 0.5);
    return { topic: pt, reward, wFreq, avgMarks: +avgMarks.toFixed(1), appearPct: +appearPct.toFixed(0), avgDiff: +avgDiff.toFixed(2), count: matching.length, totalMarks: matching.reduce((s,q) => s+(q.marks||5), 0) };
  }).filter(Boolean).sort((a, b) => b.reward - a.reward);
  const maxR = entries[0]?.reward || 1;
  let cumMarks = 0; const totalM = entries.reduce((s,e) => s + e.totalMarks, 0) || 1;
  return entries.map((e, i) => {
    cumMarks += e.totalMarks;
    const pct30 = Math.ceil(entries.length * 0.3), pct70 = Math.ceil(entries.length * 0.7);
    return { ...e, rank: i + 1, pct: +(e.reward / maxR * 100).toFixed(0),
      priority: i < pct30 ? "High" : i < pct70 ? "Medium" : "Low",
      cumCoverage: +(cumMarks / totalM * 100).toFixed(0) };
  });
}

// ─── Sub-components ────────────────────────────────────────────────
const S = { body: "var(--f-body)", mono: "var(--f-mono)", display: "var(--f-display)" };

// ─── LaTeX Renderer ────────────────────────────────────────────────
function LatexText({ text, style = {}, inline = false }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !text) return;
    const el = ref.current;
    // Split on $...$ (inline) and $$...$$ (display) patterns
    // Also handle \( \) and \[ \] delimiters
    let html = "";
    const escaped = text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    if (window.katex) {
      try {
        // Process display math first: $$...$$ or \[...\]
        let processed = escaped
          .replace(/\$\$([\s\S]*?)\$\$/g, (_, expr) => {
            try { return window.katex.renderToString(expr.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">"), { displayMode: true, throwOnError: false, trust: true }); }
            catch(e) { return `<span style="color:#f87171">${expr}</span>`; }
          })
          .replace(/\\\[([\s\S]*?)\\\]/g, (_, expr) => {
            try { return window.katex.renderToString(expr.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">"), { displayMode: true, throwOnError: false, trust: true }); }
            catch(e) { return `<span style="color:#f87171">${expr}</span>`; }
          });
        // Then inline math: $...$ or \(...\)
        processed = processed
          .replace(/\$([^\$\n]+?)\$/g, (_, expr) => {
            try { return window.katex.renderToString(expr.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">"), { displayMode: false, throwOnError: false, trust: true }); }
            catch(e) { return `<span style="color:#f87171">${expr}</span>`; }
          })
          .replace(/\\\(([\s\S]*?)\\\)/g, (_, expr) => {
            try { return window.katex.renderToString(expr.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">"), { displayMode: false, throwOnError: false, trust: true }); }
            catch(e) { return `<span style="color:#f87171">${expr}</span>`; }
          });
        // Convert newlines to <br>
        html = processed.replace(/\n/g, "<br/>");
      } catch(e) {
        html = escaped.replace(/\n/g, "<br/>");
      }
    } else {
      html = escaped.replace(/\n/g, "<br/>");
    }
    el.innerHTML = html;
  }, [text]);

  return <div ref={ref} style={{
    color: "#ccc", fontSize: 12, lineHeight: 1.7, fontFamily: S.body,
    overflowWrap: "break-word", wordBreak: "break-word",
    ...style,
  }} />;
}

// Single-line truncated version for collapsed cards
function LatexPreview({ text, style = {} }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !text) return;
    const el = ref.current;
    // Take first ~200 chars for preview
    const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
    const escaped = preview.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, " ");

    if (window.katex) {
      try {
        let processed = escaped
          .replace(/\$\$([\s\S]*?)\$\$/g, (_, expr) => {
            try { return window.katex.renderToString(expr.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">"), { displayMode: false, throwOnError: false }); }
            catch(e) { return expr; }
          })
          .replace(/\$([^\$]+?)\$/g, (_, expr) => {
            try { return window.katex.renderToString(expr.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">"), { displayMode: false, throwOnError: false }); }
            catch(e) { return expr; }
          })
          .replace(/\\\(([\s\S]*?)\\\)/g, (_, expr) => {
            try { return window.katex.renderToString(expr.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">"), { displayMode: false, throwOnError: false }); }
            catch(e) { return expr; }
          });
        el.innerHTML = processed;
      } catch(e) {
        el.textContent = preview;
      }
    } else {
      el.textContent = preview;
    }
  }, [text]);

  return <div ref={ref} style={{
    color: "#c8c8c8", fontSize: 11.5, lineHeight: 1.5, fontFamily: S.body,
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    ...style,
  }} />;
}

function formatTag(tag) {
  return tag.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function Tag({ tag, onClick, selected, small, count }) {
  const c = getTagColor(tag);
  return <span onClick={onClick} style={{ display:"inline-flex", alignItems:"center", gap:3,
    padding: small?"2px 6px":"3px 9px", borderRadius:20, fontSize: small?9.5:10.5, fontWeight:600,
    background: selected?c.text:c.bg, color: selected?c.bg:c.text, border:`1px solid ${c.border}`,
    cursor: onClick?"pointer":"default", transition:"all .15s", whiteSpace:"nowrap", userSelect:"none",
  }}>{formatTag(tag)}{count != null && <span style={{opacity:.6, fontSize:8, marginLeft:2}}>({count})</span>}</span>;
}
function DiffBadge({level}) {
  const c = {easy:"#34d399",medium:"#fbbf24",hard:"#f87171"};
  return <span style={{padding:"2px 6px",borderRadius:4,fontSize:8.5,fontWeight:800, background:`${c[level]||"#666"}18`,color:c[level]||"#666", border:`1px solid ${c[level]||"#666"}33`,textTransform:"uppercase",letterSpacing:".08em"}}>{level}</span>;
}
function SemBadge({sem,year,level}) {
  const parts = [sem,year].filter(Boolean).join(" ");
  if (!parts && !level) return null;
  return <span style={{padding:"2px 7px",borderRadius:4,fontSize:8.5,fontWeight:700, background:"#e8c17010",color:"#e8c170",border:"1px solid #e8c17020"}}>{level?`L${level} `:""}{parts}</span>;
}

function PdfModal({paper, onClose}) {
  if (!paper) return null;
  const [viewMode, setViewMode] = useState(paper.blobUrl && paper.name?.endsWith(".pdf") ? "native" : "rendered");
  const hasRendered = paper.pageImages?.length > 0;
  const hasNative = !!paper.blobUrl;

  return <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.9)",zIndex:1000,display:"flex",flexDirection:"column",animation:"fadeIn .2s"}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 18px",background:"#141418",borderBottom:"1px solid #222",flexShrink:0}}>
      <div style={{display:"flex",alignItems:"center",gap:8,minWidth:0,flex:1}}>
        <span style={{color:"#e8c170",flexShrink:0}}>📄</span>
        <span style={{color:"#ddd",fontSize:12.5,fontWeight:600,fontFamily:S.body,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{paper.stdName||paper.name}</span>
        <SemBadge sem={paper.semester} year={paper.year} level={paper.yearLevel}/>
      </div>
      <div style={{display:"flex",gap:4,alignItems:"center",flexShrink:0}}>
        {hasNative && hasRendered && <div style={{display:"flex",gap:1,background:"#222",borderRadius:4,padding:2}}>
          <button onClick={e=>{e.stopPropagation();setViewMode("native")}} style={{padding:"3px 8px",borderRadius:3,border:"none",background:viewMode==="native"?"#e8c17018":"transparent",color:viewMode==="native"?"#e8c170":"#555",fontSize:9,fontWeight:600,cursor:"pointer"}}>PDF</button>
          <button onClick={e=>{e.stopPropagation();setViewMode("rendered")}} style={{padding:"3px 8px",borderRadius:3,border:"none",background:viewMode==="rendered"?"#e8c17018":"transparent",color:viewMode==="rendered"?"#e8c170":"#555",fontSize:9,fontWeight:600,cursor:"pointer"}}>Pages</button>
        </div>}
        {hasNative && <a href={paper.blobUrl} download={paper.name} onClick={e=>e.stopPropagation()} style={{background:"#2a2a2a",color:"#aaa",borderRadius:5,padding:"4px 10px",fontSize:9.5,fontWeight:600,textDecoration:"none",border:"1px solid #333"}}>⬇ Download</a>}
        <button onClick={onClose} style={{background:"#2a2a2a",border:"none",color:"#999",borderRadius:6,width:30,height:30,fontSize:15,cursor:"pointer"}}>✕</button>
      </div>
    </div>
    <div onClick={e=>e.stopPropagation()} style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"}}>
      {/* Native PDF view via iframe - best quality */}
      {(viewMode === "native" && hasNative) ? (
        <iframe src={paper.blobUrl} style={{width:"100%",height:"100%",border:"none",background:"#444"}} title="PDF Viewer"/>
      ) : hasRendered ? (
        <div style={{flex:1,overflow:"auto",padding:"16px 16px 40px",display:"flex",flexDirection:"column",alignItems:"center",gap:10,background:"#282828"}}>
          {paper.pageImages.map((pg,i)=>
            <div key={i} style={{background:"#fff",borderRadius:3,overflow:"hidden",boxShadow:"0 4px 30px rgba(0,0,0,.6)",maxWidth:820,width:"100%",position:"relative"}}>
              <div style={{position:"absolute",top:6,right:6,background:"rgba(0,0,0,.65)",color:"#fff",fontSize:9,padding:"2px 8px",borderRadius:10,fontFamily:S.mono,fontWeight:600}}>Page {i+1}/{paper.pageImages.length}</div>
              <img src={pg.dataUrl} alt={`Page ${i+1}`} style={{width:"100%",display:"block"}}/>
            </div>
          )}
        </div>
      ) : hasNative ? (
        <iframe src={paper.blobUrl} style={{width:"100%",height:"100%",border:"none",background:"#444"}} title="PDF Viewer"/>
      ) : (
        <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",color:"#666",fontSize:13}}>No preview available for this file</div>
      )}
    </div>
  </div>;
}

function GenPdfModal({url, onClose, count}) {
  if (!url) return null;
  return <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.88)",zIndex:1000,display:"flex",flexDirection:"column",animation:"fadeIn .2s"}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 18px",background:"#141418",borderBottom:"1px solid #222",flexShrink:0}}>
      <span style={{color:"#ddd",fontSize:12.5,fontWeight:600}}>✨ Generated — {count} questions</span>
      <div style={{display:"flex",gap:6}}>
        <a href={url} download="filtered_questions.pdf" onClick={e=>e.stopPropagation()} style={{background:"#e8c170",color:"#111",borderRadius:5,padding:"5px 12px",fontSize:10.5,fontWeight:700,textDecoration:"none"}}>⬇ Download</a>
        <button onClick={onClose} style={{background:"#2a2a2a",border:"none",color:"#999",borderRadius:6,width:30,height:30,fontSize:15,cursor:"pointer"}}>✕</button>
      </div>
    </div>
    <div onClick={e=>e.stopPropagation()} style={{flex:1}}>
      <iframe src={url} style={{width:"100%",height:"100%",border:"none"}} title="PDF"/>
    </div>
  </div>;
}

function QCard({q, exp, onToggle, onSolve, solving, solution, onViewPaper, pageImg, showTags = true, paper, status, onSetStatus}) {
  const sortedTags = useMemo(() => [...(q.tags||[])], [q.tags]);
  const statusColor = status==="complete" ? "#34d399" : status==="revisit" ? "#fbbf24" : "#2a2a2a";
  const statusBg = status==="complete" ? "#34d39915" : status==="revisit" ? "#fbbf2415" : "transparent";
  return <div style={{background:"#15151a",border:`1px solid ${exp?"#e8c17020":status==="complete"?"#34d39930":status==="revisit"?"#fbbf2430":"#1c1c22"}`,borderRadius:9,overflow:"hidden",transition:"border-color .2s"}}>
    <div onClick={onToggle} style={{padding:"12px 14px",cursor:"pointer",display:"flex",alignItems:"flex-start",gap:10}}>
      <div style={{background:"#e8c17010",color:"#e8c170",fontWeight:800,fontSize:11,padding:"3px 7px",borderRadius:5,fontFamily:S.mono,whiteSpace:"nowrap",border:"1px solid #e8c17018",minWidth:26,textAlign:"center"}}>Q{q.question_number}</div>
      <div style={{flex:1,minWidth:0}}>
        <LatexPreview text={q.question_text}/>
        <div style={{display:"flex",flexWrap:"wrap",gap:3,marginTop:6,alignItems:"center"}}>
          {q.difficulty && <DiffBadge level={q.difficulty}/>}
          {q.marks!=null && <span style={{fontSize:8.5,color:"#444",fontFamily:S.mono}}>[{q.marks}m]</span>}
          {paper && (paper.semester||paper.year) && <SemBadge sem={paper.semester} year={paper.year} level={paper.yearLevel}/>}
          {showTags && q.primaryTopic && <span style={{fontSize:8.5,color:"#7C3AED",fontWeight:700,fontFamily:S.mono,background:"#7C3AED12",padding:"1px 6px",borderRadius:3,border:"1px solid #7C3AED20"}}>{q.primaryTopic}</span>}
          {showTags && sortedTags.map(t=><Tag key={t} tag={t} small/>)}
        </div>
      </div>
      <div style={{display:"flex",gap:3,alignItems:"center",flexShrink:0}}>
        {status && <span style={{fontSize:7.5,fontWeight:700,fontFamily:S.mono,padding:"1px 5px",borderRadius:3,background:statusBg,color:statusColor,border:`1px solid ${statusColor}40`,textTransform:"uppercase"}}>{status}</span>}
        <span style={{color:"#333",fontSize:14,transform:exp?"rotate(180deg)":"none",transition:"transform .2s"}}>▾</span>
      </div>
    </div>
    {exp && <div style={{padding:"0 14px 12px",borderTop:"1px solid #1a1a20"}}>
      {pageImg && <div style={{marginTop:10,borderRadius:5,overflow:"hidden",border:"1px solid #2a2a2a",background:"#fff",maxHeight:320,overflowY:"auto"}}>
        <div style={{position:"sticky",top:0,background:"rgba(18,18,22,.92)",backdropFilter:"blur(6px)",padding:"4px 8px",fontSize:8.5,color:"#777",fontFamily:S.mono,fontWeight:600,display:"flex",justifyContent:"space-between",borderBottom:"1px solid #333",zIndex:2}}>
          <span>📄 Page {q.page_number}</span><span style={{color:"#555"}}>{q.paperName}</span>
        </div>
        <img src={pageImg} alt="" style={{width:"100%",display:"block"}}/>
      </div>}
      <div style={{background:"#111115",borderRadius:6,padding:11,marginTop:8,border:"1px solid #1c1c22"}}>
        <div style={{color:"#555",fontSize:8.5,textTransform:"uppercase",letterSpacing:".1em",marginBottom:4,fontWeight:800,fontFamily:S.mono}}>Extracted Text</div>
        <LatexText text={q.question_text} style={{color:"#bbb",fontSize:12,lineHeight:1.75}}/>
      </div>
      <div style={{display:"flex",gap:5,alignItems:"center",marginTop:8,flexWrap:"wrap"}}>
        <button onClick={e=>{e.stopPropagation();onViewPaper?.(q.paperId)}} style={{background:"none",border:"1px solid #222",borderRadius:4,color:"#888",fontSize:9.5,cursor:"pointer",padding:"3px 8px",fontFamily:S.mono}}>📄 View Paper</button>
        <button onClick={e=>{e.stopPropagation();onSetStatus(q.id,"complete")}} style={{background:status==="complete"?"#34d39918":"none",border:`1px solid ${status==="complete"?"#34d39950":"#222"}`,borderRadius:4,color:status==="complete"?"#34d399":"#555",fontSize:9.5,cursor:"pointer",padding:"3px 8px",fontFamily:S.mono}}>✓ Complete</button>
        <button onClick={e=>{e.stopPropagation();onSetStatus(q.id,"revisit")}} style={{background:status==="revisit"?"#fbbf2418":"none",border:`1px solid ${status==="revisit"?"#fbbf2450":"#222"}`,borderRadius:4,color:status==="revisit"?"#fbbf24":"#555",fontSize:9.5,cursor:"pointer",padding:"3px 8px",fontFamily:S.mono}}>⚑ Revisit</button>
        {q.topic && <span style={{fontSize:9.5,color:"#444",fontFamily:S.mono}}>{q.topic}</span>}
      </div>
      <button onClick={e=>{e.stopPropagation();onSolve(q)}} disabled={solving} style={{marginTop:8,width:"100%",background:solving?"#1a1a1a":"linear-gradient(135deg,#e8c170,#c9923a)",color:solving?"#555":"#0c0c0f",border:"none",borderRadius:6,padding:"9px 0",fontSize:11.5,fontWeight:700,cursor:solving?"wait":"pointer",transition:"all .2s"}}>{solving?"✨ Solving...":"⚡ Solve with AI"}</button>
      {solution && <div style={{marginTop:8,background:"#0d1117",borderRadius:6,padding:12,border:"1px solid #162d22",maxHeight:400,overflowY:"auto"}}>
        <div style={{color:"#34d399",fontSize:8.5,textTransform:"uppercase",letterSpacing:".1em",marginBottom:6,fontWeight:800,fontFamily:S.mono}}>✓ Solution</div>
        <LatexText text={solution} style={{color:"#aaa",fontSize:12,lineHeight:1.8}}/>
      </div>}
    </div>}
  </div>;
}

// ─── Weighting Panel ───────────────────────────────────────────────
function WeightPanel({papers, mode, params, setMode, setParams, onClose}) {
  const weights = calcWeights(papers, mode, params);
  return <div style={{background:"#14141a",border:"1px solid #1e1e26",borderRadius:10,padding:14,marginBottom:14}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
      <span style={{fontSize:9,color:"#888",fontWeight:700,textTransform:"uppercase",letterSpacing:".1em",fontFamily:S.mono}}>⚖️ Exam Weighting</span>
      <button onClick={onClose} style={{background:"none",border:"none",color:"#555",cursor:"pointer",fontSize:12}}>✕</button>
    </div>
    <div style={{display:"flex",gap:4,marginBottom:10,flexWrap:"wrap"}}>
      {["equal","linear","exponential"].map(m=>
        <button key={m} onClick={()=>setMode(m)} style={{padding:"4px 10px",borderRadius:4,border:"none",background:mode===m?"#e8c17018":"transparent",color:mode===m?"#e8c170":"#555",fontSize:10,fontWeight:600,cursor:"pointer",textTransform:"capitalize"}}>{m}</button>
      )}
    </div>
    {mode==="linear" && <div style={{marginBottom:8}}>
      <label style={{fontSize:9,color:"#555",fontFamily:S.mono}}>Min Weight: {(params.minWeight||.2).toFixed(2)}</label>
      <input type="range" min="0" max="0.8" step="0.05" value={params.minWeight||.2} onChange={e=>setParams({...params,minWeight:+e.target.value})} style={{width:"100%",accentColor:"#e8c170"}}/>
    </div>}
    {mode==="exponential" && <div style={{marginBottom:8}}>
      <label style={{fontSize:9,color:"#555",fontFamily:S.mono}}>Decay Factor: {(params.decay||.8).toFixed(2)}</label>
      <input type="range" min="0.5" max="0.95" step="0.05" value={params.decay||.8} onChange={e=>setParams({...params,decay:+e.target.value})} style={{width:"100%",accentColor:"#e8c170"}}/>
    </div>}
    <div style={{maxHeight:140,overflowY:"auto"}}>
      {papers.map(p=><div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"3px 0",fontSize:10,color:"#888",fontFamily:S.mono}}>
        <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:180}}>{p.stdName||p.name}</span>
        <span style={{color:"#e8c170",fontWeight:700}}>{(weights[p.id]||1).toFixed(2)}</span>
      </div>)}
    </div>
  </div>;
}

// ════════════════════════════════════════════════════════════════════
// MAIN APP
// ════════════════════════════════════════════════════════════════════
export default function StudyVault() {
  const [ready, setReady] = useState(false);
  const [subjects, setSubjects] = useState({});
  const [activeSub, setActiveSub] = useState(null);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [proc, setProc] = useState(false);
  const [procMsg, setProcMsg] = useState("");
  const [solutions, setSolutions] = useState({});
  const [solvingId, setSolvingId] = useState(null);
  const [expId, setExpId] = useState(null);
  const [mainView, setMainView] = useState("questions"); // questions | analytics | studyplan
  const [viewMode, setViewMode] = useState("all");
  const [fTags, setFTags] = useState([]);
  const [fParent, setFParent] = useState("");
  const [fQNum, setFQNum] = useState("");
  const [fDiff, setFDiff] = useState("");
  const [fPaper, setFPaper] = useState("");
  const [fSem, setFSem] = useState("");
  const [fYear, setFYear] = useState("");
  const [viewStatus, setViewStatus] = useState("all");
  const [qStatus, setQStatus] = useState(() => { try { return JSON.parse(localStorage.getItem("sv:qstatus")||"{}"); } catch { return {}; } });
  const [search, setSearch] = useState("");
  const [sidebar, setSidebar] = useState(true);
  const [viewPaper, setViewPaper] = useState(null);
  const [genUrl, setGenUrl] = useState(null);
  const [genning, setGenning] = useState(false);
  const [upSem, setUpSem] = useState("");
  const [upYear, setUpYear] = useState("");
  const [upCode, setUpCode] = useState("");
  const [upLevel, setUpLevel] = useState("");
  const [wMode, setWMode] = useState("equal");
  const [wParams, setWParams] = useState({minWeight:.2,decay:.8});
  const [showWeights, setShowWeights] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [useWeights, setUseWeights] = useState(false);
  const [showTags, setShowTags] = useState(true);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState({});
  const [analyticsSemFilter, setAnalyticsSemFilter] = useState("");
  const [loadingData, setLoadingData] = useState(true);
  const [apiKey, setApiKey] = useState(() => { try { return localStorage.getItem("sv:api_key") || ""; } catch { return ""; } });
  const [saveStatus, setSaveStatus] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [modelExtract, setModelExtract] = useState(() => getModelSetting("extract", DEFAULT_EXTRACT));
  const [modelClassify, setModelClassify] = useState(() => getModelSetting("classify", DEFAULT_CLASSIFY));
  const [modelSolve, setModelSolve] = useState(() => getModelSetting("solve", DEFAULT_SOLVE));
  const [fAssess, setFAssess] = useState("");
  const [assessParsing, setAssessParsing] = useState(false);
  const [showAssessPanel, setShowAssessPanel] = useState(false);
  const fileRef = useRef(null);
  const assessFileRef = useRef(null);
  const saveTimer = useRef(null);
  const initialLoad = useRef(true);

  // ── Load libraries then restore saved data ─────────────────────
  useEffect(() => {
    loadCSS(KATEX_CSS);
    let retries = 0;
    const tryLoad = () => {
      Promise.all([loadScript(`${PDFJS_CDN}/pdf.min.js`),loadScript(JSPDF_CDN),loadScript(KATEX_JS)])
        .then(()=>{
          if(window.pdfjsLib) {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc=`${PDFJS_CDN}/pdf.worker.min.js`;
          }
          setReady(true);
        })
        .catch((e)=>{
          console.warn("Lib load attempt", retries, e);
          if (retries < 2) { retries++; setTimeout(tryLoad, 1000); }
          else setReady(true);
        });
    };
    tryLoad();
  }, []);

  // Restore data from storage once libs are ready
  useEffect(() => {
    if (!ready) return;
    (async () => {
      try {
        const saved = await storageGet("app:subjects");
        const savedActive = await storageGet("app:active");
        const savedWeights = await storageGet("app:weights");
        if (saved && typeof saved === "object" && Object.keys(saved).length > 0) {
          setSaveStatus("Restoring data...");
          // Rebuild each paper's transient data
          const restored = {};
          for (const [name, data] of Object.entries(saved)) {
            const rebuiltPapers = [];
            for (const paper of (data.papers || [])) {
              const pdfData = await storageGet(`pdf:${paper.id}`);
              const rebuilt = await rebuildPaperData(paper, pdfData);
              rebuiltPapers.push(rebuilt);
            }
            restored[name] = { ...data, papers: rebuiltPapers };
          }
          setSubjects(restored);
          if (savedActive && restored[savedActive]) setActiveSub(savedActive);
          if (savedWeights) { setWMode(savedWeights.mode || "equal"); setWParams(savedWeights.params || {minWeight:.2,decay:.8}); }
          setSaveStatus(`Restored ${Object.keys(restored).length} subject(s)`);
          setTimeout(() => setSaveStatus(""), 2000);
        }
      } catch(e) { console.warn("Restore error:", e); }
      setLoadingData(false);
      initialLoad.current = false;
    })();
  }, [ready]);

  // ── Auto-save subjects to storage on change (debounced) ────────
  useEffect(() => {
    if (initialLoad.current || loadingData) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const serialized = serializeSubjects(subjects);
        await storageSet("app:subjects", serialized);
        await storageSet("app:active", activeSub);
        await storageSet("app:weights", { mode: wMode, params: wParams });
        setSaveStatus("Saved ✓");
        setTimeout(() => setSaveStatus(""), 1500);
      } catch(e) { console.warn("Save error:", e); setSaveStatus("Save failed"); }
    }, 800);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [subjects, activeSub, wMode, wParams, loadingData]);

  const subj = activeSub ? subjects[activeSub] : null;
  const pMap = useMemo(() => { const m = {}; subj?.papers.forEach(p=>{m[p.id]=p}); return m; }, [subj]);
  const weights = useMemo(() => calcWeights(subj?.papers||[], wMode, wParams), [subj, wMode, wParams]);

  // ── Hierarchical tag data ──────────────────────────────────────
  const hierarchy = useMemo(() => {
    if (!subj) return {};
    const h = {};
    subj.questions.forEach(q => {
      if (q.parent_topics) {
        Object.entries(q.parent_topics).forEach(([tag, parent]) => {
          if (!h[parent]) h[parent] = new Set();
          h[parent].add(tag);
        });
      }
      q.tags?.forEach(t => {
        const pt = q.primaryTopic || q.topic || "Other";
        if (!Object.values(h).some(s => s.has(t))) {
          if (!h[pt]) h[pt] = new Set();
          h[pt].add(t);
        }
      });
    });
    const out = {};
    Object.entries(h).forEach(([k,v]) => { out[k] = [...v]; });
    return out;
  }, [subj]);

  // Tag frequency counts
  const tagCounts = useMemo(() => {
    if (!subj) return {};
    const c = {};
    subj.questions.forEach(q => q.tags?.forEach(t => { c[t] = (c[t]||0)+1; }));
    return c;
  }, [subj]);

  const parentCounts = useMemo(() => {
    const c = {};
    Object.entries(hierarchy).forEach(([p, tags]) => { c[p] = tags.reduce((s, t) => s + (tagCounts[t]||0), 0); });
    return c;
  }, [hierarchy, tagCounts]);

  // Sort parents by frequency, tags within each parent by frequency
  const sortedHierarchy = useMemo(() => {
    return Object.entries(hierarchy)
      .sort((a, b) => (parentCounts[b[0]]||0) - (parentCounts[a[0]]||0))
      .map(([parent, tags]) => ({
        parent,
        count: parentCounts[parent]||0,
        tags: [...tags].sort((a, b) => (tagCounts[b]||0) - (tagCounts[a]||0)),
      }));
  }, [hierarchy, parentCounts, tagCounts]);

  const allQNums = useMemo(() => { if(!subj) return []; const s=new Set(); subj.questions.forEach(q=>s.add(baseQNum(q.question_number))); return [...s].sort((a,b)=>{const na=parseFloat(a),nb=parseFloat(b);return!isNaN(na)&&!isNaN(nb)?na-nb:String(a).localeCompare(String(b))}); }, [subj]);
  const allPapers = useMemo(() => subj?.papers||[], [subj]);
  const allSems = useMemo(() => { if(!subj) return []; const s=new Set(); subj.papers.forEach(p=>{if(p.semester)s.add(p.semester)}); return [...s].sort(); }, [subj]);
  const allYears = useMemo(() => { if(!subj) return []; const s=new Set(); subj.papers.forEach(p=>{if(p.year)s.add(p.year)}); return [...s].sort(); }, [subj]);

  // ── Filter ─────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!subj) return [];
    let qs = [...subj.questions];
    if (fParent) {
      const childTags = hierarchy[fParent] || [];
      qs = qs.filter(q => q.tags?.some(t => childTags.includes(t)));
    }
    if (fTags.length) qs = qs.filter(q => fTags.every(ft => q.tags?.some(t => t.toLowerCase()===ft.toLowerCase())));
    if (fQNum) qs = qs.filter(q => baseQNum(q.question_number)===fQNum);
    if (fDiff) qs = qs.filter(q => q.difficulty===fDiff);
    if (fPaper) qs = qs.filter(q => q.paperId===fPaper);
    if (fSem) { const ids=new Set(subj.papers.filter(p=>p.semester===fSem).map(p=>p.id)); qs=qs.filter(q=>ids.has(q.paperId)); }
    if (fYear) { const ids=new Set(subj.papers.filter(p=>p.year===fYear).map(p=>p.id)); qs=qs.filter(q=>ids.has(q.paperId)); }
    if (viewStatus==="complete") qs=qs.filter(q=>qStatus[q.id]==="complete");
    else if (viewStatus==="revisit") qs=qs.filter(q=>qStatus[q.id]==="revisit");
    else if (viewStatus==="incomplete") qs=qs.filter(q=>qStatus[q.id]!=="complete"&&qStatus[q.id]!=="revisit");
    if (search.trim()) { const l=search.toLowerCase(); qs=qs.filter(q=>q.question_text.toLowerCase().includes(l)||q.tags?.some(t=>t.toLowerCase().includes(l))||q.topic?.toLowerCase().includes(l)); }
    if (fAssess) {
      const assessConfig = subj?.assessability?.tags || {};
      if (fAssess === "assessable") {
        qs = qs.filter(q => !q.tags?.length || !q.tags.every(t => assessConfig[t]?.assessable === false));
      } else if (fAssess === "likely") {
        qs = qs.filter(q => q.tags?.some(t => assessConfig[t]?.likelihood === "high"));
      }
    }
    return qs;
  }, [subj, fParent, fTags, fQNum, fDiff, fPaper, fSem, fYear, viewStatus, qStatus, search, hierarchy, fAssess]);

  const grouped = useMemo(() => {
    if (viewMode==="by-paper") { const g={}; filtered.forEach(q=>{(g[q.paperName]??=[]).push(q)}); return g; }
    if (viewMode==="by-topic") { const g={}; filtered.forEach(q=>{(g[q.topic||"Other"]??=[]).push(q)}); return g; }
    if (viewMode==="by-semester") { const g={}; filtered.forEach(q=>{const pp=pMap[q.paperId]; const k=pp?[pp.semester,pp.year].filter(Boolean).join(" ")||"Other":"Other"; (g[k]??=[]).push(q)}); return g; }
    if (viewMode==="by-qnum") { const g={}; filtered.forEach(q=>{(g[`Question ${q.question_number}`]??=[]).push(q)}); return g; }
    return {all:filtered};
  }, [filtered, viewMode, pMap]);

  const hasFilters = fTags.length||fQNum||fDiff||fPaper||fSem||fYear||fParent||search||viewStatus!=="all"||fAssess;
  const clearFilters = () => {setFTags([]);setFQNum("");setFDiff("");setFPaper("");setFSem("");setFYear("");setFParent("");setSearch("");setViewStatus("all");setFAssess("");};

  // ── Study plan ─────────────────────────────────────────────────
  const studyPlan = useMemo(() => {
    if (!subj) return [];
    const hier = {};
    Object.entries(hierarchy).forEach(([p, tags]) => { hier[p] = [...tags]; });
    return calcStudyPlan(subj.questions, subj.papers, useWeights ? weights : {}, hier);
  }, [subj, hierarchy, weights, useWeights]);

  // ── Analytics data ─────────────────────────────────────────────
  const analyticsData = useMemo(() => {
    if (!subj || !subj.questions.length) return null;
    const parentTopics = Object.keys(hierarchy);

    // Filter papers by semester type if set
    const papers = analyticsSemFilter
      ? subj.papers.filter(p => p.semester === analyticsSemFilter)
      : subj.papers;
    if (!papers.length) return null;
    const paperIds = new Set(papers.map(p=>p.id));
    const questions = subj.questions.filter(q => paperIds.has(q.paperId));
    if (!questions.length) return null;

    // Topic frequency (of filtered set)
    const topicFreqMap = {};
    questions.forEach(q => {
      q.tags?.forEach(t => {
        for (const [pt, tags] of Object.entries(hierarchy)) {
          if (tags.includes(t)) { topicFreqMap[pt] = (topicFreqMap[pt]||0) + 1; break; }
        }
      });
    });
    const topicFreq = Object.entries(topicFreqMap).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count);

    // Topic trend over years — only track top 8 parent topics by overall frequency
    const yearSet = [...new Set(papers.map(p=>p.year).filter(Boolean))].sort();
    const topParents = Object.entries(topicFreqMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name])=>name);
    const topicTrend = yearSet.map(yr => {
      const yPaperIds = new Set(papers.filter(p=>p.year===yr).map(p=>p.id));
      const qs = questions.filter(q=>yPaperIds.has(q.paperId));
      const numPapers = papers.filter(p=>p.year===yr).length || 1;
      const row = {year: yr};
      topParents.forEach(pt => { const tags = hierarchy[pt]||[]; const count = qs.filter(q=>q.tags?.some(t=>tags.includes(t))).length; row[pt] = +(count / numPapers).toFixed(1); });
      return row;
    });

    // Difficulty per exam
    const diffScore = {easy:1,medium:2,hard:3};
    const diffPerExam = papers.map(pp => {
      const qs = questions.filter(q=>q.paperId===pp.id);
      const easy = qs.filter(q=>q.difficulty==="easy").length;
      const medium = qs.filter(q=>q.difficulty==="medium").length;
      const hard = qs.filter(q=>q.difficulty==="hard").length;
      const total = qs.length || 1;
      const avgDiff = qs.reduce((s,q) => s + (diffScore[q.difficulty]||2), 0) / total;
      return { name: pp.stdName||pp.name, semester: pp.semester||"", year: pp.year||"", easy, medium, hard, total, avgDiff: +avgDiff.toFixed(2) };
    });

    // Overall difficulty comparison: average difficulty score per exam, sorted by year
    const diffComparison = [...diffPerExam].sort((a,b) => (a.year+a.name).localeCompare(b.year+b.name));

    // Difficulty trend line (avg difficulty per year)
    const diffTrend = yearSet.map(yr => {
      const exams = diffPerExam.filter(d => d.year === yr);
      const avg = exams.length ? exams.reduce((s,d) => s + d.avgDiff, 0) / exams.length : 0;
      return { year: yr, avgDifficulty: +avg.toFixed(2) };
    });

    // Course-wide difficulty stats
    const allAvgDiff = diffPerExam.length ? diffPerExam.reduce((s,d) => s + d.avgDiff, 0) / diffPerExam.length : 0;
    const hardestExam = diffPerExam.reduce((best,d) => d.avgDiff > (best?.avgDiff||0) ? d : best, null);
    const easiestExam = diffPerExam.reduce((best,d) => d.avgDiff < (best?.avgDiff||9) ? d : best, null);

    // Topic distribution pie
    const topicPie = topicFreq.filter(t=>t.count>0).slice(0,10);

    // Top tags bar (re-count from filtered questions)
    const filteredTagCounts = {};
    questions.forEach(q => q.tags?.forEach(t => { filteredTagCounts[t] = (filteredTagCounts[t]||0)+1; }));
    const topTags = Object.entries(filteredTagCounts).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([name,count])=>({name,count}));

    return { topicFreq, topicTrend, diffPerExam, diffComparison, diffTrend, topicPie, topTags, parentTopics: topParents, yearSet, allAvgDiff: +allAvgDiff.toFixed(2), hardestExam, easiestExam, paperCount: papers.length, questionCount: questions.length };
  }, [subj, hierarchy, tagCounts, analyticsSemFilter]);

  // ── Actions ────────────────────────────────────────────────────
  const createSubject = () => { const n=newName.trim(); if(!n||subjects[n]) return; setSubjects(p=>({...p,[n]:{questions:[],papers:[],courseCode:newCode.trim()}})); setActiveSub(n); setNewName(""); setNewCode(""); setShowNew(false); };
  const delSubject = n => {
    // Clean up stored PDFs for all papers in this subject
    const data = subjects[n];
    if (data?.papers) data.papers.forEach(p => storageDel(`pdf:${p.id}`));
    setSubjects(p=>{const x={...p};delete x[n];return x}); if(activeSub===n) setActiveSub(null);
  };

  const refreshTitles = () => {
    if (!activeSub) return;
    setSubjects(prev => {
      const s = prev[activeSub];
      if (!s) return prev;
      const updatedPapers = s.papers.map(p => {
        const code = p.courseCode || detectCourseCode(p.name) || "";
        const lvl = detectYearLevel(code);
        const sem = detectSemester(p.name);
        const yr = detectYear(p.name);
        const stdName = buildStdName(code, lvl, sem, yr, p.name);
        return { ...p, stdName, semester: sem, year: yr };
      });
      const nameMap = {};
      updatedPapers.forEach(p => { nameMap[p.id] = p.stdName; });
      const updatedQuestions = s.questions.map(q => ({ ...q, paperName: nameMap[q.paperId] || q.paperName }));
      return { ...prev, [activeSub]: { ...s, papers: updatedPapers, questions: updatedQuestions } };
    });
  };

  const removePaper = (paperId) => {
    if (!activeSub) return;
    storageDel(`pdf:${paperId}`); // Remove persisted PDF data
    setSubjects(prev => {
      const s = prev[activeSub];
      if (!s) return prev;
      const paper = s.papers.find(p => p.id === paperId);
      if (paper?.blobUrl) try { URL.revokeObjectURL(paper.blobUrl); } catch(e) {}
      return {
        ...prev,
        [activeSub]: {
          ...s,
          papers: s.papers.filter(p => p.id !== paperId),
          questions: s.questions.filter(q => q.paperId !== paperId),
        }
      };
    });
    if (fPaper === paperId) setFPaper("");
  };

  const handleFiles = async files => {
    if (!activeSub||proc) return; setProc(true);
    for (let i=0;i<files.length;i++) {
      const file=files[i]; setProcMsg(`Reading ${file.name}...`);
      try {
        const b64 = await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(",")[1]);r.onerror=()=>rej(new Error("Read"));r.readAsDataURL(file)});
        let mt = file.type||"application/pdf"; if(file.name.endsWith(".pdf")) mt="application/pdf";
        const paperId=uid(); let pageImages=[]; let pageCount = 1;

        // Create blob URL from the original file directly (most reliable)
        const blobUrl = URL.createObjectURL(file);

        // Try to render pages for image-based viewing and question cropping
        if(mt==="application/pdf"&&window.pdfjsLib){
          setProcMsg(`Rendering pages of ${file.name}...`);
          try {
            pageImages = await renderPdfPages(b64, 1.5);
            pageCount = pageImages.length || 1;
          } catch(renderErr) {
            console.warn("PDF page render failed, using native viewer:", renderErr);
            // Try to at least get page count
            try {
              const bytes = base64ToBytes(b64);
              const pdfDoc = await window.pdfjsLib.getDocument({ data: bytes.buffer }).promise;
              pageCount = pdfDoc.numPages;
            } catch(e2) { /* ignore */ }
          }
        } else if(mt.startsWith("image/")) {
          pageImages=[{dataUrl:`data:${mt};base64,${b64}`,width:800,height:1100}];
        }

        setProcMsg(`AI scanning ${file.name} (${i+1}/${files.length})...`);
        const { paperMeta, questions: extracted } = await extractQuestions(b64, mt, msg => setProcMsg(`${file.name} (${i+1}/${files.length}): ${msg}`));

        // Use AI-detected metadata, with manual overrides and filename fallbacks
        const code = upCode || paperMeta.course_code || detectCourseCode(file.name) || subj?.courseCode || "";
        const sem = upSem || paperMeta.semester || detectSemester(file.name);
        const yr = upYear || paperMeta.year || detectYear(file.name);
        const lvl = upLevel || detectYearLevel(code);
        const stdName = buildStdName(code, lvl, sem, yr, file.name);
        const paperObj = {id:paperId,name:file.name,stdName,courseCode:code,yearLevel:lvl,semester:sem,year:yr,blobUrl,pageImages,pageCount};

        const questions = extracted.map(q => ({...q, id:uid(), paperId, paperName:stdName, primaryTopic: q.topic}));
        setSubjects(prev => ({...prev,[activeSub]:{...prev[activeSub],papers:[...prev[activeSub].papers,paperObj],questions:[...prev[activeSub].questions,...questions]}}));
        // Persist the raw PDF data for reload
        await storageSet(`pdf:${paperId}`, { base64: b64, mediaType: mt });
      } catch(err) { console.error(err); setProcMsg(`Error: ${err.message}`); await new Promise(r=>setTimeout(r,2000)); }
    }
    setProc(false); setProcMsg(""); setUpSem(""); setUpYear(""); setUpCode(""); setUpLevel("");
  };

  const setQuestionStatus = (id, status) => {
    setQStatus(prev => {
      const next = {...prev};
      if (next[id] === status) { delete next[id]; } else { next[id] = status; }
      try { localStorage.setItem("sv:qstatus", JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const handleSolve = async q => { if(solvingId) return; setSolvingId(q.id); try{const s=await solveQuestion(q.question_text,q.tags||[]);setSolutions(p=>({...p,[q.id]:s}))}catch{setSolutions(p=>({...p,[q.id]:"Error."}))} setSolvingId(null); };
  const handleGenPdf = async () => { if(!window.jspdf||!filtered.length) return; setGenning(true); try{setGenUrl(await generatePdf(filtered,pMap))}catch(e){console.error(e)} setGenning(false); };
  const toggleTag = t => setFTags(p=>p.includes(t)?p.filter(x=>x!==t):[...p,t]);

  const handleAssessDoc = async (file) => {
    if (!activeSub || assessParsing) return;
    setAssessParsing(true);
    try {
      const b64 = await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(",")[1]);r.onerror=()=>rej(new Error("Read"));r.readAsDataURL(file)});
      const mt = file.type || "application/pdf";
      const allTags = Object.keys(tagCounts);
      const allParents = Object.keys(hierarchy);
      const result = await parseAssessabilityDoc(b64, mt, allTags, allParents, callClaude, getModelSetting("extract", DEFAULT_EXTRACT));
      const existingConfig = subj?.assessability || { sourceDoc: null, tags: {} };
      const merged = mergeAssessabilityResults(result, existingConfig);
      merged.sourceDoc = { name: file.name, uploadedAt: new Date().toISOString() };
      setSubjects(prev => ({
        ...prev,
        [activeSub]: { ...prev[activeSub], assessability: merged }
      }));
    } catch(err) { console.error("Assess parse error:", err); }
    setAssessParsing(false);
  };

  const toggleAssessTag = (tag, field, value) => {
    setSubjects(prev => {
      const s = prev[activeSub];
      const assess = { ...(s.assessability || { sourceDoc: null, tags: {} }) };
      assess.tags = { ...assess.tags };
      assess.tags[tag] = { ...(assess.tags[tag] || { assessable: true, likelihood: null }), [field]: value };
      return { ...prev, [activeSub]: { ...s, assessability: assess } };
    });
  };

  const toggleAssessParent = (parent, assessable) => {
    setSubjects(prev => {
      const s = prev[activeSub];
      const assess = { ...(s.assessability || { sourceDoc: null, tags: {} }) };
      assess.tags = { ...assess.tags };
      (hierarchy[parent] || []).forEach(tag => {
        assess.tags[tag] = { ...(assess.tags[tag] || {}), assessable, likelihood: assess.tags[tag]?.likelihood || null };
      });
      return { ...prev, [activeSub]: { ...s, assessability: assess } };
    });
  };

  const getPageImg = useCallback(q => { const pp=pMap[q.paperId]; if(!pp?.pageImages?.length) return null; const i=Math.max(0,(q.page_number||1)-1); return i<pp.pageImages.length?pp.pageImages[i].dataUrl:null; }, [pMap]);

  // ── Render ─────────────────────────────────────────────────────
  const sel = {background:"#e8c17015",color:"#e8c170",border:"1px solid #e8c17015"};
  const unsel = {background:"transparent",color:"#4a4a4a",border:"1px solid transparent"};

  // ── Loading screen ──────────────────────────────────────────────
  if (loadingData && !ready) {
    return <div style={{minHeight:"100vh",background:"#0c0c0f",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,800&display=swap');@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
      <div style={{width:50,height:50,borderRadius:12,background:"linear-gradient(135deg,#e8c170,#c9923a)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,fontWeight:900,color:"#0c0c0f",fontFamily:"'Fraunces',serif"}}>S</div>
      <div style={{color:"#e8c170",fontSize:16,fontWeight:700,fontFamily:"'Fraunces',serif"}}>StudyVault</div>
      <div style={{color:"#555",fontSize:11,animation:"pulse 1.5s infinite"}}>Loading...</div>
    </div>;
  }

  return <div style={{minHeight:"100vh",background:"#0c0c0f",color:"#e0e0e0",display:"flex",fontFamily:"var(--f-body)"}}>
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;600;700&family=Fraunces:opsz,wght@9..144,300;9..144,600;9..144,800&display=swap');
      :root{--f-body:'Outfit',sans-serif;--f-mono:'JetBrains Mono',monospace;--f-display:'Fraunces',serif}
      *{box-sizing:border-box;margin:0;padding:0}
      @keyframes fadeIn{from{opacity:0}to{opacity:1}}
      @keyframes slideUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
      @keyframes shimmer{0%{background-position:-200% center}100%{background-position:200% center}}
      ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#2a2a2a;border-radius:2px}
      input:focus,select:focus{outline:none;border-color:#e8c170!important}
      button,select{font-family:var(--f-body)}button:hover:not(:disabled){filter:brightness(1.08)}button:active:not(:disabled){transform:scale(.98)}
      .recharts-text{fill:#888!important;font-size:10px!important;font-family:'JetBrains Mono',monospace!important}
      .recharts-cartesian-grid line{stroke:#1e1e26!important}
      .katex{font-size:1.05em!important}
      .katex .mathnormal,.katex .mathit{color:#e8c170!important}
      .katex .mord,.katex .mbin,.katex .mrel,.katex .mopen,.katex .mclose,.katex .mpunct{color:#ddd!important}
      .katex .mop{color:#ddd!important}
      .katex .katex-display{margin:.6em 0!important;overflow-x:auto;overflow-y:hidden;padding:4px 0}
      .katex .katex-display>.katex{text-align:left!important}
      .katex .frac-line{border-bottom-color:#888!important}
      .katex .sqrt>.sqrt-sign{color:#ddd!important}
      .katex .delimsizing,.katex .delim-size1,.katex .delim-size4{color:#ddd!important}
    `}</style>

    {/* ─── Sidebar ─── */}
    <div style={{width:sidebar?260:0,minWidth:sidebar?260:0,background:"#0f0f14",borderRight:"1px solid #1e1e26",display:"flex",flexDirection:"column",overflow:"hidden",transition:"all .25s"}}>
      {/* Logo */}
      <div style={{padding:"14px 12px 10px",borderBottom:"1px solid #1e1e26",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:7}}>
          <div style={{width:26,height:26,borderRadius:5,background:"linear-gradient(135deg,#e8c170,#c9923a)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:900,color:"#0c0c0f",fontFamily:S.display}}>S</div>
          <span style={{fontFamily:S.display,fontSize:17,fontWeight:800,color:"#e8c170"}}>StudyVault</span>
        </div>
        {saveStatus && <div style={{fontSize:8,color:saveStatus.includes("✓")?"#34d399":saveStatus.includes("fail")?"#f87171":"#e8c170",fontFamily:S.mono,marginTop:3}}>{saveStatus}</div>}
      </div>

      {/* Big Tab Buttons */}
      <div style={{padding:"10px 10px 6px",borderBottom:"1px solid #1e1e26",flexShrink:0,display:"flex",flexDirection:"column",gap:4}}>
        {[["questions","📋","Questions"],["analytics","📊","Analytics"],["studyplan","🎯","Study Plan"]].map(([v,icon,label])=>
          <button key={v} onClick={()=>{if(activeSub)setMainView(v)}} disabled={!activeSub} style={{width:"100%",padding:"10px 14px",borderRadius:7,border:`1px solid ${mainView===v&&activeSub?"#e8c17030":"#1e1e26"}`,background:mainView===v&&activeSub?"#e8c17012":"transparent",color:mainView===v&&activeSub?"#e8c170":activeSub?"#555":"#2a2a2a",fontSize:12,fontWeight:700,cursor:activeSub?"pointer":"default",textAlign:"left",display:"flex",alignItems:"center",gap:8,transition:"all .15s"}}>
            <span style={{fontSize:14}}>{icon}</span>{label}
          </button>
        )}
      </div>

      {/* Scrollable middle: Subjects + Upload + Papers */}
      <div style={{flex:1,overflowY:"auto",padding:"6px 5px"}}>
        {/* Subjects */}
        <div style={{padding:"6px 6px 2px"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
            <span style={{fontSize:8,color:"#444",textTransform:"uppercase",letterSpacing:".12em",fontWeight:700,fontFamily:S.mono}}>Subjects</span>
            <button onClick={()=>setShowNew(true)} style={{background:"none",border:"1px solid #262626",borderRadius:3,color:"#555",fontSize:11,cursor:"pointer",width:18,height:18,display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
          </div>
          {showNew && <div style={{marginBottom:5,animation:"slideUp .15s"}}>
            <input autoFocus value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")createSubject();if(e.key==="Escape")setShowNew(false)}} placeholder="Subject name..." style={{width:"100%",padding:"5px 8px",borderRadius:4,border:"1px solid #262626",background:"#18181e",color:"#ddd",fontSize:11,marginBottom:3}}/>
            <input value={newCode} onChange={e=>setNewCode(e.target.value)} placeholder="Course code (opt)..." style={{width:"100%",padding:"5px 8px",borderRadius:4,border:"1px solid #262626",background:"#18181e",color:"#ddd",fontSize:11,marginBottom:3}}/>
            <div style={{display:"flex",gap:3}}>
              <button onClick={createSubject} style={{flex:1,padding:"3px",borderRadius:3,border:"none",background:"#e8c170",color:"#111",fontSize:10,fontWeight:700,cursor:"pointer"}}>Create</button>
              <button onClick={()=>{setShowNew(false);setNewName("");setNewCode("")}} style={{flex:1,padding:"3px",borderRadius:3,border:"1px solid #262626",background:"none",color:"#666",fontSize:10,cursor:"pointer"}}>Cancel</button>
            </div>
          </div>}
          {Object.entries(subjects).map(([name,d])=><div key={name} onClick={()=>{setActiveSub(name);clearFilters();setViewMode("all");setMainView("questions")}} style={{padding:"7px 8px",borderRadius:5,cursor:"pointer",marginBottom:1,...(activeSub===name?sel:unsel),transition:"all .12s"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span style={{fontSize:11.5,fontWeight:activeSub===name?700:400}}>{name}</span>
              <button onClick={e=>{e.stopPropagation();delSubject(name)}} style={{background:"none",border:"none",color:"#2a2a2a",cursor:"pointer",fontSize:11}}>×</button>
            </div>
            <div style={{fontSize:8.5,color:"#3a3a3a",fontFamily:S.mono}}>{d.questions.length} qs · {d.papers.length} papers{d.courseCode?` · ${d.courseCode}`:""}</div>
          </div>)}
        </div>

        {/* Upload Section */}
        {activeSub && <div style={{padding:"8px 6px 0"}}>
          <div style={{fontSize:8,color:"#444",textTransform:"uppercase",letterSpacing:".12em",fontWeight:700,fontFamily:S.mono,marginBottom:6}}>Upload Papers</div>
          <div
            onDragOver={e=>{e.preventDefault();e.stopPropagation();if(!proc)setDragOver(true)}}
            onDragEnter={e=>{e.preventDefault();e.stopPropagation();if(!proc)setDragOver(true)}}
            onDragLeave={e=>{e.preventDefault();e.stopPropagation();setDragOver(false)}}
            onDrop={e=>{e.preventDefault();e.stopPropagation();setDragOver(false);if(!proc){const files=Array.from(e.dataTransfer.files).filter(f=>f.type==="application/pdf"||f.type.startsWith("image/")||f.name.endsWith(".pdf"));if(files.length)handleFiles(files)}}}
            style={{border:`1.5px dashed ${dragOver?"#e8c170":"#262630"}`,borderRadius:8,padding:"10px 10px",background:dragOver?"#e8c17008":"#111118",transition:"all .2s"}}>
            <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:6}}>
              {[{v:upCode,s:setUpCode,p:"Code",w:"68px"},{v:upLevel,s:setUpLevel,p:"Lvl",w:"44px"},{v:upYear,s:setUpYear,p:"Year",w:"52px"}].map(({v,s,p,w},i)=>
                <div key={i} style={{minWidth:w}}>
                  <label style={{fontSize:7,color:"#444",textTransform:"uppercase",letterSpacing:".08em",fontWeight:700,fontFamily:S.mono,display:"block",marginBottom:2}}>{p}</label>
                  <input value={v} onChange={e=>s(e.target.value)} placeholder="Auto" style={{width:"100%",padding:"4px 5px",borderRadius:4,border:"1px solid #222",background:"#16161c",color:"#bbb",fontSize:9.5}}/>
                </div>
              )}
              <div style={{minWidth:72}}>
                <label style={{fontSize:7,color:"#444",textTransform:"uppercase",letterSpacing:".08em",fontWeight:700,fontFamily:S.mono,display:"block",marginBottom:2}}>Semester</label>
                <select value={upSem} onChange={e=>setUpSem(e.target.value)} style={{width:"100%",padding:"4px 5px",borderRadius:4,border:"1px solid #222",background:"#16161c",color:"#bbb",fontSize:9.5,cursor:"pointer"}}>
                  <option value="">Auto</option>{SEMESTERS.map(s=><option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <button onClick={()=>{if(!proc){if(fileRef.current)fileRef.current.value="";fileRef.current?.click()}}} disabled={proc} style={{width:"100%",background:proc?"#1a1a1a":"linear-gradient(135deg,#e8c170,#c9923a)",color:proc?"#555":"#0c0c0f",border:"none",borderRadius:5,padding:"6px 0",fontSize:10.5,fontWeight:700,cursor:proc?"wait":"pointer"}}>
              {proc?"Scanning...":"📄 Upload Papers"}
            </button>
            <input ref={fileRef} type="file" multiple accept=".pdf,image/*" style={{display:"none"}} onChange={e=>{const files=Array.from(e.target.files||[]);if(files.length){handleFiles(files)}e.target.value=""}}/>
            {proc&&procMsg && <div style={{marginTop:5,fontSize:9,color:"#e8c170",fontFamily:S.mono,animation:"pulse 1.5s infinite"}}>{procMsg}</div>}
            {!proc && <div style={{marginTop:5,fontSize:8.5,color:dragOver?"#e8c170":"#2a2a2a",textAlign:"center",transition:"color .2s"}}>{dragOver?"Drop here...":"Drop PDFs or Ctrl+Click for multiple"}</div>}
          </div>
        </div>}

        {/* Papers List */}
        {activeSub && allPapers.length>0 && <div style={{padding:"10px 6px 0"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
            <div style={{fontSize:8,color:"#444",textTransform:"uppercase",letterSpacing:".12em",fontWeight:700,fontFamily:S.mono}}>Papers</div>
            <button onClick={refreshTitles} title="Re-decode titles from filenames" style={{background:"none",border:"1px solid #2a2a36",borderRadius:3,color:"#555",cursor:"pointer",fontSize:7.5,padding:"1px 5px",fontFamily:S.mono}}>↻ Refresh</button>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:3}}>
            {allPapers.map(p=>{
              const qCount = subj.questions.filter(q=>q.paperId===p.id).length;
              return <div key={p.id} style={{background:"#14141a",border:"1px solid #1e1e26",borderRadius:5,padding:"6px 8px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:4}}>
                <div onClick={()=>setViewPaper(p)} style={{flex:1,minWidth:0,cursor:"pointer"}}>
                  <div style={{fontSize:10,fontWeight:600,color:"#bbb",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.stdName||p.name}</div>
                  <div style={{fontSize:8,color:"#3a3a3a",fontFamily:S.mono}}>{p.pageCount}pg · {qCount}qs</div>
                </div>
                <button onClick={e=>{e.stopPropagation();if(window.confirm(`Remove "${p.stdName||p.name}" and its ${qCount} questions?`))removePaper(p.id)}} style={{background:"none",border:"none",color:"#2a2a2a",cursor:"pointer",fontSize:13,padding:"0 2px",flexShrink:0,lineHeight:1}}>×</button>
              </div>;
            })}
          </div>
        </div>}

        {/* Exam Content / Assessability Panel */}
        {activeSub && subj?.questions.length>0 && <div style={{padding:"10px 6px 0"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
            <div style={{fontSize:8,color:"#444",textTransform:"uppercase",letterSpacing:".12em",fontWeight:700,fontFamily:S.mono}}>Exam Content</div>
            <button onClick={()=>setShowAssessPanel(!showAssessPanel)} style={{background:"none",border:"1px solid #2a2a36",borderRadius:3,color:showAssessPanel?"#e8c170":"#555",cursor:"pointer",fontSize:7.5,padding:"1px 5px",fontFamily:S.mono}}>{showAssessPanel?"▾":"▸"}</button>
          </div>
          {showAssessPanel && <div style={{background:"#111118",border:"1px solid #1e1e26",borderRadius:6,padding:8}}>
            {/* Upload zone for course guide */}
            <div
              onDragOver={e=>{e.preventDefault();e.stopPropagation()}}
              onDrop={e=>{e.preventDefault();e.stopPropagation();if(!assessParsing){const files=Array.from(e.dataTransfer.files);if(files.length)handleAssessDoc(files[0])}}}
              style={{border:"1.5px dashed #262630",borderRadius:6,padding:"8px",marginBottom:8,background:"#0f0f14"}}>
              <button onClick={()=>{if(!assessParsing){if(assessFileRef.current)assessFileRef.current.value="";assessFileRef.current?.click()}}} disabled={assessParsing} style={{width:"100%",background:assessParsing?"#1a1a1a":"linear-gradient(135deg,#a78bfa,#7c3aed)",color:assessParsing?"#555":"#fff",border:"none",borderRadius:4,padding:"5px 0",fontSize:9.5,fontWeight:700,cursor:assessParsing?"wait":"pointer"}}>
                {assessParsing?"Parsing...":"Upload Course Guide"}
              </button>
              <input ref={assessFileRef} type="file" accept=".pdf,image/*" style={{display:"none"}} onChange={e=>{const f=e.target.files?.[0];if(f)handleAssessDoc(f);e.target.value=""}}/>
              {assessParsing && <div style={{marginTop:4,fontSize:8,color:"#a78bfa",fontFamily:S.mono,animation:"pulse 1.5s infinite"}}>AI analyzing document...</div>}
              <div style={{fontSize:7.5,color:"#2a2a2a",textAlign:"center",marginTop:4}}>Drop course guide or exam info sheet</div>
            </div>

            {/* Source doc info */}
            {subj.assessability?.sourceDoc && <div style={{fontSize:8,color:"#555",fontFamily:S.mono,marginBottom:6,padding:"3px 5px",background:"#14141a",borderRadius:3}}>
              Source: {subj.assessability.sourceDoc.name}
            </div>}

            {/* Parent topics with toggles */}
            <div style={{maxHeight:300,overflowY:"auto"}}>
              {sortedHierarchy.map(({parent, tags})=>{
                const assessTags = subj?.assessability?.tags || {};
                const allOff = tags.every(t => assessTags[t]?.assessable === false);
                return <div key={parent} style={{marginBottom:6}}>
                  <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:3}}>
                    <button onClick={()=>toggleAssessParent(parent, allOff ? true : false)} style={{width:14,height:14,borderRadius:3,border:`1px solid ${allOff?"#f8717140":"#34d39940"}`,background:allOff?"#f8717115":"#34d39915",color:allOff?"#f87171":"#34d399",fontSize:8,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0,lineHeight:1}}>{allOff?"x":"v"}</button>
                    <span style={{fontSize:9,fontWeight:700,color:allOff?"#555":"#888",fontFamily:S.mono}}>{parent}</span>
                  </div>
                  <div style={{paddingLeft:10,display:"flex",flexDirection:"column",gap:2}}>
                    {tags.map(t=>{
                      const cfg = assessTags[t] || {};
                      const isOff = cfg.assessable === false;
                      return <div key={t} style={{display:"flex",alignItems:"center",gap:4,fontSize:8.5}}>
                        <button onClick={()=>toggleAssessTag(t,"assessable",isOff?true:false)} style={{width:12,height:12,borderRadius:2,border:`1px solid ${isOff?"#f8717130":"#34d39930"}`,background:isOff?"#f8717110":"#34d39910",color:isOff?"#f87171":"#34d399",fontSize:7,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0,lineHeight:1}}>{isOff?"x":"v"}</button>
                        <span style={{color:isOff?"#444":"#999",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{formatTag(t)}</span>
                        {!isOff && <select value={cfg.likelihood||""} onChange={e=>toggleAssessTag(t,"likelihood",e.target.value||null)} style={{padding:"1px 3px",borderRadius:2,border:"1px solid #222",background:"#16161c",color:cfg.likelihood==="high"?"#34d399":cfg.likelihood==="medium"?"#fbbf24":"#555",fontSize:7.5,cursor:"pointer"}}>
                          <option value="">—</option>
                          <option value="high">High</option>
                          <option value="medium">Med</option>
                          <option value="low">Low</option>
                        </select>}
                      </div>;
                    })}
                  </div>
                </div>;
              })}
            </div>

            {/* Clear all button */}
            {subj?.assessability && <button onClick={()=>{setSubjects(prev=>({...prev,[activeSub]:{...prev[activeSub],assessability:null}}))}} style={{width:"100%",marginTop:6,background:"none",border:"1px solid #f8717125",borderRadius:4,color:"#f87171",fontSize:8,cursor:"pointer",padding:"3px 0",fontFamily:S.mono}}>Clear All</button>}
          </div>}
        </div>}
      </div>
    </div>

    {/* ─── Main ─── */}
    <div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0}}>
      {/* Sticky Top Bar */}
      <div style={{position:"sticky",top:0,zIndex:100,padding:"7px 12px",borderBottom:"1px solid #1e1e26",display:"flex",alignItems:"center",gap:6,background:"#0f0f14",flexShrink:0,flexWrap:"wrap"}}>
        <button onClick={()=>setSidebar(!sidebar)} style={{background:"none",border:"1px solid #1e1e24",borderRadius:4,color:"#555",cursor:"pointer",padding:"3px 7px",fontSize:12,flexShrink:0}}>☰</button>
        {activeSub && mainView==="questions" && <>
          <div style={{position:"relative",minWidth:100,flex:"1 1 100px"}}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search..." style={{width:"100%",padding:"5px 8px 5px 24px",borderRadius:5,border:"1px solid #1e1e24",background:"#16161c",color:"#ddd",fontSize:10.5}}/>
            <span style={{position:"absolute",left:7,top:"50%",transform:"translateY(-50%)",color:"#3a3a3a",fontSize:9.5,pointerEvents:"none"}}>🔍</span>
          </div>
          {/* Q# filter */}
          <select value={fQNum} onChange={e=>setFQNum(e.target.value)} style={{padding:"5px 6px",borderRadius:4,border:"1px solid #1e1e24",background:"#16161c",color:fQNum?"#e8c170":"#555",fontSize:10,cursor:"pointer",minWidth:60}}>
            <option value="">Q#</option>{allQNums.map(n=><option key={n} value={n}>Q{n}</option>)}
          </select>
          {/* Year filter */}
          <select value={fYear} onChange={e=>setFYear(e.target.value)} style={{padding:"5px 6px",borderRadius:4,border:"1px solid #1e1e24",background:"#16161c",color:fYear?"#e8c170":"#555",fontSize:10,cursor:"pointer",minWidth:60}}>
            <option value="">Year</option>{allYears.map(y=><option key={y} value={y}>{y}</option>)}
          </select>
          {/* Semester filter */}
          <select value={fSem} onChange={e=>setFSem(e.target.value)} style={{padding:"5px 6px",borderRadius:4,border:"1px solid #1e1e24",background:"#16161c",color:fSem?"#e8c170":"#555",fontSize:10,cursor:"pointer",minWidth:80}}>
            <option value="">Semester</option>{allSems.map(s=><option key={s} value={s}>{shortSem(s)}</option>)}
          </select>
          {/* Difficulty filter */}
          <select value={fDiff} onChange={e=>setFDiff(e.target.value)} style={{padding:"5px 6px",borderRadius:4,border:"1px solid #1e1e24",background:"#16161c",color:fDiff?"#e8c170":"#555",fontSize:10,cursor:"pointer",minWidth:80}}>
            <option value="">Difficulty</option>{[["easy","Easy"],["medium","Medium"],["hard","Hard"]].map(([v,l])=><option key={v} value={v}>{l}</option>)}
          </select>
          {/* View status */}
          <select value={viewStatus} onChange={e=>setViewStatus(e.target.value)} style={{padding:"5px 6px",borderRadius:4,border:"1px solid #1e1e24",background:"#16161c",color:viewStatus!=="all"?"#e8c170":"#555",fontSize:10,cursor:"pointer",minWidth:90}}>
            {[["all","All"],["complete","Complete"],["incomplete","Incomplete"],["revisit","Revisit"]].map(([v,l])=><option key={v} value={v}>{l}</option>)}
          </select>
          <select value={fAssess} onChange={e=>setFAssess(e.target.value)} style={{padding:"5px 6px",borderRadius:4,border:"1px solid #1e1e24",background:"#16161c",color:fAssess?"#e8c170":"#555",fontSize:10,cursor:"pointer",minWidth:100}}>
            <option value="">Assessability</option>
            <option value="assessable">Examinable Only</option>
            <option value="likely">Likely on Exam</option>
          </select>
          {hasFilters && <button onClick={clearFilters} style={{background:"none",border:"1px solid #2a2a2a",borderRadius:4,color:"#666",fontSize:9,cursor:"pointer",padding:"3px 7px",fontFamily:S.mono,whiteSpace:"nowrap"}}>Clear</button>}
        </>}
        <div style={{marginLeft:"auto",flexShrink:0}}>
          <button onClick={()=>setShowSettings(true)} style={{background:"none",border:"1px solid #1e1e26",borderRadius:4,color:apiKey?"#555":"#f87171",fontSize:12,cursor:"pointer",padding:"4px 8px"}} title="Settings">⚙</button>
        </div>
      </div>

      <div style={{flex:1,overflowY:"auto"}}>
        {!activeSub ? (
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",padding:40,textAlign:"center"}}>
            <div style={{width:60,height:60,borderRadius:14,background:"linear-gradient(135deg,#e8c170,#c9923a)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,marginBottom:16,boxShadow:"0 6px 30px #e8c17020"}}>📖</div>
            <h1 style={{fontFamily:S.display,fontSize:26,fontWeight:800,color:"#e8c170",marginBottom:6}}>StudyVault</h1>
            <p style={{color:"#4a4a4a",maxWidth:360,lineHeight:1.6,fontSize:12,marginBottom:16}}>Upload past exams. AI extracts, tags, and ranks every question. Analytics, study planner, and custom paper generation.</p>
            <button onClick={()=>setShowNew(true)} style={{background:"linear-gradient(135deg,#e8c170,#c9923a)",color:"#0c0c0f",border:"none",borderRadius:7,padding:"9px 22px",fontSize:12,fontWeight:700,cursor:"pointer"}}>+ Create Subject</button>
          </div>
        ) : (
          <div style={{maxWidth:940,margin:"0 auto",padding:"16px 16px 50px"}}>
            {/* Header */}
            <div style={{marginBottom:12,display:"flex",alignItems:"baseline",gap:10}}>
              <h2 style={{fontFamily:S.display,fontSize:20,fontWeight:800,color:"#e8c170"}}>{activeSub}</h2>
              {subj?.courseCode && <span style={{fontSize:10,color:"#555",fontFamily:S.mono}}>{subj.courseCode}</span>}
              <span style={{fontSize:9,color:"#3a3a3a",fontFamily:S.mono}}>{subj.questions.length} qs · {subj.papers.length} papers</span>
            </div>

            {/* ═══ QUESTIONS VIEW ═══ */}
            {mainView==="questions" && <>
              {/* Tag filter panel */}
              {subj.questions.length>0 && <div style={{padding:11,background:"#14141a",borderRadius:8,border:"1px solid #1e1e26",marginBottom:12}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:sortedHierarchy.length?5:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <button onClick={()=>setShowTags(!showTags)} style={{background:showTags?"#e8c17015":"none",border:"1px solid #222",borderRadius:3,color:showTags?"#e8c170":"#666",fontSize:8.5,cursor:"pointer",padding:"2px 6px",fontFamily:S.mono}}>🏷 Tags</button>
                    <button onClick={()=>setShowWeights(!showWeights)} style={{background:"none",border:"1px solid #222",borderRadius:3,color:"#666",fontSize:8.5,cursor:"pointer",padding:"2px 6px",fontFamily:S.mono}}>⚖️ Weights</button>
                    {/* Paper filter */}
                    <select value={fPaper} onChange={e=>setFPaper(e.target.value)} style={{padding:"3px 5px",borderRadius:3,border:"1px solid #1e1e24",background:"#16161c",color:fPaper?"#e8c170":"#555",fontSize:9,cursor:"pointer"}}>
                      <option value="">All Papers</option>{allPapers.map(p=><option key={p.id} value={p.id}>{(p.stdName||p.name).slice(0,26)}</option>)}
                    </select>
                    {/* Grouping */}
                    <select value={viewMode} onChange={e=>setViewMode(e.target.value)} style={{padding:"3px 5px",borderRadius:3,border:"1px solid #1e1e24",background:"#16161c",color:"#555",fontSize:9,cursor:"pointer"}}>
                      {[["all","No Group"],["by-paper","By Paper"],["by-topic","By Topic"],["by-semester","By Semester"],["by-qnum","By Q#"]].map(([v,l])=><option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:5}}>
                    {hasFilters && <span style={{fontSize:9,color:"#e8c170",fontFamily:S.mono}}>{filtered.length}/{subj.questions.length}</span>}
                    <button onClick={handleGenPdf} disabled={genning||!filtered.length} style={{background:genning?"#1a1a1a":"linear-gradient(135deg,#34d399,#22a06b)",color:genning?"#666":"#fff",border:"none",borderRadius:4,padding:"3px 9px",fontSize:9,fontWeight:700,cursor:genning?"wait":"pointer",fontFamily:S.mono}}>{genning?"Gen...":"⬇ PDF"}</button>
                  </div>
                </div>

                {showWeights && <WeightPanel papers={allPapers} mode={wMode} params={wParams} setMode={setWMode} setParams={setWParams} onClose={()=>setShowWeights(false)}/>}

                {/* Hierarchical Tags */}
                {showTags && sortedHierarchy.length>0 && <div style={{marginTop:8}}>
                  <div onClick={()=>setTagsExpanded(!tagsExpanded)} style={{cursor:"pointer",display:"flex",alignItems:"center",gap:5,marginBottom:tagsExpanded?6:0}}>
                    <span style={{fontSize:9,fontWeight:700,color:"#888",fontFamily:S.mono}}>{tagsExpanded?"▾":"▸"} Topics</span>
                    <span style={{fontSize:8,color:"#444",fontFamily:S.mono}}>({sortedHierarchy.reduce((s,h)=>s+h.count,0)})</span>
                  </div>
                  {tagsExpanded && sortedHierarchy.map(({parent, count, tags})=>{
                    const groupOpen = !!expandedGroups[parent];
                    return <div key={parent} style={{marginBottom:4}}>
                    <div onClick={()=>setExpandedGroups(p=>({...p,[parent]:!p[parent]}))} style={{cursor:"pointer",display:"flex",alignItems:"center",gap:5,marginBottom:groupOpen?3:0,paddingLeft:8}}>
                      <span style={{fontSize:9,fontWeight:700,color:fParent===parent?"#7C3AED":"#666",fontFamily:S.mono}}>{groupOpen?"▾":"▸"} {parent}</span>
                      <span style={{fontSize:8,color:"#444",fontFamily:S.mono}}>({count})</span>
                      <span onClick={e=>{e.stopPropagation();setFParent(fParent===parent?"":parent)}} style={{fontSize:7.5,color:fParent===parent?"#7C3AED":"#555",fontFamily:S.mono,padding:"1px 4px",borderRadius:3,border:`1px solid ${fParent===parent?"#7C3AED33":"#222"}`,cursor:"pointer"}}>filter</span>
                    </div>
                    {groupOpen && <div style={{display:"flex",flexWrap:"wrap",gap:3,paddingLeft:18}}>
                      {tags.map(t=><Tag key={t} tag={t} small count={tagCounts[t]} onClick={()=>toggleTag(t)} selected={fTags.includes(t)}/>)}
                    </div>}
                  </div>;})}
                </div>}
              </div>}

              {/* Questions */}
              {Object.entries(grouped).map(([g,qs])=><div key={g} style={{marginBottom:16}}>
                {viewMode!=="all"&&<div style={{fontSize:11,fontWeight:700,color:"#555",padding:"5px 0",borderBottom:"1px solid #1e1e26",marginBottom:6,display:"flex",justifyContent:"space-between"}}><span>{g}</span><span style={{fontSize:8.5,color:"#3a3a3a",fontFamily:S.mono}}>{qs.length}</span></div>}
                <div style={{display:"flex",flexDirection:"column",gap:4}}>
                  {qs.map(q=><QCard key={q.id} q={q} exp={expId===q.id} onToggle={()=>setExpId(expId===q.id?null:q.id)} onSolve={handleSolve} solving={solvingId===q.id} solution={solutions[q.id]} onViewPaper={id=>{const pp=pMap[id];if(pp)setViewPaper(pp)}} pageImg={getPageImg(q)} showTags={showTags} paper={pMap[q.paperId]} status={qStatus[q.id]} onSetStatus={setQuestionStatus}/>)}
                </div>
              </div>)}
              {subj.questions.length>0&&!filtered.length&&<div style={{textAlign:"center",padding:30,color:"#3a3a3a"}}><div style={{fontSize:24,marginBottom:6,opacity:.3}}>🔍</div><div style={{fontSize:12}}>No matches</div><button onClick={clearFilters} style={{marginTop:6,background:"none",border:"1px solid #222",borderRadius:4,color:"#555",padding:"3px 8px",fontSize:10,cursor:"pointer"}}>Clear</button></div>}
              {!subj.questions.length&&!proc&&<div style={{textAlign:"center",padding:40,color:"#2a2a2a",fontSize:12}}>Upload exam papers using the sidebar →</div>}
            </>}

            {/* ═══ ANALYTICS VIEW ═══ */}
            {mainView==="analytics" && <>
              {/* Controls bar */}
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:12,flexWrap:"wrap"}}>
                <select value={analyticsSemFilter} onChange={e=>setAnalyticsSemFilter(e.target.value)} style={{padding:"5px 8px",borderRadius:5,border:"1px solid #1e1e24",background:"#16161c",color:"#ccc",fontSize:10.5,cursor:"pointer",minWidth:140}}>
                  <option value="">All Semesters</option>
                  {allSems.map(s=><option key={s} value={s}>{s}</option>)}
                </select>
                <label style={{fontSize:9,color:"#666",fontFamily:S.mono,display:"flex",alignItems:"center",gap:4,cursor:"pointer"}}>
                  <input type="checkbox" checked={useWeights} onChange={e=>setUseWeights(e.target.checked)} style={{accentColor:"#e8c170"}}/>
                  Weighted ({wMode})
                </label>
                <button onClick={()=>setShowWeights(!showWeights)} style={{background:"none",border:"1px solid #222",borderRadius:3,color:"#666",fontSize:8.5,cursor:"pointer",padding:"2px 6px",fontFamily:S.mono}}>⚖️ Configure</button>
                {analyticsSemFilter && <span style={{fontSize:9,color:"#e8c170",fontFamily:S.mono}}>Showing: {analyticsSemFilter} only</span>}
              </div>
              {showWeights && <WeightPanel papers={allPapers} mode={wMode} params={wParams} setMode={setWMode} setParams={setWParams} onClose={()=>setShowWeights(false)}/>}

              {!analyticsData ? <div style={{textAlign:"center",padding:40,color:"#3a3a3a"}}>{analyticsSemFilter ? `No ${analyticsSemFilter} exams found` : "Upload papers to see analytics"}</div> : <>
                {/* Summary cards */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:12}}>
                  {[
                    {label:"Exams",value:analyticsData.paperCount,icon:"📄",color:"#e8c170"},
                    {label:"Questions",value:analyticsData.questionCount,icon:"❓",color:"#60a5fa"},
                    {label:"Avg Difficulty",value:`${analyticsData.allAvgDiff}/3`,icon:"🎯",color:analyticsData.allAvgDiff>2.2?"#f87171":analyticsData.allAvgDiff>1.5?"#fbbf24":"#34d399"},
                    {label:analyticsData.hardestExam?"Hardest":"—",value:analyticsData.hardestExam?`${analyticsData.hardestExam.avgDiff}/3`:"—",icon:"🔥",color:"#f87171",sub:analyticsData.hardestExam?.name},
                  ].map((c,i)=><div key={i} style={{background:"#14141a",borderRadius:7,border:"1px solid #1e1e26",padding:"10px 12px"}}>
                    <div style={{fontSize:9,color:"#555",fontFamily:S.mono,marginBottom:4}}>{c.icon} {c.label}</div>
                    <div style={{fontSize:18,fontWeight:800,color:c.color,fontFamily:S.mono}}>{c.value}</div>
                    {c.sub && <div style={{fontSize:8,color:"#444",fontFamily:S.mono,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.sub}</div>}
                  </div>)}
                </div>

                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  {/* Difficulty Comparison — the main new chart */}
                  <div style={{background:"#14141a",borderRadius:8,border:"1px solid #1e1e26",padding:14,gridColumn:"1/3"}}>
                    <div style={{fontSize:10,fontWeight:700,color:"#888",marginBottom:4,fontFamily:S.mono}}>📊 EXAM DIFFICULTY COMPARISON{analyticsSemFilter?` (${analyticsSemFilter})`:""}</div>
                    <div style={{fontSize:8.5,color:"#444",marginBottom:10}}>Average difficulty score per exam (1=easy, 2=medium, 3=hard). Compare across years{analyticsSemFilter?` for ${analyticsSemFilter} exams only`:""}</div>
                    <ResponsiveContainer width="100%" height={Math.max(180, analyticsData.diffComparison.length * 32)}>
                      <BarChart data={analyticsData.diffComparison} layout="vertical" margin={{left:140,right:30}}>
                        <CartesianGrid strokeDasharray="3 3"/>
                        <XAxis type="number" domain={[0,3]} ticks={[0,1,2,3]} tick={{fontSize:10}}/>
                        <YAxis type="category" dataKey="name" width={130} tick={{fontSize:9}}/>
                        <Tooltip contentStyle={{background:"#1a1a1f",border:"1px solid #2a2a2a",borderRadius:6,fontSize:11}} formatter={(v)=>[`${v}/3`,"Avg Difficulty"]}/>
                        <Bar dataKey="avgDiff" radius={[0,4,4,0]}>
                          {analyticsData.diffComparison.map((e,i)=><Cell key={i} fill={e.avgDiff>2.2?"#f87171":e.avgDiff>1.5?"#fbbf24":"#34d399"}/>)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Difficulty Trend */}
                  {analyticsData.diffTrend.length>1 && <div style={{background:"#14141a",borderRadius:8,border:"1px solid #1e1e26",padding:14,gridColumn:"1/3"}}>
                    <div style={{fontSize:10,fontWeight:700,color:"#888",marginBottom:10,fontFamily:S.mono}}>📈 DIFFICULTY TREND OVER YEARS{analyticsSemFilter?` (${analyticsSemFilter})`:""}</div>
                    <ResponsiveContainer width="100%" height={180}>
                      <LineChart data={analyticsData.diffTrend} margin={{left:10,right:10}}>
                        <CartesianGrid strokeDasharray="3 3"/>
                        <XAxis dataKey="year" tick={{fontSize:10}}/><YAxis domain={[0,3]} ticks={[0,1,2,3]} tick={{fontSize:10}}/>
                        <Tooltip contentStyle={{background:"#1a1a1f",border:"1px solid #2a2a2a",borderRadius:6,fontSize:11}} formatter={(v)=>[`${v}/3`,"Avg Difficulty"]}/>
                        <Line type="monotone" dataKey="avgDifficulty" stroke="#f87171" strokeWidth={2.5} dot={{r:4,fill:"#f87171"}}/>
                      </LineChart>
                    </ResponsiveContainer>
                  </div>}

                  {/* Topic Frequency */}
                  <div style={{background:"#14141a",borderRadius:8,border:"1px solid #1e1e26",padding:14,gridColumn:"1/3"}}>
                    <div style={{fontSize:10,fontWeight:700,color:"#888",marginBottom:10,fontFamily:S.mono}}>📊 TOPIC FREQUENCY{analyticsSemFilter?` (${analyticsSemFilter})`:""}</div>
                    <ResponsiveContainer width="100%" height={Math.max(180, analyticsData.topicFreq.length*28)}>
                      <BarChart data={analyticsData.topicFreq} layout="vertical" margin={{left:100,right:20}}>
                        <CartesianGrid strokeDasharray="3 3"/><XAxis type="number"/><YAxis type="category" dataKey="name" width={90} tick={{fontSize:10}}/>
                        <Tooltip contentStyle={{background:"#1a1a1f",border:"1px solid #2a2a2a",borderRadius:6,fontSize:11}}/>
                        <Bar dataKey="count" radius={[0,4,4,0]}>{analyticsData.topicFreq.map((e,i)=><Cell key={i} fill={CHART_COLORS[i%CHART_COLORS.length]}/>)}</Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Topic Trend */}
                  {analyticsData.yearSet.length>1 && <div style={{background:"#14141a",borderRadius:8,border:"1px solid #1e1e26",padding:14,gridColumn:"1/3"}}>
                    <div style={{fontSize:10,fontWeight:700,color:"#888",marginBottom:10,fontFamily:S.mono}}>📈 TOPIC TRENDS OVER YEARS (avg questions per exam)</div>
                    <ResponsiveContainer width="100%" height={220}>
                      <LineChart data={analyticsData.topicTrend} margin={{left:10,right:10}}>
                        <CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="year" tick={{fontSize:10}}/><YAxis tick={{fontSize:10}}/>
                        <Tooltip contentStyle={{background:"#1a1a1f",border:"1px solid #2a2a2a",borderRadius:6,fontSize:11}} formatter={(value,name)=>[value,name]} itemSorter={item=>-(item.value||0)}/>
                        <Legend wrapperStyle={{fontSize:10}}/>
                        {analyticsData.parentTopics.map((pt,i)=><Line key={pt} type="monotone" dataKey={pt} stroke={CHART_COLORS[i%CHART_COLORS.length]} strokeWidth={2} dot={{r:3}}/>)}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>}

                  {/* Difficulty stacked per exam */}
                  <div style={{background:"#14141a",borderRadius:8,border:"1px solid #1e1e26",padding:14}}>
                    <div style={{fontSize:10,fontWeight:700,color:"#888",marginBottom:10,fontFamily:S.mono}}>🎯 DIFFICULTY BREAKDOWN</div>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={analyticsData.diffPerExam} margin={{left:0,right:0}}>
                        <CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="name" tick={{fontSize:8}} angle={-20} textAnchor="end" height={50}/><YAxis tick={{fontSize:10}}/>
                        <Tooltip contentStyle={{background:"#1a1a1f",border:"1px solid #2a2a2a",borderRadius:6,fontSize:11}}/>
                        <Bar dataKey="easy" stackId="a" fill="#34d399"/><Bar dataKey="medium" stackId="a" fill="#fbbf24"/><Bar dataKey="hard" stackId="a" fill="#f87171" radius={[3,3,0,0]}/>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Topic Pie */}
                  <div style={{background:"#14141a",borderRadius:8,border:"1px solid #1e1e26",padding:14}}>
                    <div style={{fontSize:10,fontWeight:700,color:"#888",marginBottom:10,fontFamily:S.mono}}>🥧 TOPIC DISTRIBUTION</div>
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart><Pie data={analyticsData.topicPie} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({name,percent})=>`${name} ${(percent*100).toFixed(0)}%`} labelLine={false} style={{fontSize:9}}>
                        {analyticsData.topicPie.map((e,i)=><Cell key={i} fill={CHART_COLORS[i%CHART_COLORS.length]}/>)}
                      </Pie><Tooltip contentStyle={{background:"#1a1a1f",border:"1px solid #2a2a2a",borderRadius:6,fontSize:11}}/></PieChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Top Tags */}
                  <div style={{background:"#14141a",borderRadius:8,border:"1px solid #1e1e26",padding:14,gridColumn:"1/3"}}>
                    <div style={{fontSize:10,fontWeight:700,color:"#888",marginBottom:10,fontFamily:S.mono}}>🏷️ TOP 15 TAGS{analyticsSemFilter?` (${analyticsSemFilter})`:""}</div>
                    <ResponsiveContainer width="100%" height={Math.max(160,analyticsData.topTags.length*22)}>
                      <BarChart data={analyticsData.topTags} layout="vertical" margin={{left:120,right:20}}>
                        <CartesianGrid strokeDasharray="3 3"/><XAxis type="number"/><YAxis type="category" dataKey="name" width={110} tick={{fontSize:9.5}}/>
                        <Tooltip contentStyle={{background:"#1a1a1f",border:"1px solid #2a2a2a",borderRadius:6,fontSize:11}}/>
                        <Bar dataKey="count" radius={[0,3,3,0]}>{analyticsData.topTags.map((e,i)=><Cell key={i} fill={CHART_COLORS[i%CHART_COLORS.length]}/>)}</Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </>}
            </>}

            {/* ═══ STUDY PLAN VIEW ═══ */}
            {mainView==="studyplan" && <>
              {!studyPlan.length ? <div style={{textAlign:"center",padding:40,color:"#3a3a3a"}}>Upload papers to generate study plan</div> : <>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,flexWrap:"wrap"}}>
                  <label style={{fontSize:9,color:"#666",fontFamily:S.mono,display:"flex",alignItems:"center",gap:4,cursor:"pointer"}}>
                    <input type="checkbox" checked={useWeights} onChange={e=>setUseWeights(e.target.checked)} style={{accentColor:"#e8c170"}}/>
                    Apply Exam Weights ({wMode})
                  </label>
                  <button onClick={()=>setShowWeights(!showWeights)} style={{background:"none",border:"1px solid #222",borderRadius:3,color:"#666",fontSize:8.5,cursor:"pointer",padding:"2px 6px",fontFamily:S.mono}}>⚖️ Configure</button>
                </div>
                {showWeights && <WeightPanel papers={allPapers} mode={wMode} params={wParams} setMode={setWMode} setParams={setWParams} onClose={()=>setShowWeights(false)}/>}

                <div style={{background:"#14141a",borderRadius:8,border:"1px solid #1e1e26",padding:14,marginBottom:12}}>
                  <div style={{fontSize:10,fontWeight:700,color:"#888",marginBottom:4,fontFamily:S.mono}}>🎯 OPTIMAL STUDY ORDER — Most Rewarding → Least</div>
                  <div style={{fontSize:9,color:"#555",marginBottom:10}}>Score = (Frequency × Avg Marks × Appearance%) / Difficulty. Study the top topics first for maximum marks per effort.</div>
                  <div style={{display:"flex",flexDirection:"column",gap:5}}>
                    {studyPlan.map(e=><div key={e.topic} style={{background:"#111115",borderRadius:7,border:"1px solid #1c1c22",padding:"10px 12px"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                        <span style={{background:e.priority==="High"?"#34d39920":e.priority==="Medium"?"#fbbf2420":"#f8717120",color:e.priority==="High"?"#34d399":e.priority==="Medium"?"#fbbf24":"#f87171",fontSize:8.5,fontWeight:800,padding:"2px 6px",borderRadius:3,fontFamily:S.mono}}>#{e.rank}</span>
                        <span style={{fontSize:12,fontWeight:700,color:"#ddd"}}>{e.topic}</span>
                        <span style={{fontSize:8.5,fontWeight:700,padding:"2px 7px",borderRadius:3,background:e.priority==="High"?"#34d39915":e.priority==="Medium"?"#fbbf2415":"#f8717115",color:e.priority==="High"?"#34d399":e.priority==="Medium"?"#fbbf24":"#f87171",fontFamily:S.mono}}>{e.priority} Priority</span>
                        <span style={{marginLeft:"auto",fontSize:9,color:"#555",fontFamily:S.mono}}>Top {e.rank} covers {e.cumCoverage}% of marks</span>
                      </div>
                      {/* Reward bar */}
                      <div style={{height:6,background:"#1e1e26",borderRadius:3,overflow:"hidden",marginBottom:6}}>
                        <div style={{height:"100%",width:`${e.pct}%`,borderRadius:3,background:`linear-gradient(90deg,${e.priority==="High"?"#34d399":e.priority==="Medium"?"#fbbf24":"#f87171"},${e.priority==="High"?"#22a06b":e.priority==="Medium"?"#d29922":"#d73a49"})`,transition:"width .4s"}}/>
                      </div>
                      <div style={{display:"flex",gap:12,flexWrap:"wrap",fontSize:9,color:"#666",fontFamily:S.mono}}>
                        <span>📊 {e.count} questions</span>
                        <span>📝 Avg {e.avgMarks}m</span>
                        <span>📈 {e.appearPct}% of exams</span>
                        <span>🎯 Difficulty {e.avgDiff}/3</span>
                        <span style={{color:"#e8c170"}}>⭐ Score {e.reward.toFixed(1)}</span>
                      </div>
                      {/* Child tags */}
                      <div style={{display:"flex",flexWrap:"wrap",gap:3,marginTop:6}}>
                        {(hierarchy[e.topic]||[]).sort((a,b)=>(tagCounts[b]||0)-(tagCounts[a]||0)).map(t=><Tag key={t} tag={t} small count={tagCounts[t]}/>)}
                      </div>
                    </div>)}
                  </div>
                </div>
              </>}
            </>}
          </div>
        )}
      </div>
    </div>

    {viewPaper && <PdfModal paper={viewPaper} onClose={()=>setViewPaper(null)}/>}
    {genUrl && <GenPdfModal url={genUrl} count={filtered.length} onClose={()=>setGenUrl(null)}/>}

    {/* Settings Modal */}
    {showSettings && <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",backdropFilter:"blur(4px)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setShowSettings(false)}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#16161c",border:"1px solid #2a2a30",borderRadius:10,padding:24,width:420,maxWidth:"90vw",maxHeight:"85vh",overflowY:"auto",boxShadow:"0 20px 60px rgba(0,0,0,.5)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <span style={{fontSize:14,fontWeight:700,color:"#ddd"}}>Settings</span>
          <button onClick={()=>setShowSettings(false)} style={{background:"none",border:"none",color:"#666",fontSize:16,cursor:"pointer"}}>×</button>
        </div>

        {/* API Key */}
        <div style={{marginBottom:20}}>
          <label style={{fontSize:9,color:"#888",textTransform:"uppercase",letterSpacing:".1em",fontWeight:700,fontFamily:S.mono,display:"block",marginBottom:5}}>API Key</label>
          <input type="password" value={apiKey} onChange={e=>{setApiKey(e.target.value);try{localStorage.setItem("sv:api_key",e.target.value)}catch{}}} placeholder="sk-ant-..." style={{width:"100%",padding:"7px 10px",borderRadius:5,border:"1px solid #2a2a30",background:"#111115",color:"#ccc",fontSize:11,fontFamily:S.mono,boxSizing:"border-box"}}/>
          <div style={{fontSize:8,color:apiKey?"#34d399":"#f87171",marginTop:4,fontFamily:S.mono}}>{apiKey?"Key set":"No key — add your Anthropic API key to use the app"}</div>
        </div>

        {/* Model Selection */}
        <div style={{marginBottom:16}}>
          <label style={{fontSize:9,color:"#888",textTransform:"uppercase",letterSpacing:".1em",fontWeight:700,fontFamily:S.mono,display:"block",marginBottom:10}}>Model Selection</label>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {[
              { key: "extract", label: "Extraction", desc: "OCR & text extraction from PDFs", value: modelExtract, set: setModelExtract, def: DEFAULT_EXTRACT },
              { key: "classify", label: "Classification", desc: "Tagging, topics & difficulty rating", value: modelClassify, set: setModelClassify, def: DEFAULT_CLASSIFY },
              { key: "solve", label: "Solutions", desc: "Step-by-step question solving", value: modelSolve, set: setModelSolve, def: DEFAULT_SOLVE },
            ].map(({key, label, desc, value, set, def}) => <div key={key} style={{background:"#111115",borderRadius:6,padding:"10px 12px",border:"1px solid #1e1e26"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                <span style={{fontSize:10.5,fontWeight:600,color:"#ccc"}}>{label}</span>
                {value !== def && <button onClick={()=>{set(def);setModelSetting(key,def)}} style={{background:"none",border:"1px solid #2a2a30",borderRadius:3,color:"#555",fontSize:7.5,cursor:"pointer",padding:"1px 5px",fontFamily:S.mono}}>Reset</button>}
              </div>
              <div style={{fontSize:8,color:"#555",marginBottom:6,fontFamily:S.mono}}>{desc}</div>
              <select value={value} onChange={e=>{set(e.target.value);setModelSetting(key,e.target.value)}} style={{width:"100%",padding:"5px 8px",borderRadius:4,border:"1px solid #2a2a30",background:"#16161c",color:"#aaa",fontSize:10,cursor:"pointer",fontFamily:S.mono}}>
                {MODEL_OPTIONS.map(m=><option key={m.id} value={m.id}>{m.label} — {m.tier}</option>)}
              </select>
            </div>)}
          </div>
        </div>

        {/* Clear Data */}
        <div style={{borderTop:"1px solid #1e1e26",paddingTop:14,marginTop:8}}>
          <label style={{fontSize:9,color:"#888",textTransform:"uppercase",letterSpacing:".1em",fontWeight:700,fontFamily:S.mono,display:"block",marginBottom:8}}>Danger Zone</label>
          <button onClick={async()=>{if(window.confirm("Delete ALL saved data? This cannot be undone.")){for(const[,d] of Object.entries(subjects)){d.papers?.forEach(p=>storageDel(`pdf:${p.id}`))}await storageDel("app:subjects");await storageDel("app:active");await storageDel("app:weights");setSubjects({});setActiveSub(null);setSaveStatus("Data cleared");setShowSettings(false)}}} style={{width:"100%",background:"#f8717108",border:"1px solid #f8717133",borderRadius:5,color:"#f87171",fontSize:10,cursor:"pointer",padding:"6px 0",fontFamily:S.mono,fontWeight:600}}>Clear All Data</button>
        </div>

        <div style={{fontSize:8,color:"#3a3a3a",fontFamily:S.mono,textAlign:"center",marginTop:12}}>Settings are saved automatically</div>
      </div>
    </div>}
  </div>;
}
