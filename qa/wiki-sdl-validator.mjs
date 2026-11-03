// Real SDL-backed GraphQL validation for the pinned Wiki.js v2.5.314 page
// contract (F17). Uses the official `graphql` package (devDependency) to
// parse the EXACT emitted operation text, validate it against the pinned
// schema artifact (wiki-page-2.5.314.graphql), and coerce the ACTUAL variable
// values. Regex string checks are NOT used for conformance.
// Pinned schema: https://github.com/requarks/wiki/v2.5.314/blob/main/server/graph/schemas/page.graphql
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parse, buildSchema, validate, specifiedRules, typeFromAST, coerceInputValue,
} from "graphql";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = buildSchema(fs.readFileSync(path.join(here, "wiki-page-2.5.314.graphql"), "utf-8"));

// EXACT queries emitted by WikiQueries (server/SimCEO.Api/Work/WikiGraphQl.cs).
// QA asserts the fixture-observed query text normalizes to these strings.
export const EXPECTED_LIST =
  "query WikiList($limit: Int $tags: [String!] $locale: String) { pages { list(limit: $limit orderBy: PATH orderByDirection: ASC tags: $tags locale: $locale) { id path locale title tags } } }";
export const EXPECTED_SINGLE =
  "query WikiSingle($id: Int!) { pages { single(id: $id) { id path locale title content contentType updatedAt tags { tag } } } }";

const LIST_FIELDS = ["id", "path", "locale", "title", "tags"];
const SINGLE_FIELDS = ["id", "path", "locale", "title", "content", "contentType", "updatedAt", "tags"];
function selectionsOf(doc, objectName) {
  // Field-selection nodes for `pages { <objectName> { ... } }`.
  const opDef = doc.definitions.find(
    (d) => d.kind === "OperationDefinition" && d.operation === "query");
  if (!opDef) return [];
  const pages = (opDef.selectionSet?.selections ?? []).find(
    (s) => s.kind === "Field" && s.name.value === "pages");
  if (!pages) return [];
  const obj = (pages.selectionSet?.selections ?? []).find(
    (s) => s.kind === "Field" && s.name.value === objectName);
  if (!obj || obj.kind !== "Field") return [];
  return obj.selectionSet?.selections ?? [];
}

export function validateWikiQuery(query, variables) {
  const problems = [];
  let doc;
  try {
    doc = parse(query);
  } catch (e) {
    return { ok: false, problems: ["query does not parse: " + String((e && e.message) || e).slice(0, 200)] };
  }
  const opDefs = doc.definitions.filter((d) => d.kind === "OperationDefinition");
  if (opDefs.length !== 1) {
    problems.push("must emit exactly one operation per request");
  }
  const op = opDefs[0];
  if (op && op.operation !== "query") problems.push("mutations are never emitted");
  const name = (op && op.name && op.name.value) || "";
  const hasList = /pages\s*{\s*list/.test(query);
  const hasSingle = /pages\s*{\s*single/.test(query);
  if (!hasList && !hasSingle) problems.push("unknown operation: must emit pages.list or pages.single");
  if (hasList && hasSingle) problems.push("must emit exactly one operation per request");
  if (hasList && name !== "WikiList") problems.push("unexpected list operation name: " + (name || "(anonymous)"));
  if (hasSingle && name !== "WikiSingle") problems.push("unexpected single operation name: " + (name || "(anonymous)"));
  // SDL validation against the pinned v2.5.314 contract: unknown fields,
  // wrong variable types (incl. String orderBy), mutations, quoted enums,
  // and missing required arguments fail here.
  for (const err of validate(schema, doc, specifiedRules)) {
    problems.push("SDL: " + err.message);
  }
  // Required selections (presence, not just schema legality).
  if (hasList && !hasSingle) {
    const names = selectionsOf(doc, "list").map((s) => (s.kind === "Field" ? s.name.value : ""));
    for (const f of LIST_FIELDS) {
      if (!names.includes(f)) problems.push("pages.list missing field " + f);
    }
  }
  if (hasSingle && !hasList) {
    const sels = selectionsOf(doc, "single");
    const names = sels.map((s) => (s.kind === "Field" ? s.name.value : ""));
    for (const f of SINGLE_FIELDS) {
      if (!names.includes(f)) problems.push("pages.single missing field " + f);
    }
    const tags = sels.find((s) => s.kind === "Field" && s.name.value === "tags");
    const tagSubs = (tags && tags.kind === "Field" ? (tags.selectionSet?.selections ?? []) : [])
      .map((s) => (s.kind === "Field" ? s.name.value : ""));
    if (!tagSubs.includes("tag")) problems.push("pages.single tags must select object field tag");
  }
  // Variable value coercion against declared types (e.g. 11.5 for Int!).
  try {
    const varDefs = (op && op.variableDefinitions) || [];
    for (const vd of varDefs) {
      const vname = vd.variable.name.value;
      if (!variables || !(vname in variables)) continue;
      const t = typeFromAST(schema, vd.type);
      if (!t) { problems.push("unknown variable type for $" + vname); continue; }
      const coerced = coerceInputValue(variables[vname], t);
      if (coerced === undefined) {
        problems.push("variable $" + vname + " value " + JSON.stringify(variables[vname]).slice(0, 80) + " does not coerce to its declared type");
      }
    }
  } catch (e) {
    problems.push("variable coercion failed: " + String((e && e.message) || e).slice(0, 160));
  }
  return { ok: problems.length === 0, problems };
}

export function oldBrokenQueryFails() {
  const oldQ = "query WikiList($limit: Int $orderBy: String $orderByDirection: String $tags: [String!] $locale: String) { pages { list(limit: $limit orderBy: $orderBy orderByDirection: $orderByDirection tags: $tags locale: $locale) { id path } } }";
  const r = validateWikiQuery(oldQ, { orderBy: "PATH" });
  return !r.ok;
}

export function normQuery(q) {
  return String(q || "").replace(/\s+/g, " ").trim();
}
