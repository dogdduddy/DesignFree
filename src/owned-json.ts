/** JSON of objects owned by DocumentHistory. History never mutates what it owns,
 * so object identity is a valid cache key. Never pass objects a caller may edit. */
const cache = new WeakMap<object, string>();
export function ownedJSON(value: object | undefined): string | undefined {
  if (value === undefined) return undefined;
  let text = cache.get(value);
  if (text === undefined) cache.set(value, (text = JSON.stringify(value)));
  return text;
}
