const USERS = { 1: "ada", 2: "grace" };
export function getUser(id) { return USERS[id] ?? null; }
