import { createHash } from "node:crypto";
// Canonical form: JSON with recursively sorted keys, no insignificant whitespace, UTF-8, no ASCII
// escaping. This is the definition that produced the Owner-approved digest aea8c533… (Python:
// json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)), so one rule hashes both
// artifacts. It is an integrity check on repository content, not proof of who approved it.
const canonical = value =>
  Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
      : JSON.stringify(value);
export const canonicalJson = value => canonical(JSON.parse(JSON.stringify(value)));
// Provenance describes the artifact and therefore is not part of the content it hashes, just as
// `status` and `approval` were excluded from the approved NVDA_PRODUCT_V1 digest.
export const artifactOf = ({ provenance, ...content }) => content;
export const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
export const contentSha256 = baseline => sha256(canonicalJson(artifactOf(baseline)));
