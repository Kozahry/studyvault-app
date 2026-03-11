// Assessability system — parse course guides to identify examinable content

/**
 * Parse an uploaded document using Claude AI to identify assessable topics.
 * @param {string} b64 - base64 encoded document
 * @param {string} mediaType - MIME type
 * @param {string[]} existingTags - all tags in the subject
 * @param {string[]} existingParentTopics - all parent topics
 * @param {Function} callClaudeFn - (model, messages, maxTokens) => string
 * @param {string} model - model ID to use for the API call
 * @returns {{ assessable: Array<{tag: string, likelihood: string}>, nonAssessable: string[], notes: string }}
 */
export async function parseAssessabilityDoc(b64, mediaType, existingTags, existingParentTopics, callClaudeFn, model) {
  const isImg = mediaType.startsWith("image/");

  const text = await callClaudeFn(model, [{ role: "user", content: [
    { type: isImg ? "image" : "document", source: { type: "base64", media_type: mediaType, data: b64 } },
    { type: "text", text: `You are an expert at analyzing course guides and exam information sheets. Your job is to determine which topics are assessable (will appear on the exam) and which are not.

Here are the existing tags in this subject's question bank:
${existingTags.map(t => `- ${t}`).join("\n")}

Here are the parent topic categories:
${existingParentTopics.map(t => `- ${t}`).join("\n")}

Analyze the uploaded document and identify:
1. Which of the existing tags are assessable (examinable)
2. Which are NOT assessable (explicitly excluded from the exam)
3. For assessable tags, estimate likelihood of appearing on the exam: "high", "medium", or "low"

Respond ONLY with a JSON object (no markdown, no backticks):
{
  "assessable": [
    { "tag": "exact_tag_name_from_list", "likelihood": "high"|"medium"|"low" }
  ],
  "nonAssessable": ["exact_tag_name_from_list"],
  "notes": "Brief summary of exam scope/rules found in the document"
}

IMPORTANT:
- Use the EXACT tag names from the provided list above. Match as closely as possible.
- If a tag is not mentioned in the document at all, do NOT include it in either list.
- Only mark something as nonAssessable if the document explicitly excludes it.
- "high" = explicitly listed as exam content or heavily emphasized
- "medium" = mentioned as part of the course but not specifically highlighted for exam
- "low" = briefly mentioned or tangentially related to exam content` }
  ]}], 4096);

  try {
    const parsed = JSON.parse((text || "{}").replace(/```json|```/g, "").trim());
    return {
      assessable: parsed.assessable || [],
      nonAssessable: parsed.nonAssessable || [],
      notes: parsed.notes || "",
    };
  } catch {
    return { assessable: [], nonAssessable: [], notes: "Failed to parse AI response" };
  }
}

/**
 * Filter questions by assessability config.
 * @param {Array} questions
 * @param {Object} assessabilityConfig - { tags: { tag_name: { assessable, likelihood } } }
 * @param {string} mode - "" | "assessable" | "likely"
 * @returns {Array} filtered questions
 */
export function filterByAssessability(questions, assessabilityConfig, mode) {
  if (!mode || !assessabilityConfig?.tags) return questions;
  const tags = assessabilityConfig.tags;

  if (mode === "assessable") {
    // Hide question only if ALL its tags are marked non-assessable
    return questions.filter(q => {
      if (!q.tags?.length) return true;
      return !q.tags.every(t => tags[t]?.assessable === false);
    });
  }

  if (mode === "likely") {
    // Show only questions that have at least one tag with high likelihood
    return questions.filter(q => {
      return q.tags?.some(t => tags[t]?.likelihood === "high");
    });
  }

  return questions;
}

/**
 * Fuzzy match an AI-returned tag name to the closest system tag.
 * @param {string} aiTag
 * @param {string[]} systemTags
 * @returns {string|null}
 */
function fuzzyMatchTag(aiTag, systemTags) {
  if (!aiTag) return null;
  const normalized = aiTag.toLowerCase().replace(/[\s_-]+/g, "_").trim();

  // Exact match first
  const exact = systemTags.find(t => t.toLowerCase() === normalized || t.toLowerCase() === aiTag.toLowerCase());
  if (exact) return exact;

  // Underscore/space variants
  const spaced = normalized.replace(/_/g, " ");
  const match = systemTags.find(t => {
    const tNorm = t.toLowerCase().replace(/[\s_-]+/g, " ");
    return tNorm === spaced || tNorm === normalized.replace(/_/g, " ");
  });
  if (match) return match;

  // Substring containment (prefer shorter system tags that are fully contained)
  const contains = systemTags.filter(t => {
    const tLow = t.toLowerCase().replace(/[\s_-]+/g, " ");
    return spaced.includes(tLow) || tLow.includes(spaced);
  });
  if (contains.length === 1) return contains[0];
  if (contains.length > 1) {
    // Pick the closest length match
    contains.sort((a, b) => Math.abs(a.length - aiTag.length) - Math.abs(b.length - aiTag.length));
    return contains[0];
  }

  return null;
}

/**
 * Merge AI parse results with existing manual config.
 * @param {{ assessable: Array<{tag: string, likelihood: string}>, nonAssessable: string[], notes: string }} aiResult
 * @param {{ sourceDoc: object|null, tags: object }} existingConfig
 * @returns {{ sourceDoc: object|null, tags: object }}
 */
export function mergeAssessabilityResults(aiResult, existingConfig) {
  const merged = {
    sourceDoc: existingConfig?.sourceDoc || null,
    tags: { ...(existingConfig?.tags || {}) },
  };

  // Collect all known system tags from existing config
  const systemTags = Object.keys(merged.tags);

  // Process assessable tags from AI
  for (const item of (aiResult.assessable || [])) {
    const matchedTag = fuzzyMatchTag(item.tag, systemTags) || item.tag;
    merged.tags[matchedTag] = {
      ...(merged.tags[matchedTag] || {}),
      assessable: true,
      likelihood: item.likelihood || null,
    };
  }

  // Process non-assessable tags from AI
  for (const tag of (aiResult.nonAssessable || [])) {
    const matchedTag = fuzzyMatchTag(tag, systemTags) || tag;
    merged.tags[matchedTag] = {
      ...(merged.tags[matchedTag] || {}),
      assessable: false,
      likelihood: null,
    };
  }

  return merged;
}
