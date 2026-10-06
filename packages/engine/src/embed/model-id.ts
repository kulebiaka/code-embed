export function modelIdOf(provider: string, model: string, dims: number): string {
  return `${provider}/${model}@${dims}`;
}

export function parseModelId(id: string): { provider: string; model: string; dims: number } | null {
  const m = /^([^/@]+)\/(.+)@(\d+)$/.exec(id);
  if (!m) return null;
  const dims = Number(m[3]);
  if (dims <= 0) return null;
  return { provider: m[1]!, model: m[2]!, dims };
}
