import { existsSync } from "node:fs";
import { openStore } from "./store";

// This is an operator command on the host. It exposes no network admin API,
// accepts no raw token, and prints no enrolling IP, hash, key or course data.
const [action, id] = process.argv.slice(2);
if (
  !["list", "revoke", "revoke-all"].includes(action ?? "") ||
  (action === "revoke" && !id)
) {
  throw new Error("Usage: admin.ts list | revoke <device-id> | revoke-all");
}
const dbPath = process.env.GATEWAY_DB_PATH ?? "./.data/gateway.sqlite";
if (!existsSync(dbPath)) throw new Error("Gateway database does not exist.");
const store = openStore(dbPath);
try {
  if (action === "list") console.log(JSON.stringify(store.listDevices()));
  else if (action === "revoke")
    console.log(JSON.stringify({ revoked: store.revokeDevice(id!) }));
  else console.log(JSON.stringify({ revoked: store.revokeAllDevices() }));
} finally {
  store.close();
}
