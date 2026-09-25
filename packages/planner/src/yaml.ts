type Line = { indent: number; content: string; number: number };

export function parseYaml(text: string): unknown {
  const source = text.replace(/\r\n/g, "\n").split("\n");
  const lines: Line[] = [];
  for (let index = 0; index < source.length; index++) {
    const raw = source[index]!;
    const content = raw.trim();
    if (!content || content.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    lines.push({ indent, content, number: index + 1 });
  }
  let position = 0;
  const fail = (line: Line, message: string): never => { throw new Error(`line ${line.number}: ${message}`); };
  const checkStructure = (line: Line): void => {
    if (source[line.number - 1]!.includes("\t")) fail(line, "tabs are unsupported");
    if (line.indent % 2) fail(line, "invalid indentation");
  };
  const stripComment = (value: string): string => {
    let quote = "";
    for (let i = 0; i < value.length; i++) {
      const char = value[i]!;
      if (quote === '"' && char === "\\") { i++; continue; }
      if (char === quote) { quote = ""; continue; }
      if (!quote && (char === '"' || char === "'")) { quote = char; continue; }
      if (!quote && char === "#" && (i === 0 || /\s/.test(value[i - 1]!))) return value.slice(0, i).trimEnd();
    }
    return value.trimEnd();
  };
  const scalar = (input: string, line: Line): unknown => {
    const value = stripComment(input).trim();
    if (!value) return null;
    if (value.startsWith('"')) {
      if (!/^"(?:[^"\\]|\\.)*"$/.test(value)) fail(line, "invalid quoted string");
      try { return JSON.parse(value); } catch { return fail(line, "invalid quoted string"); }
    }
    if (value.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(value)) fail(line, "invalid quoted string");
      return value.slice(1, -1).replace(/''/g, "'");
    }
    if (value.startsWith("[")) {
      if (!value.endsWith("]")) fail(line, "invalid flow sequence");
      const inner = value.slice(1, -1).trim();
      if (!inner) return [];
      const parts: string[] = [];
      let start = 0;
      let quote = "";
      for (let i = 0; i < inner.length; i++) {
        const char = inner[i]!;
        if (quote === '"' && char === "\\") { i++; continue; }
        if (char === quote) { quote = ""; continue; }
        if (!quote && (char === '"' || char === "'")) { quote = char; continue; }
        if (!quote && char === ",") { parts.push(inner.slice(start, i)); start = i + 1; }
      }
      if (quote) fail(line, "invalid flow sequence");
      parts.push(inner.slice(start));
      if (parts.some((part) => !part.trim())) fail(line, "invalid flow sequence");
      return parts.map((part) => scalar(part, line));
    }
    if (/^(true|false)$/.test(value)) return value === "true";
    if (/^-?(?:0|[1-9]\d*)$/.test(value)) return Number(value);
    if (/^[\[\]{}&*!>|%@`]/.test(value) || /^(?:null|~)$/.test(value)) fail(line, "unsupported YAML syntax");
    if (/[:][ \t]/.test(value)) fail(line, "unsupported YAML syntax");
    return value;
  };
  const block = (indent: number): unknown => {
    const first = lines[position];
    if (!first || first.indent !== indent) fail(first ?? { indent, content: "", number: source.length }, "invalid indentation");
    checkStructure(first);
    if (first.content.startsWith("- ")) {
      const result: unknown[] = [];
      while (position < lines.length && lines[position]!.indent === indent) {
        const line = lines[position++]!;
        checkStructure(line);
        if (!line.content.startsWith("- ")) fail(line, "mixed map and sequence");
        const value = line.content.slice(2);
        const match = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(value);
        if (match) {
          position--;
          result.push(map(indent + 2, true));
        } else if (!stripComment(value).trim()) {
          result.push(lines[position]?.indent === indent + 2 ? block(indent + 2) : null);
        } else {
          result.push(scalar(value, line));
          if (lines[position] && lines[position]!.indent > indent) fail(lines[position]!, "unexpected indentation");
        }
      }
      return result;
    }
    return map(indent, false);
  };
  const map = (indent: number, sequenceItem: boolean): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    let first = sequenceItem;
    while (position < lines.length) {
      const line = lines[position]!;
      const expected = first ? indent - 2 : indent;
      if (line.indent < expected || (sequenceItem && !first && line.indent === indent - 2)) break;
      checkStructure(line);
      if (line.indent !== expected) fail(line, "invalid indentation");
      const content = first ? line.content.slice(2) : line.content;
      if (first && !line.content.startsWith("- ")) fail(line, "expected sequence item");
      const match = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(content);
      if (!match) return fail(line, "expected map entry");
      const key = match[1]!;
      if (Object.hasOwn(result, key)) fail(line, `duplicate key ${key}`);
      position++;
      const value = stripComment(match[2] ?? "").trim();
      if (value === "|") {
        const start = line.number;
        while (position < lines.length && lines[position]!.indent > indent) position++;
        const end = lines[position]?.number ?? source.length + 1;
        const chunks = source.slice(start, end - 1).map((raw) => raw.trim() ? raw.slice(indent + 2) : "");
        while (chunks.length && chunks[chunks.length - 1] === "") chunks.pop();
        result[key] = chunks.join("\n") + "\n";
      } else if (!value) {
        result[key] = lines[position]?.indent === indent + 2 ? block(indent + 2) : null;
      } else {
        result[key] = scalar(value, line);
      }
      first = false;
    }
    return result;
  };
  if (!lines.length) return null;
  const result = block(lines[0]!.indent);
  if (position !== lines.length) fail(lines[position]!, "unexpected indentation");
  return result;
}
