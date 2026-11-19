import { getUsr } from "./users.js";
export const greet = (id) => { const u = getUsr(id); return u ? `hello ${u}` : "hello stranger"; };
