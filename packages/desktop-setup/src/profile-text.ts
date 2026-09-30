import ts from "typescript";

/** Parse source positions, keeping numbers, escapes and whitespace in the original text. */
function source(bytes: Buffer) {
  const text = bytes.toString("utf8");
  if (bytes.length > 8 * 1024 * 1024 || !Buffer.from(text).equals(bytes)) throw new Error("Invalid Profile text");
  JSON.parse(text); // Require strict JSON; the TypeScript JSON parser also accepts comments.
  const tree = ts.parseJsonText("profile.json", text);
  const visit = (node: ts.Node, depth: number) => {
    if (depth > 128) throw new Error("Profile nesting limit");
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set<string>();
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || names.has(property.name.text)) throw new Error("Ambiguous Profile property");
        names.add(property.name.text);
      }
    }
    ts.forEachChild(node, child => visit(child, depth + 1));
  };
  visit(tree, 0);
  const statement = tree.statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isObjectLiteralExpression(statement.expression)) throw new Error("Profile object required");
  return { text, tree, object: statement.expression };
}

export function validateProfileText(bytes: Buffer): void { source(bytes); }

/** Change only one selected property value, or insert it without rewriting any existing bytes. */
export function patchProfileProperty(bytes: Buffer, path: readonly string[], value: unknown): Buffer {
  const parsed = source(bytes);
  let object = parsed.object;
  for (const key of path.slice(0, -1)) {
    const property = object.properties.find(item => ts.isPropertyAssignment(item) && ts.isStringLiteral(item.name) && item.name.text === key);
    if (!property || !ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) throw new Error("Profile object required");
    object = property.initializer;
  }
  const key = path.at(-1);
  if (!key) throw new Error("Profile property required");
  const existing = object.properties.find(item => ts.isPropertyAssignment(item) && ts.isStringLiteral(item.name) && item.name.text === key);
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Profile value required");
  if (existing && ts.isPropertyAssignment(existing)) {
    return Buffer.from(parsed.text.slice(0, existing.initializer.getStart(parsed.tree)) + encoded + parsed.text.slice(existing.initializer.end));
  }
  const last = object.properties.at(-1);
  const offset = last?.end ?? object.getStart(parsed.tree) + 1;
  return Buffer.from(parsed.text.slice(0, offset) + (last ? "," : "") + JSON.stringify(key) + ":" + encoded + parsed.text.slice(offset));
}
