import { useState } from "react";

const S = { body: "var(--f-body)", mono: "var(--f-mono)", display: "var(--f-display)" };

export function ParentQuestionContext({ questionNumber, allQuestions, paperId, LatexText }) {
  const [collapsed, setCollapsed] = useState(false);

  // Check if this is a sub-part question
  if (!questionNumber || !/^\d+[a-z]/i.test(String(questionNumber))) return null;

  const parentNum = String(questionNumber).match(/^(\d+)/)[1];
  const parent = allQuestions?.find(q => String(q.question_number) === parentNum && q.paperId === paperId);
  if (!parent) return null;

  return (
    <div style={{
      background: "#0d111820",
      borderLeft: "3px solid #e8c17040",
      borderRadius: "0 8px 8px 0",
      padding: "12px 16px",
      marginBottom: 12,
    }}>
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          cursor: "pointer", userSelect: "none",
        }}
      >
        <span style={{
          fontSize: 10, color: "#e8c170", fontWeight: 700,
          fontFamily: S.mono, textTransform: "uppercase",
          letterSpacing: ".08em",
        }}>
          Question {parentNum}
        </span>
        <span style={{ fontSize: 10, color: "var(--c-text4)" }}>
          {collapsed ? "\u25b8" : "\u25be"}
        </span>
      </div>
      {!collapsed && (
        <div style={{ marginTop: 8 }}>
          <LatexText
            text={parent.question_text}
            style={{ color: "#888", fontSize: 12.5, lineHeight: 1.7 }}
          />
        </div>
      )}
    </div>
  );
}
