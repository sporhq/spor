"use strict";
// A candidate account may carry ONE bounded, revision-bound screenshot manifest.
// These are illustrations of the delivered result, never gate attestations.
const content = require("./content.js");

const SCHEMA = "spor.completion-evidence/1";
const FENCE = "spor-completion-evidence";
const MAX_SCREENSHOTS = 4;
const REVISION_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;

// Treat captions and the human account as text, so neither can inject another
// image (and thereby evade descriptor verification / inclusion reconciliation).
function text(value) {
  return String(value || "").replace(/([\\`*_{}\[\]<>()!#|~])/g, "\\$1");
}
function embed(caption, uri) {
  const ref = content.parseAssetUri(uri);
  if (!ref.ok || !ref.digest) throw new Error("screenshot embed requires a digest-pinned asset URI");
  return `![${text(caption).replace(/\s+/g, " ")}](${uri})`;
}

function parse(source, { executionId, revision } = {}) {
  const blocks = [...String(source || "").matchAll(/^```spor-completion-evidence[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
  const bad = (reason) => ({ ok: false, present: true, reason });
  if (!blocks.length) return /^```spor-completion-evidence/m.test(String(source || ""))
    ? bad("screenshot manifest fence is incomplete") : { ok: true, present: false };
  if (blocks.length !== 1 || blocks[0][1].length > 12000) return bad("expected one bounded screenshot manifest");
  let m;
  try { m = JSON.parse(blocks[0][1]); } catch { return bad("screenshot manifest is not JSON"); }
  if (!m || typeof m !== "object" || m.schema !== SCHEMA) return bad(`screenshot manifest must declare ${SCHEMA}`);
  if (m.execution_id !== executionId) return bad("screenshot manifest names another execution");
  if (!REVISION_RE.test(m.revision || "") || m.revision !== revision) return bad("screenshot manifest does not name the delivered candidate commit");
  const field = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\x00-\x08\x0b-\x1f\x7f]/.test(v);
  if (!field(m.result, 1500)) return bad("screenshot manifest needs a readable result (1–1500 characters)");
  if (m.design != null && (typeof m.design !== "string" || !ID_RE.test(m.design))) return bad("screenshot design must be a node id");
  if (!Array.isArray(m.screenshots) || m.screenshots.length > MAX_SCREENSHOTS) return bad(`screenshot manifest needs at most ${MAX_SCREENSHOTS} screenshots`);
  const screenshots = [];
  for (const s of m.screenshots) {
    if (!s || !field(s.caption, 300) || !field(s.provenance, 400)) return bad("each screenshot needs a caption and capture provenance");
    if (s.missing != null) {
      if (s.uri != null || !field(s.missing, 300)) return bad("missing screenshot needs a reason and no asset URI");
      screenshots.push({ caption: s.caption.trim(), provenance: s.provenance.trim(), missing: s.missing.trim() });
    } else {
      const ref = content.parseAssetUri(s.uri);
      if (!ref.ok || !ref.digest) return bad("screenshots must use digest-pinned spor-asset URIs");
      screenshots.push({ caption: s.caption.trim(), provenance: s.provenance.trim(), uri: s.uri, id: ref.id, digest: ref.digest });
    }
  }
  return { ok: true, present: true, result: m.result.trim(), design: m.design || null, screenshots };
}

function render(evidence) {
  if (!evidence) return [];
  const lines = ["", "## Delivered result", "", ...(evidence.result ? [text(evidence.result), ""] : []),
    "Screenshots illustrate the result; factory gate and integration facts determine completion."];
  if (evidence.account) lines.push("", `Account: \`${evidence.account}\` at node revision \`${evidence.account_revision || "?"}\`.`);
  for (const s of evidence.screenshots || []) {
    lines.push("", embed(s.caption, s.uri), "", text(s.caption), `Capture provenance: ${text(s.provenance)}.`,
      `Execution: \`${evidence.execution_id}\`; delivered commit: \`${evidence.revision}\`; descriptor revision: \`${s.descriptor_revision || "?"}\`.`);
  }
  for (const s of evidence.missing || []) {
    lines.push("", `Missing screenshot evidence: ${text(s.caption)} — ${text(s.missing)}.`,
      ...(s.provenance ? [`Capture provenance: ${text(s.provenance)}.`] : []));
  }
  return lines;
}

module.exports = { SCHEMA, FENCE, MAX_SCREENSHOTS, parse, text, embed, render };
