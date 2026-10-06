import { Language, Parser, type Node } from "web-tree-sitter";
import { grammarPath } from "./assets";
import { FUNCTION_VALUE_TYPES, LANGUAGES, type LangSpec, type UnitKind } from "./languages";
import { splitText } from "./split";
import type { Chunk, ChunkOptions } from "./types";

const CLASS_MAX_LINES = 150;
const BODY_TYPES = new Set(["function_body", "block", "statement_block", "compound_statement", "body_statement"]);
const DECLARATOR_WRAPPERS = new Set([
  "function_declarator",
  "pointer_declarator",
  "reference_declarator",
  "array_declarator",
  "parenthesized_declarator",
  "init_declarator",
  "attributed_declarator",
]);

let initPromise: Promise<void> | null = null;
const parsers = new Map<string, Promise<Parser>>();

export function initTreeSitter(): Promise<void> {
  initPromise ??= Parser.init().catch((e) => {
    initPromise = null;
    throw e;
  });
  return initPromise;
}

function getParser(lang: string): Promise<Parser> {
  let p = parsers.get(lang);
  if (!p) {
    p = (async () => {
      await initTreeSitter();
      const language = await Language.load(grammarPath(lang));
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
    p.catch(() => parsers.delete(lang));
    parsers.set(lang, p);
  }
  return p;
}

interface Found {
  kind: UnitKind;
  node: Node;
  name: string | null;
  scope: string | null;
  forceMethod: boolean;
}

interface Unit {
  start: number;
  end: number;
  nodeStart: number;
  type: UnitKind;
  kind: string;
  symbol: string | null;
  parent: string | null;
  inner: Node;
}

const named = (n: Node): Node[] => n.namedChildren.filter((c): c is Node => c !== null);

function digDeclarator(node: Node): { name: string | null; scope: string | null } {
  let d: Node | null = node.childForFieldName("declarator");
  while (d && DECLARATOR_WRAPPERS.has(d.type)) d = d.childForFieldName("declarator") ?? named(d)[0] ?? null;
  if (!d) return { name: null, scope: null };
  if (d.type === "qualified_identifier") {
    return { name: d.childForFieldName("name")?.text ?? null, scope: d.childForFieldName("scope")?.text ?? null };
  }
  return { name: d.text, scope: null };
}

const baseTypeName = (text: string) => text.split(/[<\s(]/)[0] || null;

function symbolOf(node: Node): { name: string | null; scope: string | null } {
  switch (node.type) {
    case "impl_item": {
      const ty = node.childForFieldName("type");
      return { name: ty ? baseTypeName(ty.text) : null, scope: null };
    }
    case "method_declaration": {
      const receiver = node.childForFieldName("receiver");
      if (receiver && node.childForFieldName("name")?.type === "field_identifier") {
        return {
          name: node.childForFieldName("name")?.text ?? null,
          scope: receiver.descendantsOfType("type_identifier")[0]?.text ?? null,
        };
      }
      break;
    }
    case "type_declaration": {
      const spec = named(node).find((c) => c.type === "type_spec" || c.type === "type_alias");
      return { name: spec?.childForFieldName("name")?.text ?? null, scope: null };
    }
  }
  const name = node.childForFieldName("name");
  if (name) return { name: name.text, scope: null };
  if (node.childForFieldName("declarator")) return digDeclarator(node);
  const id = named(node).find((c) => /^(simple_identifier|type_identifier|identifier)$/.test(c.type));
  return { name: id?.text ?? null, scope: null };
}

function bodyOf(node: Node): Node | null {
  return node.childForFieldName("body") ?? named(node).find((c) => BODY_TYPES.has(c.type)) ?? null;
}

function resolveInner(spec: LangSpec, node: Node): Found | null {
  const kind = spec.units[node.type];
  if (kind) {
    return { kind, node, ...symbolOf(node), forceMethod: spec.alwaysMethod.has(node.type) };
  }
  if (!spec.valueHolders.has(node.type)) return null;
  if (node.type === "public_field_definition" || node.type === "field_definition") {
    const value = node.childForFieldName("value");
    if (!value || !FUNCTION_VALUE_TYPES.has(value.type)) return null;
    const name = node.childForFieldName("name") ?? node.childForFieldName("property");
    return { kind: "function", node: value, name: name?.text ?? null, scope: null, forceMethod: false };
  }
  const decl = named(node).find((c) => c.type === "variable_declarator");
  const value = decl?.childForFieldName("value");
  if (!decl || !value || !FUNCTION_VALUE_TYPES.has(value.type)) return null;
  return {
    kind: "function",
    node: value,
    name: decl.childForFieldName("name")?.text ?? null,
    scope: null,
    forceMethod: false,
  };
}

class Chunker {
  private lineStarts: number[] = [0];
  private byteTable: Uint32Array | null = null;

  constructor(
    private content: string,
    private spec: LangSpec,
    private opts: ChunkOptions,
  ) {
    for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) this.lineStarts.push(i + 1);
    if (Buffer.byteLength(content) !== content.length) {
      const t = new Uint32Array(content.length + 1);
      for (let i = 0; i < content.length; i++) {
        const c = content.charCodeAt(i);
        const w = c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : c >= 0xdc00 && c <= 0xdfff ? 0 : 3;
        t[i + 1] = t[i]! + w;
      }
      this.byteTable = t;
    }
  }

  run(root: Node): Chunk[] {
    const units = this.collect(named(root), null, false);
    const out: Chunk[] = [];
    let pos = 0;
    for (const u of units) {
      if (u.start < pos) continue;
      this.gap(pos, u.start, out);
      out.push(...this.emitUnit(u));
      pos = u.end;
    }
    this.gap(pos, this.content.length, out);
    return out;
  }

  private lineOf(idx: number): number {
    const s = this.lineStarts;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid]! <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  private byteAt(idx: number): number {
    return this.byteTable ? this.byteTable[idx]! : idx;
  }

  private mk(
    start: number,
    end: number,
    kind: string,
    symbol: string | null,
    parentSymbol: string | null,
    signature: string | null,
    text = this.content.slice(start, end),
    lines: [number, number] = [this.lineOf(start), this.lineOf(Math.max(start, end - 1))],
  ): Chunk {
    return {
      startLine: lines[0],
      endLine: lines[1],
      startByte: this.byteAt(start),
      endByte: this.byteAt(end),
      kind,
      symbol,
      parentSymbol,
      signature,
      text,
    };
  }

  private gap(a: number, b: number, out: Chunk[]): void {
    const raw = this.content.slice(a, b);
    const first = raw.search(/\S/);
    if (first === -1) return;
    const s = a + first;
    const e = a + raw.trimEnd().length;
    out.push(...this.piecewise(s, e, "module", null, null, null));
  }

  private piecewise(
    start: number,
    end: number,
    kind: string,
    symbol: string | null,
    parent: string | null,
    signature: string | null,
  ): Chunk[] {
    const text = this.content.slice(start, end);
    if (this.opts.countTokens(text) <= this.opts.maxTokens) return [this.mk(start, end, kind, symbol, parent, signature, text)];
    return splitText(text, this.opts).map((r) =>
      this.mk(start + r.start, start + r.end, kind, symbol, parent, signature),
    );
  }

  private resolve(node: Node, inClass: boolean, parentName: string | null): Unit | null {
    let found = resolveInner(this.spec, node);
    if (!found && this.spec.wrappers.has(node.type)) {
      const kids = named(node);
      for (let i = kids.length - 1; i >= 0 && !found; i--) found = resolveInner(this.spec, kids[i]!);
    }
    if (!found) return null;
    const kind = found.kind === "function" ? (inClass || found.forceMethod ? "method" : "function") : found.kind;
    return {
      start: node.startIndex,
      end: node.endIndex,
      nodeStart: node.startIndex,
      type: found.kind,
      kind,
      symbol: found.name,
      parent: found.scope ?? (inClass ? parentName : null),
      inner: found.node,
    };
  }

  private members(node: Node): Node[] {
    const body =
      node.childForFieldName("body") ??
      named(node).find((c) => /(^|_)body$/.test(c.type) || c.type === "declaration_list" || c.type === "field_declaration_list");
    const kids = named(body ?? node);
    return kids.flatMap((c) => (this.spec.memberWrappers.has(c.type) ? named(c) : [c]));
  }

  private collect(nodes: Node[], parentName: string | null, inClass: boolean): Unit[] {
    const out: Unit[] = [];
    let pending: Node[] = [];
    for (const node of nodes) {
      if (node.type.includes("comment") || this.spec.prefixes.has(node.type)) {
        const last = pending[pending.length - 1];
        if (last && node.startPosition.row > last.endPosition.row + 1) pending = [];
        pending.push(node);
        continue;
      }
      const unit = this.resolve(node, inClass, parentName);
      if (unit) {
        const last = pending[pending.length - 1];
        if (last && last.endPosition.row >= node.startPosition.row - 1) unit.start = pending[0]!.startIndex;
        out.push(unit);
      } else if (this.spec.transparent.has(node.type)) {
        out.push(...this.collect(this.members(node), parentName, inClass));
      }
      pending = [];
    }
    return out;
  }

  private signatureOf(u: Unit): string {
    const body = bodyOf(u.inner);
    let end: number;
    if (body && body.startIndex > u.nodeStart && body.startIndex <= u.end) end = body.startIndex;
    else {
      const nl = this.content.indexOf("\n", u.nodeStart);
      end = nl === -1 || nl > u.end ? u.end : nl;
    }
    return this.content.slice(u.nodeStart, end).replace(/\s+/g, " ").trim().slice(0, 200);
  }

  private emitUnit(u: Unit): Chunk[] {
    const text = this.content.slice(u.start, u.end);
    const lines = this.lineOf(u.end - 1) - this.lineOf(u.start) + 1;
    const signature = this.signatureOf(u);
    if (u.type === "class" && (lines > CLASS_MAX_LINES || this.opts.countTokens(text) > this.opts.maxTokens)) {
      const members = this.collect(this.members(u.inner), u.symbol, true);
      if (members.length) {
        return [...this.skeleton(u, members, signature), ...members.flatMap((m) => this.emitUnit(m))];
      }
    }
    return this.piecewise(u.start, u.end, u.kind, u.symbol, u.parent, signature);
  }

  private skeleton(u: Unit, members: Unit[], signature: string): Chunk[] {
    let text = "";
    let pos = u.start;
    for (const m of members) {
      if (m.start < pos) continue;
      const body = bodyOf(m.inner);
      let from: number;
      let to: number;
      if (body && body.startIndex > m.nodeStart && body.endIndex <= m.end) {
        from = body.startIndex;
        to = body.endIndex;
      } else {
        const nl = this.content.indexOf("\n", m.nodeStart);
        from = nl === -1 || nl >= m.end ? m.end : nl;
        to = m.end;
      }
      text += this.content.slice(pos, from) + (to > from ? "..." : "");
      pos = to;
    }
    text += this.content.slice(pos, u.end);
    const lines: [number, number] = [this.lineOf(u.start), this.lineOf(u.end - 1)];
    const pieces =
      this.opts.countTokens(text) <= this.opts.maxTokens ? [{ start: 0, end: text.length }] : splitText(text, this.opts);
    return pieces.map((r) =>
      this.mk(u.start, u.end, "class", u.symbol, u.parent, signature, text.slice(r.start, r.end), lines),
    );
  }
}

export async function chunkWithTreeSitter(lang: string, content: string, opts: ChunkOptions): Promise<Chunk[]> {
  const spec = LANGUAGES[lang];
  if (!spec) throw new Error(`no grammar for language: ${lang}`);
  const parser = await getParser(lang);
  const tree = parser.parse(content);
  if (!tree) throw new Error(`parse failed for language: ${lang}`);
  try {
    return new Chunker(content, spec, opts).run(tree.rootNode);
  } finally {
    tree.delete();
  }
}
