import { getUser } from "./users.js";
export const greet = (id) => { const u = getUser(id); return u ? `hello ${u}` : "hello stranger"; };
