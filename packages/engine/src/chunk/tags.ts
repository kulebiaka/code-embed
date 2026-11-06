// Reference queries for web-tree-sitter, written after the upstream tree-sitter
// tags.scm files (tree-sitter-typescript, tree-sitter-javascript, tree-sitter-python),
// https://github.com/tree-sitter/tree-sitter-typescript, .../tree-sitter-javascript,
// .../tree-sitter-python. Upstream license: MIT.
// Captures: @ref.call, @ref.type, @ref.import (+ @ref.module for the specifier).

const JS_CALLS = `
(call_expression function: (identifier) @ref.call)
(call_expression function: (member_expression property: (property_identifier) @ref.call))
(new_expression constructor: (identifier) @ref.call)
`;

const JS_IMPORTS = `
(import_statement
  (import_clause (named_imports (import_specifier name: (identifier) @ref.import)))
  source: (string (string_fragment) @ref.module))
(import_statement
  (import_clause (identifier) @ref.import)
  source: (string (string_fragment) @ref.module))
(import_statement
  (import_clause (namespace_import (identifier) @ref.import))
  source: (string (string_fragment) @ref.module))
`;

const TS_TYPES = `
(type_annotation (type_identifier) @ref.type)
(generic_type name: (type_identifier) @ref.type)
(type_arguments (type_identifier) @ref.type)
(array_type (type_identifier) @ref.type)
(union_type (type_identifier) @ref.type)
(intersection_type (type_identifier) @ref.type)
(implements_clause (type_identifier) @ref.type)
(extends_type_clause (type_identifier) @ref.type)
(extends_clause value: (identifier) @ref.type)
`;

const PYTHON = `
(call function: (identifier) @ref.call)
(call function: (attribute attribute: (identifier) @ref.call))
(import_statement name: (dotted_name) @ref.import)
(import_statement name: (aliased_import name: (dotted_name) @ref.import))
(import_from_statement module_name: (_) @ref.module name: (dotted_name) @ref.import)
(import_from_statement module_name: (_) @ref.module name: (aliased_import name: (dotted_name) @ref.import))
`;

const QUERIES: Record<string, string> = {
  typescript: JS_CALLS + JS_IMPORTS + TS_TYPES,
  tsx: JS_CALLS + JS_IMPORTS + TS_TYPES,
  javascript: JS_CALLS + JS_IMPORTS,
  python: PYTHON,
};

export const REF_LANGS: ReadonlySet<string> = new Set(Object.keys(QUERIES));

export function refQuerySource(lang: string): string | null {
  return Object.hasOwn(QUERIES, lang) ? QUERIES[lang]! : null;
}
