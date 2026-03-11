// Practice Exam Generator — pure logic module

/**
 * Score a single question for practice exam inclusion.
 * Returns a numeric score (higher = more likely to be included).
 */
export function scorePracticeQuestion(question, { weights, tagCounts, qStatus, config, maxTagCount }) {
  // Topic frequency score: average frequency of question's tags, normalized
  const tags = question.tags || [];
  const mc = maxTagCount || Math.max(1, ...Object.values(tagCounts));
  const topicFrequencyScore = tags.length
    ? tags.reduce((sum, t) => sum + ((tagCounts[t] || 0) / mc), 0) / tags.length
    : 0.1;

  // Paper recency weight
  const paperRecencyWeight = weights[question.paperId] || 1;

  // Completion penalty
  const status = qStatus[question.id];
  const completed = status === "complete" || status === "revisit";
  const completionPenalty = (completed && config.avoidCompleted) ? 0.3 : 1.0;

  // Difficulty match score
  const diff = question.difficulty || "medium";
  let difficultyMatchScore = 1.0;
  if (config.difficultyMix === "easy" || config.difficultyMix === "medium" || config.difficultyMix === "hard") {
    difficultyMatchScore = diff === config.difficultyMix ? 1.5 : 0.5;
  }
  // "match" and "balanced" both use 1.0

  return topicFrequencyScore * paperRecencyWeight * completionPenalty * difficultyMatchScore;
}

/**
 * Generate a practice exam by selecting questions.
 * Returns { questions: [...], totalMarks: number, topicCoverage: { topic: count } }
 */
export function generatePracticeExam(questions, { papers, weights, hierarchy, assessability, tagCounts, qStatus, config, totalExams }) {
  if (!questions || !questions.length) return { questions: [], totalMarks: 0, topicCoverage: {} };

  // Build paper semester lookup
  const paperSemMap = {};
  (papers || []).forEach(p => { paperSemMap[p.id] = p.semester || ""; });

  // Build set of non-assessable tags
  const nonAssessableTags = new Set();
  if (config.assessableOnly && assessability && assessability.tags) {
    for (const [tag, info] of Object.entries(assessability.tags)) {
      if (info.assessable === false) nonAssessableTags.add(tag);
    }
  }

  // Build reverse hierarchy: tag -> parent topic
  const tagToParent = {};
  for (const [parent, tags] of Object.entries(hierarchy || {})) {
    for (const t of tags) {
      tagToParent[t] = parent;
    }
  }

  // Step 1: Filter candidate pool
  let candidates = [...questions];

  // Assessability filter: remove questions where ALL tags are non-assessable
  if (config.assessableOnly && nonAssessableTags.size > 0) {
    candidates = candidates.filter(q => {
      const qTags = q.tags || [];
      if (!qTags.length) return true; // no tags = include
      return !qTags.every(t => nonAssessableTags.has(t));
    });
  }

  // Semester filter
  if (config.semesterType) {
    candidates = candidates.filter(q => paperSemMap[q.paperId] === config.semesterType);
  }

  if (!candidates.length) return { questions: [], totalMarks: 0, topicCoverage: {} };

  // Step 2: Score each question with randomization
  const maxTagCount = Math.max(1, ...Object.values(tagCounts));
  const scored = candidates.map(q => ({
    question: q,
    score: scorePracticeQuestion(q, { weights, tagCounts, qStatus, config, maxTagCount }) * (0.7 + Math.random() * 0.6),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Step 3: Greedy selection with topic diversity
  const targetMarks = config.totalMarks || 100;
  const selected = [];
  let totalMarks = 0;
  const topicCoverage = {};
  const candidateCount = scored.length;
  const exhaustionThreshold = Math.ceil(candidateCount * 0.7);

  for (let i = 0; i < scored.length && totalMarks < targetMarks; i++) {
    const { question } = scored[i];
    const qTags = question.tags || [];

    // Determine parent topic for diversity check
    const parentTopics = new Set();
    for (const t of qTags) {
      if (tagToParent[t]) parentTopics.add(tagToParent[t]);
    }
    if (!parentTopics.size && question.topic) parentTopics.add(question.topic);

    // Diversity penalty: skip if a parent topic already has 3+ questions and we haven't exhausted 70% of candidates
    if (selected.length < exhaustionThreshold) {
      let tooMany = false;
      for (const pt of parentTopics) {
        if ((topicCoverage[pt] || 0) >= 3) { tooMany = true; break; }
      }
      if (tooMany) continue;
    }

    selected.push(question);
    const marks = question.marks != null ? question.marks : 5;
    totalMarks += marks;

    for (const pt of parentTopics) {
      topicCoverage[pt] = (topicCoverage[pt] || 0) + 1;
    }
  }

  return { questions: selected, totalMarks, topicCoverage };
}
