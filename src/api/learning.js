import { CONFIG } from "../config.js";
import { readJsonFile } from "./json-file.js";

const REVIEW_FIELDS = [
  "eventId",
  "reviewedAt",
  "kickoffAt",
  "reviewMode",
  "teams",
  "predicted",
  "actual",
  "exactHit",
  "top3Hit",
  "top5Hit",
  "resultHit",
  "goalError",
  "expectedGoals",
  "probabilities",
  "scorePredictions",
  "reasons",
  "reasonTags",
  "reasonDetails"
];

// 学习接口只暴露网页复盘所需字段，不携带快照和证据重对象。
export async function getLearningResponse() {
  const learning = await readJsonFile(CONFIG.learningFile, { reviews: {}, model: {} });
  const reviews = Object.values(learning.reviews || {})
    .map(compactReview)
    .sort((left, right) => timestamp(right.reviewedAt) - timestamp(left.reviewedAt));

  return {
    model: learning.model || {},
    updatedAt: learning.updatedAt || null,
    lastReportAt: learning.lastReportAt || null,
    reviews
  };
}

function compactReview(review = {}) {
  return Object.fromEntries(REVIEW_FIELDS.map((field) => [field, review[field]]));
}

function timestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}
