"use strict";
const evidence = require("../kernel/completion-evidence.js");
const content = require("../kernel/content.js");

// Read the pinned complete account, then verify the descriptor AND its bytes
// through the existing asset read door. No graph write, upload or resolution.
async function collect({ record, deps, usesAsset }) {
  const required = record.impl_claim.completion.screenshots === "required";
  const resolver = record.impl_candidate?.resolver || {};
  const out = { account: resolver.node || null, account_revision: resolver.revision || null,
    execution_id: record.impl_claim.execution_id, revision: record.impl_candidate?.commit,
    screenshots: [], missing: [] };
  const missing = (caption, reason, provenance) => out.missing.push({ caption, missing: reason, ...(provenance ? { provenance } : {}) });
  const finish = () => {
    // Leave room for the controller's existing candidate and gate facts under
    // the node-body cap. Refuse oversized evidence rather than truncating an
    // image URI, caption, or provenance record into misleading content.
    if (Buffer.byteLength(evidence.render(out).join("\n"), "utf8") > 4500) {
      out.screenshots = [];
      out.result = null;
      out.missing = [{ caption: "Screenshot report", missing: "evidence exceeds the 4500-byte completion budget; submit a smaller account" }];
    }
    return { ok: !required || (out.screenshots.length > 0 && out.missing.length === 0),
      evidence: out, reason: out.missing.map((s) => `${s.caption}: ${s.missing}`).join("; ") };
  };
  if (!resolver.node) {
    if (required) missing("Required screenshot", "no candidate account was submitted");
    return finish();
  }
  let doc;
  try { doc = await deps.readEvidenceDocument(resolver.node, resolver.revision || null); } catch { /* unavailable */ }
  if (!doc?.complete || typeof doc.source !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(doc.revision || "") || (resolver.revision && doc.revision !== resolver.revision)) {
    missing("Candidate account", "its pinned complete document could not be read");
    return finish();
  }
  out.account_revision = doc.revision;
  const parsed = evidence.parse(doc.source, { executionId: out.execution_id, revision: out.revision });
  if (!parsed.ok || !parsed.present) {
    if (!parsed.ok || required) missing("Required screenshot", parsed.reason || "no screenshot manifest was submitted");
    return finish();
  }
  out.result = parsed.result;
  if (parsed.design) {
    let design;
    try { design = await deps.readNode(parsed.design); } catch { /* unavailable */ }
    if (!design?.ok) missing("Design provenance", "the referenced design could not be read");
    else out.design = parsed.design;
  }
  for (const s of parsed.screenshots) {
    if (s.missing) { missing(s.caption, s.missing, s.provenance); continue; }
    if (!usesAsset) { missing(s.caption, "the live registry does not enable uses-asset inclusion", s.provenance); continue; }
    try {
      const asset = await deps.verifyEvidenceAsset(s.uri);
      if (!asset || asset.id !== s.id || asset.digest !== s.digest || !content.assetDescriptor({
        id: asset.id, type: "artifact", asset_digest: asset.digest, asset_media_type: asset.media_type,
        asset_bytes: asset.bytes, asset_width: asset.width, asset_height: asset.height,
      })) throw new Error("descriptor mismatch");
      out.screenshots.push({ ...s, descriptor_revision: asset.revision || null });
    } catch {
      // Do not persist a transport exception, credential, URL or private path.
      missing(s.caption, "the uploaded asset descriptor or bytes could not be verified", s.provenance);
    }
  }
  if (required && !out.screenshots.length && !out.missing.length) missing("Required screenshot", "the manifest contains no screenshots");
  return finish();
}

module.exports = { collect };
