const test = require("node:test");
const assert = require("node:assert/strict");
const fs=require("fs");
const s=fs.readFileSync("server.js","utf8");
test("production server contains required integrations",()=>{
  assert.match(s,/api\.derivws\.com\/trading\/v1\/options\/ws\/public/);
  assert.match(s,/ticks_history/);
  assert.match(s,/api\.trongrid\.io/);
  assert.match(s,/only_confirmed=true/);
  assert.match(s,/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t/);
  assert.match(s,/TA3VbsQJKS5AiMG8gGJaPj8kcfDdBikDao/);
});
