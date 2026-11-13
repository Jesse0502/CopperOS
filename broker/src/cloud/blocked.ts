// Addresses refused at every public entry (the socket, suggestions, MCP), from BLOCKED_IPS:
// exact IPs, comma-separated. Set from infra/private.json at deploy.

const blocked = new Set(
  (process.env.BLOCKED_IPS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

export const isBlocked = (ip: string | undefined | null): boolean => Boolean(ip && blocked.has(ip));
