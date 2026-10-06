const IDENTIFIER = /^[A-Za-z_$][\w$.:]*$/;
const CYRILLIC = /\p{Script=Cyrillic}/u;

export function routeWeights(query: string): { lexical: number; semantic: number } {
  const q = query.trim();
  if (IDENTIFIER.test(q)) return { lexical: 0.7, semantic: 0.3 };
  if (CYRILLIC.test(q)) return { lexical: 0.1, semantic: 0.9 };
  return { lexical: 0.3, semantic: 0.7 };
}
