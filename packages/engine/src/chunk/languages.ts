export type UnitKind = "function" | "class" | "declaration";

export interface LangSpec {
  wasm: string;
  units: Record<string, UnitKind>;
  alwaysMethod: Set<string>;
  wrappers: Set<string>;
  transparent: Set<string>;
  memberWrappers: Set<string>;
  valueHolders: Set<string>;
  prefixes: Set<string>;
}

type SpecInput = {
  wasm: string;
  function?: string[];
  class?: string[];
  declaration?: string[];
  alwaysMethod?: string[];
  wrappers?: string[];
  transparent?: string[];
  memberWrappers?: string[];
  valueHolders?: string[];
  prefixes?: string[];
};

function spec(i: SpecInput): LangSpec {
  const units: Record<string, UnitKind> = {};
  for (const t of i.declaration ?? []) units[t] = "declaration";
  for (const t of i.class ?? []) units[t] = "class";
  for (const t of i.function ?? []) units[t] = "function";
  return {
    wasm: i.wasm,
    units,
    alwaysMethod: new Set(i.alwaysMethod),
    wrappers: new Set(i.wrappers),
    transparent: new Set(i.transparent),
    memberWrappers: new Set(i.memberWrappers),
    valueHolders: new Set(i.valueHolders),
    prefixes: new Set(i.prefixes),
  };
}

export const FUNCTION_VALUE_TYPES = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
]);

const tsLike = (wasm: string): LangSpec =>
  spec({
    wasm,
    function: [
      "function_declaration",
      "generator_function_declaration",
      "function_signature",
      "method_definition",
      "method_signature",
      "abstract_method_signature",
    ],
    class: ["class_declaration", "abstract_class_declaration", "interface_declaration"],
    declaration: ["type_alias_declaration", "enum_declaration"],
    alwaysMethod: ["method_definition", "method_signature", "abstract_method_signature"],
    wrappers: ["export_statement", "ambient_declaration"],
    transparent: ["ambient_declaration", "internal_module", "module", "expression_statement"],
    valueHolders: ["lexical_declaration", "variable_declaration", "public_field_definition", "field_definition"],
  });

export const LANGUAGES: Record<string, LangSpec> = {
  typescript: tsLike("tree-sitter-typescript.wasm"),
  tsx: tsLike("tree-sitter-tsx.wasm"),
  javascript: tsLike("tree-sitter-javascript.wasm"),
  python: spec({
    wasm: "tree-sitter-python.wasm",
    function: ["function_definition"],
    class: ["class_definition"],
    wrappers: ["decorated_definition"],
  }),
  go: spec({
    wasm: "tree-sitter-go.wasm",
    function: ["function_declaration", "method_declaration"],
    class: ["type_declaration"],
    alwaysMethod: ["method_declaration"],
  }),
  rust: spec({
    wasm: "tree-sitter-rust.wasm",
    function: ["function_item", "function_signature_item"],
    class: ["impl_item", "trait_item", "struct_item", "enum_item", "union_item"],
    declaration: ["type_item", "const_item", "static_item", "macro_definition"],
    transparent: ["mod_item"],
    prefixes: ["attribute_item"],
  }),
  java: spec({
    wasm: "tree-sitter-java.wasm",
    function: ["method_declaration", "constructor_declaration", "compact_constructor_declaration"],
    class: [
      "class_declaration",
      "interface_declaration",
      "record_declaration",
      "enum_declaration",
      "annotation_type_declaration",
    ],
    memberWrappers: ["enum_body_declarations"],
  }),
  csharp: spec({
    wasm: "tree-sitter-c_sharp.wasm",
    function: ["method_declaration", "constructor_declaration", "destructor_declaration", "operator_declaration"],
    class: [
      "class_declaration",
      "struct_declaration",
      "interface_declaration",
      "record_declaration",
      "record_struct_declaration",
    ],
    declaration: ["enum_declaration", "delegate_declaration"],
    transparent: ["namespace_declaration", "file_scoped_namespace_declaration"],
  }),
  c: spec({
    wasm: "tree-sitter-c.wasm",
    function: ["function_definition"],
    class: ["struct_specifier", "union_specifier"],
    declaration: ["enum_specifier", "type_definition"],
    transparent: ["preproc_if", "preproc_ifdef"],
  }),
  cpp: spec({
    wasm: "tree-sitter-cpp.wasm",
    function: ["function_definition"],
    class: ["class_specifier", "struct_specifier", "union_specifier"],
    declaration: ["enum_specifier", "type_definition", "alias_declaration"],
    wrappers: ["template_declaration"],
    transparent: ["namespace_definition", "linkage_specification", "preproc_if", "preproc_ifdef"],
  }),
  php: spec({
    wasm: "tree-sitter-php.wasm",
    function: ["function_definition", "method_declaration"],
    class: ["class_declaration", "interface_declaration", "trait_declaration", "enum_declaration"],
    transparent: ["namespace_definition"],
  }),
  ruby: spec({
    wasm: "tree-sitter-ruby.wasm",
    function: ["method", "singleton_method"],
    class: ["class", "module", "singleton_class"],
  }),
  kotlin: spec({
    wasm: "tree-sitter-kotlin.wasm",
    function: ["function_declaration"],
    class: ["class_declaration", "object_declaration", "companion_object"],
    declaration: ["type_alias"],
  }),
};
