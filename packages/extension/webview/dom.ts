export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function icon(name: string, extra = ""): HTMLElement {
  const i = el("span", `codicon codicon-${name}${extra ? ` ${extra}` : ""}`);
  i.setAttribute("aria-hidden", "true");
  return i;
}

export function iconButton(name: string, label: string, cls = ""): HTMLButtonElement {
  const b = el("button", `icon-btn${cls ? ` ${cls}` : ""}`);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(name));
  return b;
}

export function button(text: string, opts: { icon?: string; secondary?: boolean; cls?: string } = {}): HTMLButtonElement {
  const b = el("button", ["btn", opts.secondary ? "secondary" : "", opts.cls ?? ""].filter(Boolean).join(" "));
  b.type = "button";
  if (opts.icon) b.append(icon(opts.icon));
  b.append(text);
  return b;
}
