import { rcedit } from "rcedit";
import * as path from "path";

const exe = path.join(import.meta.dir, "..", "vu-watchdog.exe");
const ico = path.join(import.meta.dir, "..", "logo.ico");

await rcedit(exe, { icon: ico });
console.log("[build] Icon set on vu-watchdog.exe");
