export function validateToken(bearerToken: string | undefined): boolean {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) {
    throw new Error("MCP_AUTH_TOKEN not configured");
  }
  return bearerToken === expected;
}
