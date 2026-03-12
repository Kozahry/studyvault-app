import { useState, useEffect, useRef, useCallback, useMemo } from "react";

const API = "https://api.anthropic.com/v1/messages";
const DEFAULT_SOLVE = "claude-haiku-4-5-20251001";
const S = { body: "var(--f-body)", mono: "var(--f-mono)" };

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
function getModelSetting(key, fallback) {
  try { return localStorage.getItem(`sv:model:${key}`) || fallback; } catch { return fallback; }
}
async function callClaude(model, messages, maxTokens = 4096) {
  const resp = await fetch(API, { method: "POST", headers: apiHeaders(), body: JSON.stringify({ model, max_tokens: maxTokens, messages }) });
  const data = await resp.json();
  if (data.type === "error") throw new Error(data.error?.message || "API error");
  return data.content?.map(c => c.text || "").join("") || "";
}

// Cache explanations across all instances to avoid duplicate API calls
const explanationCache = new Map();

// ─── TermPopup ──────────────────────────────────────────────────────
function TermPopup({ term, questionContext, tags, anchorRect, onClose, LatexText }) {
  const [explanation, setExplanation] = useState(null);
  const [loading, setLoading] = useState(true);
  const popupRef = useRef(null);
  const tagsKey = (tags || []).join(",");

  useEffect(() => {
    const cacheKey = `${term}::${tagsKey}`;
    if (explanationCache.has(cacheKey)) {
      setExplanation(explanationCache.get(cacheKey));
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const prompt = `You are a patient tutor explaining a concept to a student.

Term: "${term}"
Question context: ${questionContext}
Topics: ${(tags || []).join(", ")}

Explain in THREE short sections (2-3 sentences each), using LaTeX ($...$) for any math:

**What is it?**
General definition of "${term}" — what it means in math/science.

**Why here?**
Why this concept appears in this specific question — what role it plays.

**How to do it?**
Brief practical steps to apply this concept.

Keep it concise and clear. Use LaTeX for math notation.`;
        const result = await callClaude(
          getModelSetting("solve", DEFAULT_SOLVE),
          [{ role: "user", content: prompt }],
          1024
        );
        if (!cancelled) {
          explanationCache.set(cacheKey, result);
          setExplanation(result);
        }
      } catch (e) {
        if (!cancelled) setExplanation("Failed to load explanation: " + e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [term, tagsKey, questionContext]);

  // Close on click outside
  useEffect(() => {
    const handler = (e) => {
      if (popupRef.current && !popupRef.current.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Smart positioning
  let top = anchorRect.bottom + 6;
  let left = anchorRect.left;
  const maxW = 380;
  if (typeof window !== "undefined") {
    if (top + 400 > window.innerHeight) top = anchorRect.top - 406;
    if (left + maxW > window.innerWidth) left = window.innerWidth - maxW - 12;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
  }

  return (
    <div ref={popupRef} style={{
      position: "fixed", top, left, zIndex: 500,
      background: "#0d1117", border: "1px solid #162d50", borderRadius: 10,
      maxWidth: maxW, maxHeight: 400, overflowY: "auto",
      padding: 16, boxShadow: "0 8px 32px rgba(0,0,0,.6)",
      fontFamily: S.body,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ color: "#e8c170", fontSize: 14, fontWeight: 700 }}>{term}</div>
        <button onClick={onClose} style={{
          background: "none", border: "none", color: "#666", fontSize: 18,
          cursor: "pointer", padding: "0 0 0 8px", lineHeight: 1,
        }}>&times;</button>
      </div>
      {loading ? (
        <div style={{ color: "#60a5fa", fontSize: 12, fontFamily: S.mono }}>Explaining...</div>
      ) : (
        <LatexText text={explanation} style={{ color: "#b0b0b8", fontSize: 12.5, lineHeight: 1.8 }} />
      )}
    </div>
  );
}

// ─── SolutionWithTerms ──────────────────────────────────────────────
export function SolutionWithTerms({ text, questionText, tags, LatexText, style }) {
  const containerRef = useRef(null);
  const [popup, setPopup] = useState(null);

  // Extract [[term]] markers and replace with indexed placeholders.
  // Use plain-text markers that survive LatexText's HTML escaping,
  // then post-process the rendered DOM to inject clickable spans.
  const { processed, terms } = useMemo(() => {
    const terms = [];
    const processed = (text || "").replace(
      /\[\[([^\]]+?)\]\]/g,
      (_, term) => {
        const idx = terms.length;
        terms.push(term);
        // Use SVTERM markers — plain alphanumeric text survives HTML escaping
        return `SVTERM_S_${idx}_${term}_SVTERM_E`;
      }
    );
    return { processed, terms };
  }, [text]);

  // After LatexText renders via innerHTML, replace placeholders with clickable spans
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !terms.length) return;
    const timer = setTimeout(() => {
      const latexEl = el.querySelector("div");
      if (!latexEl) return;
      let html = latexEl.innerHTML;
      terms.forEach((term, idx) => {
        const escapedTerm = term.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const placeholder = `SVTERM_S_${idx}_${escapedTerm}_SVTERM_E`;
        const spanHtml = `<span class="sv-term" data-term="${term.replace(/"/g, '&quot;')}" style="cursor:pointer;border-bottom:1px dashed #60a5fa;color:#60a5fa">${escapedTerm}</span>`;
        html = html.split(placeholder).join(spanHtml);
      });
      latexEl.innerHTML = html;
    }, 0);
    return () => clearTimeout(timer);
  }, [processed, terms]);

  // Delegated click handler for term spans
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e) => {
      const target = e.target.closest('.sv-term');
      if (!target) return;
      const term = target.dataset.term;
      if (!term) return;
      const rect = target.getBoundingClientRect();
      setPopup({ term, rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } });
    };
    el.addEventListener("click", handler);
    return () => el.removeEventListener("click", handler);
  }, []);

  const closePopup = useCallback(() => setPopup(null), []);

  return (
    <div ref={containerRef}>
      <LatexText text={processed} style={style} />
      {popup && (
        <TermPopup
          term={popup.term}
          questionContext={questionText || ""}
          tags={tags || []}
          anchorRect={popup.rect}
          onClose={closePopup}
          LatexText={LatexText}
        />
      )}
    </div>
  );
}
