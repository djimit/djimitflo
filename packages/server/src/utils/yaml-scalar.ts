export function yamlScalar(value: unknown): string {
  return JSON.stringify(String(value ?? ''));
}
