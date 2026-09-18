export function tokenAge(linkedAt: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(linkedAt));
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return ago(Math.floor(elapsed / 60_000), "minute");
  if (elapsed < 86_400_000) return ago(Math.floor(elapsed / 3_600_000), "hour");
  return ago(Math.floor(elapsed / 86_400_000), "day");
}

function ago(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? "" : "s"} ago`;
}
