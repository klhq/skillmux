export function stringifyToml(obj: Record<string, any>): string {
  let out = "";
  const topLevel: Record<string, any> = {};
  const sections: Record<string, any> = {};

  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      sections[k] = v;
    } else {
      topLevel[k] = v;
    }
  }

  for (const [k, v] of Object.entries(topLevel)) {
    out += `${k} = ${formatTomlVal(v)}\n`;
  }
  if (Object.keys(topLevel).length > 0) out += "\n";

  for (const [secName, secObj] of Object.entries(sections)) {
    out += stringifyTomlSection([secName], secObj);
  }

  return out;
}

export function stringifyTomlSection(path: string[], obj: Record<string, any>): string {
  let out = `[${path.join(".")}]\n`;
  const subSections: Record<string, any> = {};

  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      subSections[k] = v;
    } else {
      out += `${k} = ${formatTomlVal(v)}\n`;
    }
  }
  out += "\n";

  for (const [subName, subObj] of Object.entries(subSections)) {
    out += stringifyTomlSection([...path, subName], subObj);
  }

  return out;
}

export function formatTomlVal(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  return JSON.stringify(v);
}
